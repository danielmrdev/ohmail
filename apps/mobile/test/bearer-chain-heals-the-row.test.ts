/**
 * ONE KEYSTORE WRITE THAT FAILS DURING A ROTATION IS CAUGHT UP, NOT FENCED OUT. The manager keeps
 * the minted pair in memory while the row keeps the spent token (an iOS keychain refuses writes
 * while the phone is locked). Every write carries the chain of tokens the manager has held, so its
 * next write is admitted over the row it left behind, and the next rotation's arm writes the head
 * beside the attempt. The door models the server's rule: a spent token is admitted only as a retry
 * of the attempt that spent it, and only while the chain has not moved on under another attempt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileEngineDeps } from "../src/engine/boot";
import type { ConnectOutcome, PairAdmission, PairingEnv } from "../src/net/pairing";
import type { SecureKV } from "../src/state/servers";
import type { SessionDeath } from "../src/net/bearer";
import { sqlWorld } from "./helpers/pair-server";

const ORIGIN = "https://a.example";
const ROUTE = `${ORIGIN}/sync/changes`;
const REUSE = { error: { code: "unauthorized", message: "refresh token reuse detected" } };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Families by prefix (`f1-ref-1` …): a redeem starts one, a rotation extends it. `dropNextAnswer()`
 * makes the next refresh do its half on the server and lose the answer on the way back.
 */
function chainDoor() {
  const chains = new Map<string, string[]>();
  const consumedBy = new Map<string, string>();
  const honoured = new Set<string>();
  const swept = new Set<string>();
  const presented: Array<{ token: string; attempt: string }> = [];
  let families = 0;
  let drop = 0;
  const familyOf = (token: string) => token.split("-ref-")[0]!;
  const start = (): { accessToken: string; refreshToken: string } => {
    families += 1;
    const fam = `f${families}`;
    chains.set(fam, [`${fam}-ref-1`]);
    const accessToken = `${fam}-acc-1`;
    honoured.add(accessToken);
    return { accessToken, refreshToken: `${fam}-ref-1` };
  };
  const mint = (fam: string): Response => {
    const chain = chains.get(fam)!;
    const n = chain.length + 1;
    chain.push(`${fam}-ref-${n}`);
    for (const a of [...honoured]) if (a.startsWith(`${fam}-`)) honoured.delete(a);
    honoured.add(`${fam}-acc-${n}`);
    return json(200, { tokens: { accessToken: `${fam}-acc-${n}`, refreshToken: `${fam}-ref-${n}` } });
  };
  const refresh = (token: string, attempt: string): Response => {
    presented.push({ token, attempt });
    const fam = familyOf(token);
    const chain = chains.get(fam);
    if (chain === undefined || swept.has(fam) || !chain.includes(token)) return json(401, REUSE);
    const head = chain[chain.length - 1]!;
    if (!consumedBy.has(token)) {
      if (token !== head) return json(401, REUSE);
      consumedBy.set(token, attempt);
      return mint(fam);
    }
    if (consumedBy.get(token) === attempt) {
      const movedOn = chain.slice(chain.indexOf(token) + 1).some((t) => consumedBy.has(t) && consumedBy.get(t) !== attempt);
      if (!movedOn) { consumedBy.set(head, attempt); return mint(fam); }
    }
    swept.add(fam);
    for (const a of [...honoured]) if (a.startsWith(`${fam}-`)) honoured.delete(a);
    return json(401, REUSE);
  };
  const fetchImpl = async (url: string, init?: unknown): Promise<Response> => {
    const opts = (init ?? {}) as { body?: string; headers?: Record<string, string> };
    if (url.endsWith("/pair/redeem")) return json(200, { grant: "device-pair", tokens: start() });
    if (url.endsWith("/auth/refresh")) {
      const b = JSON.parse(opts.body ?? "{}") as { refreshToken?: string; attemptId?: string };
      const answer = refresh(b.refreshToken ?? "", b.attemptId ?? "");
      if (drop > 0) { drop -= 1; throw new Error("the answer was lost on the way back"); }
      return answer;
    }
    const auth = (opts.headers?.authorization ?? "").replace(/^Bearer /, "");
    if (!honoured.has(auth)) return new Response(null, { status: 401 });
    if (url.endsWith("/auth/session")) return json(200, { user: { accountId: "acct-1" } });
    return new Response(null, { status: 204 });
  };
  return {
    fetchImpl,
    presented,
    seed: () => start().refreshToken,
    expireAccess: () => honoured.clear(),
    dropNextAnswer: () => { drop += 1; },
    isSwept: (fam: string) => swept.has(fam),
  };
}

