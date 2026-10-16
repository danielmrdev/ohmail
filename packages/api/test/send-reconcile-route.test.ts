import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, SEND_RECONCILE_CRON_PATH, type ApiDeps } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { drafts, mailboxes, outboundSends } from "@trafficflow/db";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDeps, req } from "./helpers.js";

/**
 * `GET /internal/sends/reconcile/run` — THE HOSTED MOUNT of the stranded-reservation pass.
 *
 * What is pinned HERE is the ROUTE's contract, not the pass's policy (that is
 * `packages/services/test/send-reconcile.test.ts`): the shared-secret gate, and — the reason this
 * file exists at all — that the ADMISSION WRAPPER this route puts around its adapter factory
 * refuses in a way the pass DEFERS on.
 *
 * ── WHY THAT LAST ONE NEEDS A ROUTE-LEVEL TEST ──────────────────────────────────────────────
 *
 * Every test in the services suite injects an adapter factory directly, so the admission wrapper
 * is not on the path there at all — which is exactly how the defect this file guards got written
 * and shipped past eleven mutations. The wrapper refused with a `ServiceError`; `resolveStale`
 * reads any `ServiceError` from a factory as "this mailbox can never be dialled again" and writes
 * a TERMINAL `unverified`. So a reservation on a mailbox that was merely BUSY — the cap is two,
 * and the attachment path holds the same slots — was closed as unconfirmed WITHOUT THE SENT
 * FOLDER EVER BEING READ, and terminal means no later cycle would read it. The person is told to
 * go and check for a message that is most likely sitting in their Sent folder.
 *
 * The fix is a distinct `TransientDialRefusal`, and a TYPE is not enough to hold it: reverting the
 * route to `new ServiceError(...)` compiles the moment somebody re-adds the import. This test is
 * the behavioural half — it drives the real route with a refusing counter and reads the counters.
 */

const app = createApp(apiRoutes);
const H = (r: Request, deps: ApiDeps) => app.handle(r, deps);
const SECRET = "send-reconcile-route-test-secret-abcdefghij-fixture-token";
const MIN = 60_000;

/** A stranded reservation: `pending`, eleven minutes old, its draft still at `sending`. */
async function stranded(deps: ApiDeps, db: Awaited<ReturnType<typeof makeDeps>>["db"]) {
  const accountId = randomUUID();
  const at = new Date(deps.now().getTime() - 11 * MIN);
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `busy-${randomUUID().slice(0, 8)}@rec.test`,
    status: "connected",
  }).returning();
  const [d] = await db.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the stranded one", body: "words",
    to: [{ name: null, address: "you@example.com" }],
    status: "sending", createdAt: at, updatedAt: at,
  }).returning();
  const [s] = await db.insert(outboundSends).values({
    accountId, idempotencyKey: randomUUID(), draftId: d!.id,
    mintedMessageId: `<${randomUUID()}@rec.test>`, status: "pending", createdAt: at,
  }).returning();
  return { accountId, mailboxId: mb!.id, draftId: d!.id, sendId: s!.id };
}

async function armed() {
  const { db, deps } = await makeDeps();
  deps.alerts = { secret: SECRET, cronSecret: "vercel-cron-secret-abcdefghijabc-fixture-token" };
  // The route must build its OWN admission-wrapped factory, so this stays unset.
  deps.services!.sendAdapter = undefined;
  return { db, deps };
}

describe("mounting and the gate", () => {
  it("is on apiRoutes and NOT on localRoutes", () => {
    const key = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;
    expect(apiRoutes.map(key)).toContain(`GET ${SEND_RECONCILE_CRON_PATH}`);
    // A standalone install runs the pass on its own clock, in-process. Mounting a
    // shared-secret door into somebody's own machine buys nothing and costs a surface.
    expect(localRoutes.map(key)).not.toContain(`GET ${SEND_RECONCILE_CRON_PATH}`);
  });

  it("no armed internal surface ⇒ 404, wrong secret ⇒ 401, either real secret ⇒ 200", async () => {
    const { deps } = await armed();
    const dark = { ...deps, alerts: undefined };
    expect((await H(req("GET", SEND_RECONCILE_CRON_PATH), dark)).status).toBe(404);
    expect((await H(req("GET", SEND_RECONCILE_CRON_PATH, { bearer: "wrong" }), deps)).status).toBe(401);
    expect((await H(req("GET", SEND_RECONCILE_CRON_PATH, { bearer: SECRET }), deps)).status).toBe(200);
    expect((await H(
      req("GET", SEND_RECONCILE_CRON_PATH, { bearer: "vercel-cron-secret-abcdefghijabc-fixture-token" }), deps,
    )).status).toBe(200);
  });
});

