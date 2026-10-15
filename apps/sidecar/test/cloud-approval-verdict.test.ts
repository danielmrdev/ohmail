import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { freshDataDir } from "./_datadir.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE BROWSER APPROVAL'S WAIT IS THE ENGINE'S, AND `/health` SAYS IT (FIRST-CLOUD-DOOR-HEALTH-SAYS-
 * NOTHING-OF-THE-WAIT). The engine held the request id and the verifier and said nothing, so a
 * reopened window had nothing to resume and a support read could not see a pending, declined or
 * expired request. States and codes only: the health body never carries the id or the verifier.
 * Mutations watched red: the stop route made a no-op; the expiry not read at `/health`.
 */

const ID = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

interface Rig {
  s: CloudSidecar; verifiers: string[]; events: Array<{ event: string; detail: Record<string, unknown> }>; at: { now: number };
  /** Hold the next hosted call to `path` (the claim by default) until `release`. */
  holdClaim: (path?: string) => { seen: Promise<void>; release: () => void };
}

describe("the approval verdict on /health", () => {
  const sidecars: CloudSidecar[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A hosted fake whose claims answer `claims` in order; the last repeats. */
  async function rig(claims: Array<() => Response>): Promise<Rig> {
    const verifiers: string[] = [];
    const events: Rig["events"] = [];
    const at = { now: Date.parse("2026-09-29T02:00:00.000Z") };
    let n = 0;
    let held: { path: string; seen: () => void; wait: Promise<void> } | null = null;
    const holdClaim = (path = "/auth/desktop-approval/claim"): { seen: Promise<void>; release: () => void } => {
      let seen!: () => void; let release!: () => void;
      const seenP = new Promise<void>((r) => { seen = r; });
      held = { path, seen, wait: new Promise<void>((r) => { release = r; }) };
      return { seen: seenP, release };
    };
    const tokens = { tokens: { accessToken: "code-access", refreshToken: "code-refresh" } };
    const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      const hold = held?.path === url.pathname ? held : null;
      if (hold) { held = null; hold.seen(); await hold.wait; }
      if (url.pathname === "/auth/desktop-approval") return json({ approvalId: ID, expiresIn: 300 });
      // The code sign-in's hosted half, for the sign-in and sign-out controls.
      if (url.pathname === "/auth/desktop-claim") return json(tokens);
      if (url.pathname === "/auth/session") return json({ user: { email: "me@ohmail.test" }, scope: "full" });
      if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
      if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
      if (url.pathname === "/sync") return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: new Date().toISOString() });
      if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
      if (url.pathname === "/auth/desktop-approval/claim") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { verifier?: string };
        if (body.verifier) verifiers.push(body.verifier);
        const answer = claims[Math.min(n, claims.length - 1)]!;
        n += 1;
        return answer();
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const dataDir = await freshDataDir("ohmail-approval-verdict-");
    dirs.push(dataDir);
    const s = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", handoffBase: "https://cloud.test", address: "me@ohmail.test",
      keks: { 1: Buffer.alloc(32, 7) }, fetchImpl, pollIntervalMs: 3_600_000,
      now: () => new Date(at.now),
      log: (event, detail) => { events.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
    });
    sidecars.push(s);
    return { s, verifiers, events, at, holdClaim };
  }
  const call = (r: Rig, method: string, path: string, body?: unknown): Promise<Response> =>
    r.s.handle(new Request(`http://sidecar${path}`, {
      method,
      headers: { authorization: `Bearer ${r.s.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  const health = async (r: Rig): Promise<{ text: string; approval: unknown }> => {
    const text = await (await r.s.handle(new Request("http://sidecar/health"))).text();
    return { text, approval: (JSON.parse(text) as { approval?: unknown }).approval };
  };
  const pending = (): Response => json({ status: "pending", retryAfterMs: 2000 }, 202);

  it("a pending request is on /health, states only — never the id or the verifier", async () => {
    const r = await rig([pending]);
    const started = await (await call(r, "POST", "/cloud/signin/approval", {})).text();
    expect(started, "POSITIVE CONTROL: the POST body carries the id the health body must not").toContain(ID);
    expect((await call(r, "POST", "/cloud/signin", { approval: true })).status).toBe(202);
    const { text, approval } = await health(r);
    expect(approval, "/health names no approval wait").toEqual({
      state: "pending", note: null, expiresAt: "2026-09-29T02:05:00.000Z",
    });
    expect(r.verifiers, "the rig never saw the verifier, so the next line measures nothing").toHaveLength(1);
    expect(text).not.toContain(ID);
    expect(text).not.toContain(r.verifiers[0]!);
    const approvalLines = r.events.filter((e) => e.event.startsWith("cloud_approval"));
    expect(approvalLines.map((e) => Object.keys(e.detail))).toEqual([["mailboxId"]]);
  });

  it("a refusal ends it with its code, and the request cannot be polled again", async () => {
    const r = await rig([() => json({ error: { code: "approval_denied", message: "declined" } }, 410)]);
    await call(r, "POST", "/cloud/signin/approval", {});
    expect((await call(r, "POST", "/cloud/signin", { approval: true })).status).toBe(410);
    expect((await health(r)).approval).toEqual({ state: "ended", code: "approval_denied", expiresAt: "2026-09-29T02:05:00.000Z" });
    const again = await call(r, "POST", "/cloud/signin", { approval: true });
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("approval_expired");
    expect(r.verifiers, "an ended request was claimed again at the hosted service").toHaveLength(1);
  });

  it("past its expiry the wait READS as ended at /health, with no timer, and its secret is gone", async () => {
    const r = await rig([pending]);
    await call(r, "POST", "/cloud/signin/approval", {});
    r.at.now += 300_000;
    expect((await health(r)).approval).toEqual({ state: "ended", code: "approval_expired", expiresAt: "2026-09-29T02:05:00.000Z" });
    const late = await call(r, "POST", "/cloud/signin", { approval: true });
    expect(late.status).toBe(410);
    expect(r.verifiers, "an expired request was polled at the hosted service").toHaveLength(0);
  });

  it("the stop forgets both halves: /health says nothing and nothing is left to poll", async () => {
    const r = await rig([pending]);
    await call(r, "POST", "/cloud/signin/approval", {});
    const stopped = await call(r, "DELETE", "/cloud/signin/approval");
    expect(stopped.status).toBe(204);
    expect((await health(r)).approval, "a stopped wait is still on /health").toBeNull();
    expect((await call(r, "POST", "/cloud/signin", { approval: true })).status).toBe(410);
    expect(r.verifiers).toHaveLength(0);
  });

  /* A STOP OR A NEW REQUEST THAT LANDS WHILE A POLL IS ON THE WIRE (LOW 1): the
     poll's answer belongs to the request it asked about, and is written only while that request is
     still the one held. Mutation watched red: the pending write not checked against the request. */
  it("a stop that lands while a poll is on the wire stays a stop", async () => {
    const r = await rig([pending]);
    await call(r, "POST", "/cloud/signin/approval", {});
    const hold = r.holdClaim();
    const poll = call(r, "POST", "/cloud/signin", { approval: true });
    await hold.seen;
    expect((await call(r, "DELETE", "/cloud/signin/approval")).status).toBe(204);
    hold.release();
    await poll;
    r.at.now += 300_000;
    expect((await health(r)).approval, "a stopped request came back as expired").toBeNull();
  });

  it("an old poll's refusal does not end the request that replaced it", async () => {
    const r = await rig([() => json({ error: { code: "approval_denied", message: "declined" } }, 410)]);
    await call(r, "POST", "/cloud/signin/approval", {});
    const hold = r.holdClaim();
    const poll = call(r, "POST", "/cloud/signin", { approval: true });
    await hold.seen;
    await call(r, "POST", "/cloud/signin/approval", {});
    hold.release();
    expect((await poll).status).toBe(410);
    expect((await health(r)).approval, "the newer request was ended by the old poll").toEqual({
      state: "pending", note: null, expiresAt: "2026-09-29T02:05:00.000Z",
    });
  });

  /* SIGNED IN OR SIGNED OUT, NOTHING IS LEFT TO RESUME (LOW 2): a Cloud chooser
     mounted after either would poll a request the person left. Mutation watched red: the clear
     removed from `activate`; from `signOut`. */
  it("a code sign-in clears the wait", async () => {
    const r = await rig([pending]);
    await call(r, "POST", "/cloud/signin/approval", {});
    const signedIn = await call(r, "POST", "/cloud/signin", { handoffCode: "ABCD-EFGH" });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    expect((await health(r)).approval, "a signed-in engine still says a browser wait").toBeNull();
  });

  /* The one way a request outlives a sign-in: it was asked for before the sign-in finished and its
     answer came after. Nothing resumes it while mail is on screen; the sign-out clears it. */
  it("a sign-out clears a request answered after the sign-in finished", async () => {
    const r = await rig([pending]);
    const hold = r.holdClaim("/auth/desktop-approval");
    const asking = call(r, "POST", "/cloud/signin/approval", {});
    await hold.seen;
    expect((await call(r, "POST", "/cloud/signin", { handoffCode: "ABCD-EFGH" })).status).toBe(200);
    hold.release();
    await asking;
    expect((await health(r)).approval, "PREMISE: the late request is held over the session").not.toBeNull();
    expect((await call(r, "DELETE", "/cloud/session")).status).toBe(200);
    expect((await health(r)).approval, "a signed-out engine still says a browser wait").toBeNull();
  });

  it("CONTROL: nothing asked is nothing said, and the stop is the launch bearer's alone", async () => {
    const r = await rig([pending]);
    expect((await health(r)).approval).toBeNull();
    const anonymous = await r.s.handle(new Request("http://sidecar/cloud/signin/approval", { method: "DELETE" }));
    expect(anonymous.status).toBe(401);
  });
});