/** The device keystore; `failNth(key, n, mode)` makes the n-th `set` of `key` from now fail once. */
function flakyKeystore() {
  const map = new Map<string, string>();
  let rule: { key: string; nth: number; mode: "throw" | "drop" } | null = null;
  let seen = 0;
  const kv: SecureKV = {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      if (rule !== null && k === rule.key && ++seen === rule.nth) {
        const mode = rule.mode; rule = null;
        if (mode === "throw") throw new Error("keystore refused the write");
        return; // resolved without storing
      }
      map.set(k, v);
    },
    remove: async (k) => void map.delete(k),
  };
  return { kv, failNth: (key: string, nth: number, mode: "throw" | "drop") => { rule = { key, nth, mode }; seen = 0; } };
}

/** A fresh process: its own module graph, so its own registry. */
async function launch() {
  vi.resetModules();
  const seam = await import("../src/net/pairing");
  const { ServerProfileStore } = await import("../src/state/servers");
  return { seam, ServerProfileStore };
}
function envOf(profiles: PairingEnv["profiles"], fetchImpl: PairingEnv["fetchImpl"], world: ReturnType<typeof sqlWorld>): PairingEnv {
  const engineDeps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000" };
  return { profiles, engineDeps, fetchImpl };
}
function live(o: ConnectOutcome) {
  if (o.kind !== "connected") throw new Error(`not connected: ${JSON.stringify(o)}`);
  return o.session;
}
const key = (id: string) => `ohmail.servers.v1.${id}`;
const ADMISSION: PairAdmission = { origin: ORIGIN, pin: null, flavor: "selfhost", apiBase: ORIGIN, provisionalPin: false, probed: true };

beforeEach(() => { vi.resetModules(); });