describe("the abandonment seam reaches production, not just the spies", () => {
  /**
   * A SOURCE CENSUS, and the reason is that `makeSendAdapter` CONNECTS eagerly (`adapter.connect()`)
   * — so the only way to build one is against a live IMAP server, which is not reachable in every
   * environment this suite runs in. The property still has to be checked somewhere, because it
   * failed exactly the way an unchecked property does.
   *
   * WHAT WENT WRONG: `SendAdapter.forceClose` was added to the seam, forwarded by the reconciler's
   * own wrapper, and exercised by a spy that defined it — while `makeSendAdapter` returns a
   * hand-written object literal that did NOT name it. So in production `abandon()` always took the
   * polite-`close()` fallback: the LOGOUT queued behind the hung command, waited out the very hang
   * it was escaping, and the admission slot stayed held. Every test passed. The seam was decorative
   * for its whole life, and only a check that looks at the PRODUCTION factory could have said so.
   */
  it("makeSendAdapter forwards forceClose — the reconciler's abandonment depends on it", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "send-adapter.ts"), "utf8",
    );
    // Matched on the PROPERTY, not on a formatting of it: an exact-body regex turns red when
    // somebody adds a log line and stays green when a correct-looking `forceClose` is added to a
    // second, unreachable literal. What has to be true is that the returned object names it and
    // that it reaches the adapter's own.
    const body = src.slice(src.indexOf("return {", src.indexOf("export async function makeSendAdapter")));
    const decl = /forceClose\s*:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(body);
    expect(decl, "the returned object must name forceClose, or the seam is decorative")
      .not.toBeNull();
    const after = body.slice(decl!.index, decl!.index + 200);
    expect(after, "…and it must reach the ADAPTER's, not be a no-op that satisfies the shape")
      .toContain("adapter.forceClose(");
  });

  it("the reconciler's own deadlines are threaded into the adapter, not raced outside it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "routes", "internal.ts"), "utf8")
      // BOTH production callers, not just this one. The self-hosted server runs the same pass and
      // was missed when these deadlines were introduced, leaving it with no dial bound at all —
      // and a census that looked only at the hosted route could not see it.
      + readFileSync(join(here, "..", "..", "..", "apps", "server", "src", "index.ts"), "utf8");
    // Racing a dial does not stop it — imapflow serialises commands — so the bound has to reach
    // the connection itself. If this call stops passing them, a breach stops meaning "the mailbox
    // did not answer" and the pass's give-up starts acting on our impatience instead.
    // NOT `toContain`, which passes on a commented-out line — precisely the regression this is
    // written against. The constant has to appear on a line that is code.
    const live = src.split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(live.match(/timeouts:\s*SEND_RECONCILE_NET_TIMEOUTS/g) ?? [],
      "every production caller of the pass must thread them",
    ).toHaveLength(2);
  });
});

describe("the admission wrapper's refusal is a DEFER, never a terminal answer", () => {
  it("a mailbox at its connection ceiling leaves the reservation exactly as it found it", async () => {
    const { db, deps } = await armed();
    const w = await stranded(deps, db);
    let asked = 0;
    // The counter REFUSES — the state a second attachment download on this mailbox produces.
    deps.services!.imapAdmission = {
      acquire: async () => { asked += 1; return false; },
      release: async () => { /* nothing was taken */ },
    };

    const res = await H(req("GET", SEND_RECONCILE_CRON_PATH, { bearer: SECRET }), deps);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, number>;

    expect(asked, "the pass did go through admission").toBeGreaterThan(0);
    expect(body.claimed).toBe(1);
    expect(body.deferred, "a busy mailbox waits for a slot").toBe(1);
    expect(
      body.unverified,
      "A BUSY MAILBOX WAS CLOSED AS UNCONFIRMED — the Sent folder was never read",
    ).toBe(0);

    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.id, w.sendId));
    expect(row!.status, "and the reservation is untouched, so the next cycle asks again")
      .toBe("pending");
    const [d] = await db.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status).toBe("sending");
  });

  it("an UNCONFIGURED admission port defers every row instead of closing them all", async () => {
    // `imapAdmission()` throws `ServiceError("internal", 500)` when the host supplies no port, and
    // `resolveStale` reads any factory `ServiceError` as "this mailbox can never be dialled
    // again" and writes terminal `unverified`. So a deployment that armed the alert secret and no
    // admission port would have closed EVERY stranded reservation as unconfirmed, three a minute,
    // with no Sent-folder search anywhere — a configuration mistake spending other people's mail.
    // Nothing here fails OPEN: a refusal still never dials.
    const { db, deps } = await armed();
    const w = await stranded(deps, db);
    deps.services!.imapAdmission = undefined;

    const res = await H(req("GET", SEND_RECONCILE_CRON_PATH, { bearer: SECRET }), deps);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, number>;

    expect(body.claimed).toBe(1);
    expect(body.deferred).toBe(1);
    expect(body.unverified, "a missing counter closed a reservation as unconfirmed").toBe(0);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.id, w.sendId));
    expect(row!.status).toBe("pending");
  });

  it("gives the slot back when the dial itself fails, so a fault cannot leak the budget", async () => {
    const { db, deps } = await armed();
    await stranded(deps, db);
    let taken = 0;
    let given = 0;
    deps.services!.imapAdmission = {
      acquire: async () => { taken += 1; return true; },
      release: async () => { given += 1; },
    };
    // Admitted, then the credential read fails — the mailbox has no `mailbox_credentials` rows,
    // which is `makeSendAdapter`'s own refusal.
    const res = await H(req("GET", SEND_RECONCILE_CRON_PATH, { bearer: SECRET }), deps);

    expect(res.status).toBe(200);
    expect(taken).toBe(1);
    expect(given, "a slot taken and not returned is a mailbox that quietly stops being dialable")
      .toBe(1);
  });
});
