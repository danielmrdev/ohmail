import { describe, it, expect } from "vitest";
import { createApp, type ApiDeps } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { mailboxOauthDeviceCeremonies } from "@trafficflow/db/cloud";
import type { FetchLike } from "@trafficflow/core";
import { eq } from "drizzle-orm";
import { deleteAccount, type ServiceContext } from "@trafficflow/services";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE DEVICE CEREMONY, AGAINST AN ERASURE THAT LANDS WHILE MICROSOFT IS ANSWERING
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The reported shape: `POST /mailboxes/oauth/microsoft/device/start` mints a grant and then INSERTS
 * a ceremony row referencing the retained `accounts` row with no fence — so an in-flight provider
 * response can recreate SEALED CEREMONY STATE after erasure. That row is a live path back into a
 * mailbox, on an account whose owner has been told everything is gone.
 *
 * The window is the provider request itself, which is the honest one: the session is valid when
 * the request starts, `requestDeviceCode` goes to Microsoft, and the insert happens afterwards.
 * The sweep runs inside the fake IdP's answer — the same seam the real defect uses, not a seam
 * the fix introduced.
 *
 * ── WHAT THIS FILE CAN AND CANNOT DECIDE ────────────────────────────────────────────────────
 *
 * This is the ORDERED arm: the sweep COMMITS, and the route's fence then reads a settled
 * `erased_at`. That is decidable on the PGlite harness the device door's own suite uses, and
 * driving the real ROUTE is what makes the refusal real — a fence proved against a direct call to
 * the writer says nothing about the pipeline the door runs.
 *
 * The CONCURRENT arm — the route's transaction already open and past its fence when the sweep
 * arrives — is NOT decidable here: PGlite is one connection, so the two transactions are
 * serialised before either reaches a lock and a fence that took no lock would pass. That half is
 * `packages/services/test/erasure-fence-race.pg.test.ts`'s CONCURRENT case, which proves
 * `withAccountTx`'s `FOR SHARE` interlock on real Postgres for every door that goes through it —
 * and after this lane the device ceremony is one of them. Said here rather than left implied,
 * because a file that cannot say what it did not cover has covered nothing.
 *
 * MUTATION WATCHED RED, THEN RESTORED (pristine copy, `cmp`): `withAccountTx` removed from the
 * start handler, leaving the bare `createDeviceCeremony(deps.db, …)` → ERASED red on the ceremony
 * row, and on the 201 the door had no business returning.
 */

const DEVICE_CODE = "DEVICE-CODE-SECRET-1";
const USER_CODE = "ABCD-EFGH";
const VERIFICATION_URI = "https://microsoft.com/devicelogin";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

const app = createApp(selfHostRoutes);

/**
 * The device-code endpoint, with a hook that runs while Microsoft is "answering". `onAnswer` is
 * awaited BEFORE the body comes back, so whatever it does has committed by the time the route
 * resumes — which is the state the defect needs.
 */
function idpFetch(onAnswer?: () => Promise<void>): FetchLike {
  return (async (url: string) => {
    expect(url).toMatch(/\/devicecode$/);
    if (onAnswer) await onAnswer();
    return {
      ok: true, status: 200,
      json: async () => ({
        device_code: DEVICE_CODE, user_code: USER_CODE,
        verification_uri: VERIFICATION_URI, expires_in: 900, interval: 5,
      }),
      text: async () => "",
    };
  }) as unknown as FetchLike;
}

async function world(onAnswer?: () => Promise<void>) {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const base: ApiDeps = {
    ...deps,
    appOrigin: "https://mail.example.invalid",
    oauthFetch: idpFetch(onAnswer),
    msDevice: { clientId: CLIENT_ID, tenant: "common" },
  };
  const ctx = {
    db: db as unknown as ServiceContext["db"],
    accountId: s.accountId,
    userId: null,
    now: () => FIXED_NOW,
    requestId: "device-fence",
  } as ServiceContext;
  return {
    db, accountId: s.accountId, ctx,
    start: () => app.handle(
      req("POST", "/mailboxes/oauth/microsoft/device/start", { bearer: s.token, body: "{}" }),
      { ...base, session: null, idempotency: null },
    ),
  };
}

const ceremonies = async (w: Awaited<ReturnType<typeof world>>) =>
  w.db.select().from(mailboxOauthDeviceCeremonies)
    .where(eq(mailboxOauthDeviceCeremonies.accountId, w.accountId));

describe("the device ceremony and the erasure fence", () => {
  it("ERASED — the sweep lands while the provider answers: no ceremony state is written", async () => {
    let w!: Awaited<ReturnType<typeof world>>;
    let swept = false;
    w = await world(async () => {
      if (swept) return;
      swept = true;
      await deleteAccount(w.ctx);
    });

    const res = await w.start();

    expect(swept, "the provider was never called — the window did not exist").toBe(true);
    // THE ROW FIRST — recreating it is what the defect DOES, so that is what the red should name.
    expect(await ceremonies(w), "sealed ceremony state was recreated after erasure").toHaveLength(0);
    // Then the answer: 410, the standing spelling every fenced HTTP writer gives. Asserted by CODE
    // and not merely "not 201" — a 404 or a foreign-key 500 would also fail `toBe(201)` and would
    // mean something else entirely.
    expect(res.status, await res.clone().text()).toBe(410);
  });

  it("THE POSITIVE CONTROL — an ordinary start still mints a ceremony", async () => {
    // Without this, a door that refused unconditionally would pass the case above.
    const w = await world();

    const res = await w.start();

    expect(res.status, await res.clone().text()).toBe(201);
    const rows = await ceremonies(w);
    expect(rows, "the fence refused a live account").toHaveLength(1);
    expect(rows[0]!.consumedAt).toBeNull();
    // The credential is still sealed — the fence's transaction did not change what the row holds.
    expect(rows[0]!.deviceCodeEnc).not.toContain(DEVICE_CODE);
  });
});