describe("a failed keystore write during a rotation", () => {
  for (const mode of ["throw", "drop"] as const) {
    it(`(${mode}) is caught up by the next write, and the next cold launch stays paired`, async () => {
      // MUTATION WATCHED: the chain narrowed to the head the rotation presented — the next save
      // answers `superseded`, the row stays on the twice-spent token, and the relaunch is swept.
      const door = chainDoor();
      const ks = flakyKeystore();
      const world = sqlWorld();
      const one = await launch();
      const profiles = new one.ServerProfileStore(ks.kv);
      const env = envOf(profiles, door.fetchImpl, world);
      const first = door.seed();
      const id = (await profiles.add({ origin: ORIGIN, flavor: "selfhost", accountId: "acct-1", refreshToken: first, apiBase: ORIGIN })).id;
      const saves = vi.spyOn(profiles, "saveRefreshToken");
      const s = live(await one.seam.connectProfileById(env, id));
      // Rotation 1 writes twice: the armed attempt with its head, then the adopted pair — which fails.
      ks.failNth(key(id), 2, mode);
      expect((await s.fetch(ROUTE)).status, "rotation 1 answered").toBe(204);
      expect((await profiles.list())[0]!.refreshToken, "the adopted pair did not reach the keystore").toBe("f1-ref-1");
      door.expireAccess();
      expect((await s.fetch(ROUTE)).status, "rotation 2 answered").toBe(204);
      const second = saves.mock.calls.findIndex((c) => c[1] === "f1-ref-3");
      expect(second).toBeGreaterThan(-1);
      expect(await saves.mock.results[second]!.value, "the next save lands over the row it left behind").toBe("landed");
      expect((await profiles.list())[0]).toMatchObject({ refreshToken: "f1-ref-3", refreshAttempt: null });
      s.store.close();

      const two = await launch();
      const env2 = envOf(new two.ServerProfileStore(ks.kv), door.fetchImpl, world);
      const s2 = live(await two.seam.connectProfileById(env2, id));
      const deaths: SessionDeath[] = [];
      s2.bearer!.onSessionDead((w) => deaths.push(w));
      expect((await s2.fetch(ROUTE)).status, "the relaunch rotates from the caught-up row").toBe(204);
      expect(door.isSwept("f1")).toBe(false);
      expect(deaths).toEqual([]);
      s2.store.close();
    });
  }

  it("a kill after the arm that follows the failed save relaunches on the pair the server answers", async () => {
    // MUTATION WATCHED: the arm writes the attempt without the head — the relaunch presents the
    // first token under the second attempt's name, the chain has moved on, and it is swept.
    const door = chainDoor();
    const ks = flakyKeystore();
    const world = sqlWorld();
    const one = await launch();
    const profiles = new one.ServerProfileStore(ks.kv);
    const env = envOf(profiles, door.fetchImpl, world);
    const id = (await profiles.add({ origin: ORIGIN, flavor: "selfhost", accountId: "acct-1", refreshToken: door.seed(), apiBase: ORIGIN })).id;
    const s = live(await one.seam.connectProfileById(env, id));
    ks.failNth(key(id), 2, "throw");
    expect((await s.fetch(ROUTE)).status).toBe(204);
    door.expireAccess();
    // Rotation 2: its arm lands, the server consumes f1-ref-2 and mints, and the answer is lost.
    door.dropNextAnswer();
    expect((await s.fetch(ROUTE)).status, "the answer never arrived").toBe(401);
    const armed = (await profiles.list())[0]!;
    expect(armed.refreshToken, "the arm wrote the head beside its attempt").toBe("f1-ref-2");
    expect(armed.refreshAttempt).toBeTruthy();
    s.store.close();

    // Killed here. The relaunch loads the arm's pair and retries as that attempt.
    const two = await launch();
    const env2 = envOf(new two.ServerProfileStore(ks.kv), door.fetchImpl, world);
    const s2 = live(await two.seam.connectProfileById(env2, id));
    const deaths: SessionDeath[] = [];
    s2.bearer!.onSessionDead((w) => deaths.push(w));
    expect((await s2.fetch(ROUTE)).status, "minted as the same attempt").toBe(204);
    expect(door.presented.at(-1)).toEqual({ token: "f1-ref-2", attempt: armed.refreshAttempt });
    expect(door.isSwept("f1")).toBe(false);
    expect(deaths).toEqual([]);
    s2.store.close();
  });

  it("a failed save, then a re-pair: the old manager's next writes are superseded, the row keeps the redeem's", async () => {
    // MUTATION WATCHED: the chain check admitting any held row — the old family's arm lands over
    // the redeem's token and the phone rotates a family the server has replaced.
    const door = chainDoor();
    const ks = flakyKeystore();
    const world = sqlWorld();
    const one = await launch();
    const profiles = new one.ServerProfileStore(ks.kv);
    const env = envOf(profiles, door.fetchImpl, world);
    const arms = vi.spyOn(profiles, "armRefreshAttempt");
    const saves = vi.spyOn(profiles, "saveRefreshToken");
    const paired = await one.seam.pairWithServer(env, { admission: ADMISSION, token: "tok-1" });
    if (paired.kind !== "paired") throw new Error(`pairing refused: ${JSON.stringify(paired)}`);
    const s1 = paired.session;
    const m1 = s1.bearer!;
    const id = s1.profile.id;
    door.expireAccess();
    ks.failNth(key(id), 2, "throw");
    expect((await s1.fetch(ROUTE)).status).toBe(204);
    expect((await profiles.list())[0]!.refreshToken, "the failed save left the first token").toBe("f1-ref-1");
    s1.store.close();

    const again = await one.seam.pairWithServer(env, { admission: ADMISSION, token: "tok-2" });
    if (again.kind !== "paired") throw new Error(`re-pair refused: ${JSON.stringify(again)}`);
    expect(again.session.bearer).not.toBe(m1);
    expect((await profiles.list())[0]!.refreshToken).toBe("f2-ref-1");

    door.expireAccess();
    expect((await m1.fetch(ROUTE)).status, "the old family still rotates on the server").toBe(204);
    const arm = arms.mock.calls.findIndex((c) => c[2] === "f1-ref-2");
    expect(await arms.mock.results[arm]!.value, "its arm is superseded").toBe("superseded");
    const save = saves.mock.calls.findIndex((c) => c[1] === "f1-ref-3");
    expect(await saves.mock.results[save]!.value, "and its save").toBe("superseded");
    expect((await profiles.list())[0]).toMatchObject({ refreshToken: "f2-ref-1", refreshAttempt: null });
    again.session.store.close();
  });
});
