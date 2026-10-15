import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { createApp, apiRoutes, ERASED_ANSWER_HEADER, type ApiDeps } from "@trafficflow/api";
import { makeDeps, req, seedSession, seedMailbox, FIXED_NOW } from "./helpers.js";

/**
 * AN ERASED ACCOUNT'S BEARER IS TOLD SO. The erasure deletes every session and refresh token in
 * the transaction that stamps `accounts.erased_at`, so after it the token names nothing and the
 * door answered 401 — which a desktop reads as "signed out" and renews against forever. The
 * erasure now keeps each live token's HASH (`erased_bearers`), and a client that declares it
 * understands the answer hears `410 account_erased` from every authenticated route and from the
 * refresh door. A client that does not declare it keeps its 401 (the web and phone key a
 * session's death on it). Watched red: the session door's arm cut, the declaration read as always
 * given, the refresh door's arm cut, the erasure's record call cut.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });
const DECLARED = { [ERASED_ANSWER_HEADER]: "account_erased" };

/** The desktop's position: a native bearer pair minted by a device-pair redeem on the account. */
async function nativePair(deps: ApiDeps, minter: string): Promise<{ accessToken: string; refreshToken: string }> {
  const minted = await (await H(req("POST", "/pair", {
    bearer: minter, body: JSON.stringify({ grant: "device-pair", label: "Desk" }),
  }), deps)).json() as { token: string };
  const redeemed = await H(req("POST", "/pair/redeem", {
    body: JSON.stringify({ grant: "device-pair", token: minted.token }),
  }), deps);
  expect(redeemed.status, await redeemed.clone().text()).toBe(200);
  return ((await redeemed.json()) as { tokens: { accessToken: string; refreshToken: string } }).tokens;
}

/** The hosted reads a paired desktop's mirror makes (`apps/sidecar/src/cloud-mirror.ts`). */
const PULL_READS = [
  "/mailboxes",
  "/mailboxes?counts=1",
  "/sync?limit=50",
  "/sync/snapshot?limit=50",
  "/messages/bodies?ids=00000000-0000-4000-8000-000000000001",
];

async function erasedDesktop(): Promise<{ deps: ApiDeps; pair: { accessToken: string; refreshToken: string }; accountId: string; advance: (ms: number) => void }> {
  const { db, deps, clock } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  await seedMailbox(db, { accountId: s.accountId });
  const pair = await nativePair(deps, s.token);
  const erased = await H(req("DELETE", "/account", { bearer: s.token }), deps);
  expect(erased.status, await erased.clone().text()).toBe(200);
  return { deps, pair, accountId: s.accountId, advance: clock.advance };
}

async function codeOf(res: Response): Promise<string | null> {
  try {
    return ((await res.clone().json()) as { error?: { code?: string } }).error?.code ?? null;
  } catch {
    return null;
  }
}

describe("a declared bearer of an erased account hears 410 account_erased", () => {
  it("on every read the mirror pulls, on /events, on a write, and at the refresh door", async () => {
    const { deps, pair } = await erasedDesktop();
    for (const path of [...PULL_READS, "/events"]) {
      const res = await H(req("GET", path, { bearer: pair.accessToken, headers: DECLARED }), deps);
      expect(`${res.status} ${await codeOf(res)}`, path).toBe("410 account_erased");
    }
    const write = await H(req("PATCH", "/consent/settings", {
      bearer: pair.accessToken, headers: DECLARED, body: JSON.stringify({ dormancyDays: 30 }),
    }), deps);
    expect(`${write.status} ${await codeOf(write)}`, "PATCH /consent/settings").toBe("410 account_erased");

    const refresh = await H(req("POST", "/auth/refresh", {
      headers: DECLARED, body: JSON.stringify({ refreshToken: pair.refreshToken }),
    }), deps);
    expect(`${refresh.status} ${await codeOf(refresh)}`, "POST /auth/refresh").toBe("410 account_erased");
  });

  it("the retry of a rotation whose answer was LOST hears it too, at the refresh door", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    await seedMailbox(db, { accountId: s.accountId });
    const pair = await nativePair(deps, s.token);
    const spend = (headers: Record<string, string> = {}): Promise<Response> => H(req("POST", "/auth/refresh", {
      headers, body: JSON.stringify({ refreshToken: pair.refreshToken, attemptId: "lost-answer" }),
    }), deps);
    expect((await spend()).status, "the rotation whose answer the desktop never received").toBe(200);
    expect((await spend()).status, "positive control: the consumed token still spends for its attempt").toBe(200);
    const erased = await H(req("DELETE", "/account", { bearer: s.token }), deps);
    expect(erased.status, await erased.clone().text()).toBe(200);
    const retry = await spend(DECLARED);
    expect(`${retry.status} ${await codeOf(retry)}`, "a lost answer's retry was told it signed out").toBe("410 account_erased");
  });

  it("after the access window the reads answer 401 and the REFRESH door carries the verdict", async () => {
    const { deps, pair, advance } = await erasedDesktop();
    advance(16 * 60_000);
    const read = await H(req("GET", "/mailboxes", { bearer: pair.accessToken, headers: DECLARED }), deps);
    expect(`${read.status} ${await codeOf(read)}`).toBe("401 unauthorized");
    const refresh = await H(req("POST", "/auth/refresh", {
      headers: DECLARED, body: JSON.stringify({ refreshToken: pair.refreshToken }),
    }), deps);
    expect(`${refresh.status} ${await codeOf(refresh)}`).toBe("410 account_erased");
  });
});

