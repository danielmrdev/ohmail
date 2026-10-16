import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { createSessionWatch, heldReadingOf, sameReading, SESSION_WAIT_HOLD_MS } from "../src/session-watch.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE WINDOW'S HELD QUESTION, `GET /cloud/session/wait`: answered the moment the session reading
 * moves, so a coded refusal reaches the window in one round trip rather than on its minute's
 * `/health` probe. Unit arms over the watch, then the real engine meeting a refusal while a
 * question is held; a quit answers every held question rather than waiting out the hold.
 */

const live = { state: "live" as const, code: null, since: "2026-09-23T21:00:00.000Z" };

/* The watch's hold on a FAKE clock: it holds nothing but its own timer, so a case moves the clock
   exactly and every elapsed reading below is virtual. A real turn lets a promise settle. */
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("the session watch", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("reads the held reading back as the window sent it, `none` as no session", () => {
    expect(heldReadingOf(new URLSearchParams("state=none"))).toEqual({ state: null, code: null, since: null });
    expect(heldReadingOf(new URLSearchParams("state=live&code=&since=2026-09-23T21:00:00.000Z")))
      .toEqual({ state: "live", code: null, since: "2026-09-23T21:00:00.000Z" });
    expect(sameReading(live, { state: "live", code: null, since: live.since })).toBe(true);
    // Every field decides: a new `since` under the same state is a move the window has not seen.
    expect(sameReading(live, { state: "live", code: null, since: "2026-09-23T21:00:01.000Z" })).toBe(false);
    expect(sameReading({ ...live, state: "refused", code: "refresh_revoked" }, { state: "live", code: null, since: live.since })).toBe(false);
    expect(sameReading(null, { state: null, code: null, since: null })).toBe(true);
    expect(sameReading(null, { state: "live", code: null, since: live.since })).toBe(false);
  });

  it("answers at once when the reading already differs, and holds while it is the same", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const watch = createSessionWatch();
    const t0 = Date.now();
    await watch.wait(() => false, 5_000);
    expect(Date.now() - t0, "a differing reading is answered without a hold").toBeLessThan(200);

    let settled = false;
    const held = watch.wait(() => true, 5_000).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    await turn();
    expect(settled, "the same reading is held").toBe(false);
    expect(watch.held()).toBe(1);
    watch.moved();
    await held;
    expect(watch.held(), "an answered question is no longer held").toBe(0);
  });

  it("answers at the hold bound unchanged, and the engine's bound is under the bridge's minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const watch = createSessionWatch();
    const t0 = Date.now();
    let settled = false;
    const held = watch.wait(() => true, 120).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(119);
    expect(settled, "the hold answered before its bound").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await held;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(SESSION_WAIT_HOLD_MS).toBeLessThan(60_000);
  });

  it("release answers every held question and holds no later one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const watch = createSessionWatch();
    const a = watch.wait(() => true, 30_000);
    const b = watch.wait(() => true, 30_000);
    expect(watch.held()).toBe(2);
    const t0 = Date.now();
    watch.release();
    await Promise.all([a, b]);
    await watch.wait(() => true, 30_000);
    expect(Date.now() - t0, "a released watch answers without a hold").toBeLessThan(200);
  });
});

const MAILBOX = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ring = (): Record<number, Buffer> => ({ 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) });
const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A hosted API whose refresh door refuses with `refresh_revoked` once the access token is stale.
 * `pulls` counts the engine's `/sync` asks: the engine arms below are measured in its own pulls,
 * never in wall time, so a loaded machine cannot stretch them into a red.
 */
function hosted(): { fetchImpl: typeof fetch; expire(): void; pulls(): number } {
  let expired = false;
  let pulls = 0;
  const send = (v: unknown, status = 200): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/sync") pulls += 1;
    if (url.pathname === "/auth/refresh") return send({ error: { code: "refresh_revoked" } }, 401);
    if (expired) return send({ error: { code: "unauthorized" } }, 401);
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
    if (url.pathname === "/sync") return send({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: Buffer.from("1").toString("base64url"), hasMore: false, serverTime: new Date().toISOString(),
    });
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, expire: () => { expired = true; }, pulls: () => pulls };
}

type Reading = { state: string; code: string | null; since: string } | null;

/** Real turns until `ready` — the engine's own pulls are what move it. */
const until = async (ready: () => boolean): Promise<void> => {
  while (!ready()) await new Promise((r) => setTimeout(r, 5));
};

async function boot(h: ReturnType<typeof hosted>): Promise<CloudSidecar> {
  const dataDir = await freshDataDir("ohmail-session-wait-");
  dirs.push(dataDir);
  const sidecar = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://cloud.test",
    address: "me@ohmail.test",
    tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
    keks: ring(),
    fetchImpl: h.fetchImpl,
    pollIntervalMs: 40,
  });
  sidecars.push(sidecar);
  await sidecar.start();
  return sidecar;
}

const reading = async (s: CloudSidecar): Promise<Reading> =>
  ((await (await s.handle(new Request("http://sidecar/health"))).json()) as { session: Reading }).session;

function ask(s: CloudSidecar, held: Reading, bearer = true): Promise<Response> {
  const q = held === null ? "state=none" : `state=${held.state}&code=${held.code ?? ""}&since=${encodeURIComponent(held.since)}`;
  const headers = bearer ? { authorization: `Bearer ${s.sessionToken}` } : undefined;
  return s.handle(new Request(`http://sidecar/cloud/session/wait?${q}`, { headers }));
}

describe("the engine's held question", () => {
  it("a coded refusal answers the held question at once, naming the refusal", { timeout: 30_000 }, async () => {
    const h = hosted();
    const sidecar = await boot(h);
    const held = await reading(sidecar);
    expect(held?.state).toBe("live");

    let answeredAt = -1;
    const answer = ask(sidecar, held).then(async (res) => {
      answeredAt = h.pulls();
      return { status: res.status, body: (await res.json()) as { changed: boolean; session: Reading } };
    });
    const asked = h.pulls();
    await until(() => h.pulls() >= asked + 2);
    expect(answeredAt, "an unchanged reading is held, not answered").toBe(-1);

    const expiredAt = h.pulls();
    h.expire();
    const got = await answer;
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ changed: true, session: { state: "refused", code: "refresh_revoked" } });
    expect(answeredAt - expiredAt, "the refusal is answered on the engine's next pull, not at the hold bound")
      .toBeLessThanOrEqual(2);
    expect(((await (await sidecar.handle(new Request("http://sidecar/health"))).json()) as { sessionExpired: boolean })
      .sessionExpired).toBe(true);
  });

  it("a stale reading is answered at once; a quit answers a held one; the bearer is required", { timeout: 30_000 }, async () => {
    const h = hosted();
    const sidecar = await boot(h);
    const now = await reading(sidecar);
    const stale = await ask(sidecar, null);
    expect(await stale.json()).toMatchObject({ changed: true, session: { state: "live" } });

    expect((await ask(sidecar, now, false)).status, "behind the launch bearer like every route but /health").toBe(401);

    let answeredAt = -1;
    const held = ask(sidecar, now).then((r) => { answeredAt = h.pulls(); return r; });
    const asked = h.pulls();
    await until(() => h.pulls() >= asked + 2);
    expect(answeredAt, "an unchanged reading is held across the engine's pulls").toBe(-1);
    const releasedAt = h.pulls();
    sidecar.releaseHeld();
    const res = await held;
    expect(await res.json()).toMatchObject({ changed: false, session: { state: "live" } });
    expect(answeredAt - releasedAt, "released, never waited out").toBeLessThanOrEqual(1);
  });
});
