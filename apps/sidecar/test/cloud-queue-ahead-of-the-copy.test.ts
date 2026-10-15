import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, queueAheadOfTheCopy, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE QUEUE, READ WHILE THIS MIRROR BOOTSTRAPS, OVER THE REAL CLOUD ENGINE. The account's queue
 * relays live, ahead of a copy still replaying the account: the answer says `copyBehind`, it comes
 * back without waiting for anything, and it owes the mirror one rules pass from where the last one
 * ended. Once the copy has taken in the account the answer is relayed unchanged.
 */

const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ring = (): Record<number, Buffer> => ({ 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) });
const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const QUEUE = {
  items: [{ id: "m1", sender: { name: null, address: "new@stranger.test" }, receivedAt: "2026-10-01T09:00:00.000Z", subject: "s", snippet: "s" }],
  nextCursor: null, total: 1,
};

function account() {
  const asked: string[] = [];
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const atGate = new Promise<void>((r) => { reached = r; });
  let replay = 0;
  const send = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const empty = (cursor: string, hasMore: boolean) => ({
    changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor, hasMore, serverTime: new Date().toISOString(),
  });
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
    if (url.pathname === "/sync/snapshot") return send({ asOfSeq: 1, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });
    if (url.pathname === "/sync" && url.searchParams.get("types") === "rule") {
      return send(empty(url.searchParams.get("since") === "0" ? "r1" : "r2", false));
    }
    if (url.pathname === "/sync") {
      replay += 1;
      if (replay === 2) { reached(); await opened; }
      return send(empty(Buffer.from(String(replay)).toString("base64url"), replay < 3));
    }
    if (url.pathname === "/screener") return send(QUEUE);
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const rulesSince = () => asked.filter((p) => p.startsWith("/sync?") && new URLSearchParams(p.split("?")[1]).get("types") === "rule")
    .map((p) => new URLSearchParams(p.split("?")[1]).get("since"));
  return { fetchImpl, open, atGate, rulesSince };
}

async function boot(fetchImpl: typeof fetch): Promise<{ sidecar: CloudSidecar; started: Promise<void> }> {
  const dataDir = await freshDataDir("ohmail-queue-ahead-");
  dirs.push(dataDir);
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
    tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
    keks: ring(), fetchImpl, pollIntervalMs: 60_000,
  });
  sidecars.push(sidecar);
  return { sidecar, started: sidecar.start() };
}

const askQueue = (sidecar: CloudSidecar) =>
  sidecar.handle(new Request("http://sidecar/screener?limit=200", { headers: { authorization: `Bearer ${sidecar.sessionToken}` } }));

describe("the queue answer while the mirror bootstraps", () => {
  it("says the copy is behind, answers at once, and owes one rules pass", { timeout: 40_000 }, async () => {
    const a = account();
    const { sidecar, started } = await boot(a.fetchImpl);
    await a.atGate;
    const res = await askQueue(sidecar);
    expect(res.status).toBe(200);
    const body = await res.json() as { copyBehind?: unknown; items: unknown[]; total: number };
    expect(body.copyBehind, "the answer did not say the copy is behind").toBe(true);
    expect([body.items.length, body.total], "the queue itself was changed").toEqual([1, 1]);
    expect((await askQueue(sidecar)).status, "a second answer inside the gap was refused").toBe(200);
    a.open();
    await started;
    expect(a.rulesSince(), "the answers owed no pass, or more than one").toEqual(["0", "r1"]);
  });

  it("is relayed unchanged once the copy has taken in the account", { timeout: 40_000 }, async () => {
    const a = account();
    a.open();
    const { sidecar, started } = await boot(a.fetchImpl);
    await started;
    const body = await (await askQueue(sidecar)).json() as Record<string, unknown>;
    expect("copyBehind" in body, "a settled copy still said it is behind").toBe(false);
    expect(a.rulesSince()).toEqual(["0"]);
  });
});

describe("queueAheadOfTheCopy", () => {
  it("leaves a body that is not a queue page alone and owes nothing", async () => {
    let asked = 0;
    const mirror = { askRulesRefresh: () => { asked += 1; return true; } };
    for (const raw of ["not json", JSON.stringify({ error: { code: "x" } }), "null"]) {
      const out = await queueAheadOfTheCopy(new Response(raw, { status: 200 }), mirror);
      expect(await out.text()).toBe(raw);
    }
    expect(asked).toBe(0);
  });
});