describe("a device silent past its refresh window (ERASED-ACCOUNT-DEVICE-PAST-REFRESH-WINDOW-KEEPS-COPY)", () => {
  it("still hears 410 account_erased at the refresh door, so it drops its copy", async () => {
    const { deps, pair, advance } = await erasedDesktop();
    // Past the native refresh window: the token itself expired long ago.
    advance((deps.authConfig.nativeRefreshTtlMs ?? 0) + 30 * 24 * 60 * 60_000);
    const refresh = await H(req("POST", "/auth/refresh", {
      headers: DECLARED, body: JSON.stringify({ refreshToken: pair.refreshToken }),
    }), deps);
    expect(`${refresh.status} ${await codeOf(refresh)}`).toBe("410 account_erased");
  });
});

describe("what does not change", () => {
  it("an UNDECLARED client keeps the 401 it always had, on reads and at the refresh door", async () => {
    const { deps, pair } = await erasedDesktop();
    const read = await H(req("GET", "/mailboxes", { bearer: pair.accessToken }), deps);
    expect(`${read.status} ${await codeOf(read)}`).toBe("401 unauthorized");
    const refresh = await H(req("POST", "/auth/refresh", {
      body: JSON.stringify({ refreshToken: pair.refreshToken }),
    }), deps);
    expect(refresh.status).toBe(401);
    expect(await codeOf(refresh)).not.toBe("account_erased");
  });

  it("a fault in the lookup answers the 401 it always did, never a 500 — on the raw route too", async () => {
    const { deps, pair } = await erasedDesktop();
    const auth = deps.services!.auth!;
    const faulting = Object.create(auth, {
      bearerOfErasedAccount: { value: async () => { throw new Error("the lookup faulted"); } },
    }) as typeof auth;
    const d = { ...deps, services: { ...deps.services, auth: faulting } } as ApiDeps;
    for (const path of ["/mailboxes", "/events"]) {
      const res = await H(req("GET", path, { bearer: pair.accessToken, headers: DECLARED }), d);
      expect(`${res.status} ${await codeOf(res)}`, path).toBe("401 unauthorized");
    }
  });

  it("an ordinary account's declared reads answer 200, and an unknown token stays 401", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    await seedMailbox(db, { accountId: s.accountId });
    const pair = await nativePair(deps, s.token);
    for (const path of PULL_READS) {
      const res = await H(req("GET", path, { bearer: pair.accessToken, headers: DECLARED }), deps);
      expect(res.status, `${path} ${await res.clone().text()}`).toBe(200);
    }
    const stranger = await H(req("GET", "/mailboxes", { bearer: "not-a-token", headers: DECLARED }), deps);
    expect(`${stranger.status} ${await codeOf(stranger)}`).toBe("401 unauthorized");
  });

  it("a MAILBOX mid-erasure is not an erased account: the account's reads answer 200", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    // Mail 0126's owed state: the request stamped `erased_at`, the pass has not finished.
    await db.update(mailboxes).set({ erasedAt: FIXED_NOW, erasureDoneAt: null }).where(eq(mailboxes.id, mb));
    const pair = await nativePair(deps, s.token);
    const res = await H(req("GET", "/sync?limit=50", { bearer: pair.accessToken, headers: DECLARED }), deps);
    expect(res.status, await res.clone().text()).toBe(200);
  });
});
