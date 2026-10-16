import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { hashToken } from "@trafficflow/services/mail";
import { createCloudSidecar, type CloudSidecar } from "../../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "../fixtures/hosted-mailbox.js";
import { freshDataDir } from "../_datadir.js";

/**
 * THE ONE-CONFIRM SIGN-IN through the engine's own routes: `POST /cloud/signin/approval` asks with
 * this machine's hostname and hands the window only the id; `{approval: true}` on `/cloud/signin`
 * polls with the verifier held in memory (a body's verifier is ignored), and an approved claim
 * signs in through the same tail as the code path. A refusal ends the request; a self-hosted door
 * refuses the whole ceremony and dials nothing. The wire half is `../cloud-approval.test.ts`.
 */

const ID = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";
const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
type Call = { path: string; body: Record<string, unknown> };

describe("the engine: POST /cloud/signin/approval, then {approval: true} on /cloud/signin", () => {
  const sidecars: CloudSidecar[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function engine(fetchImpl: typeof fetch, cloudUrl = "https://cloud.test"): Promise<CloudSidecar> {
    const dataDir = await freshDataDir("ohmail-cloud-approval-");
    dirs.push(dataDir);
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl, handoffBase: "https://cloud.test", address: "me@ohmail.test",
      keks: { 1: Buffer.alloc(32, 7) }, fetchImpl, pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    return sidecar;
  }
  const call = (s: CloudSidecar, path: string, body: unknown): Promise<Response> =>
    s.handle(new Request(`http://sidecar${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

  it("requests with this machine's hostname, polls with the held verifier, and signs in on approval", async () => {
    const seen: Call[] = [];
    let claims = 0;
    const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url.pathname.startsWith("/auth/desktop-approval")) seen.push({ path: url.pathname, body });
      if (url.pathname === "/auth/desktop-approval") return json({ approvalId: ID, expiresIn: 300 });
      if (url.pathname === "/auth/desktop-approval/claim") {
        claims += 1;
        return claims === 1
          ? json({ status: "pending", retryAfterMs: 2000 }, 202)
          : json({ tokens: { accessToken: "approved-access", refreshToken: "approved-refresh" } });
      }
      if (url.pathname === "/auth/session") return json({ user: { email: "me@ohmail.test" }, scope: "full" });
      if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
      if (url.pathname === "/sync") return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: new Date().toISOString() });
      if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const s = await engine(fetchImpl);

    const started = await call(s, "/cloud/signin/approval", {});
    expect(started.status, await started.clone().text()).toBe(200);
    expect(await started.json()).toEqual({ approvalId: ID, expiresIn: 300 });
    const asked = seen[0]!;
    expect(asked.body.label).toBe(hostname());
    const challenge = asked.body.challenge as string;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const pending = await call(s, "/cloud/signin", { approval: true, verifier: "attacker-supplied" });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending", retryAfterMs: 2000 });
    expect(s.signedIn()).toBe(false);

    const done = await call(s, "/cloud/signin", { approval: true });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(s.signedIn()).toBe(true);
    const claimBody = seen[1]!.body;
    // The verifier the claim carried is the pre-image of the challenge published — never the body's.
    expect(claimBody.verifier).not.toBe("attacker-supplied");
    expect(hashToken(claimBody.verifier as string)).toBe(challenge);
    expect(claimBody.approvalId).toBe(ID);
  }, 30_000);

  it("a refusal ends the request: the next poll has nothing to claim", async () => {
    const fetchImpl = (async (input: string): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname === "/auth/desktop-approval") return json({ approvalId: ID, expiresIn: 300 });
      if (url.pathname === "/auth/desktop-approval/claim") return json({ error: { code: "approval_denied" } }, 410);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const s = await engine(fetchImpl);
    expect((await call(s, "/cloud/signin/approval", {})).status).toBe(200);
    const denied = await call(s, "/cloud/signin", { approval: true });
    expect(denied.status).toBe(410);
    expect(((await denied.json()) as { error: { code: string; message: string } }).error)
      .toEqual({ code: "approval_denied", message: "This request was declined in the browser." });
    const after = await call(s, "/cloud/signin", { approval: true });
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe("approval_expired");
  }, 30_000);

  it("refuses the approval on a server the person runs, and dials nothing", async () => {
    const dialled: string[] = [];
    const fetchImpl = (async (input: string): Promise<Response> => {
      dialled.push(new URL(input).pathname);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const s = await engine(fetchImpl, "https://ohmail.example.com/api");
    const res = await call(s, "/cloud/signin/approval", {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("handoff_not_available");
    expect(dialled.filter((p) => p.startsWith("/auth/desktop-approval"))).toEqual([]);
  }, 30_000);
});
