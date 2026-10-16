import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxOauthCeremonies, oauthProviderConfig } from "@trafficflow/db/cloud";
import { MS_AUTHORIZE_SCOPES, type KeyProvider } from "@trafficflow/core";
import { eq } from "drizzle-orm";
import { deleteAccount, type ServiceContext } from "@trafficflow/services";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE REDIRECT CONNECT CEREMONY, AGAINST AN ERASURE THAT LANDS BEFORE ITS INSERT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The path BESIDE the device ceremony, and the same class of defect: `createOAuthCeremony` wrote
 * `mailbox_oauth_ceremonies` — account-owned, emptied by the Art. 17 sweep — referencing the
 * `accounts` row erasure deliberately keeps. A session valid when the request started could land
 * its insert after the sweep committed, recreating sealed PKCE ceremony state: a live way back
 * into a mailbox on an account whose owner was told everything was gone.
 *
 * It was nearly filed as a gap row instead of fixed. That would have left the allow-list entry for
 * `oauth-ceremony.ts insert mailboxOauthCeremonies` saying "on the caller's tx" while the caller
 * fenced nothing — a written reason asserting cover that did not exist, one route away from the
 * one just closed.
 *
 * ── THE WINDOW IS NARROWER HERE, AND THAT IS NOT THE SAME AS CLOSED ─────────────────────────
 *
 * The device flow waits on Microsoft — a person reading a code off a screen — before it inserts.
 * This flow builds its authorize URL locally, so what sits between the session check and the
 * insert is the config resolve, the optional mailbox-hint read, and `keyProvider.encrypt`, which
 * is a key-service round trip. The sweep is opened at the encrypt: the LAST await before the
 * write, and one both the fenced and unfenced versions of the route make.
 *
 * ── WHAT THIS FILE CAN AND CANNOT DECIDE ────────────────────────────────────────────────────
 *
 * The ORDERED arm only — the sweep COMMITS and the route's fence then reads a settled `erased_at`
 * — which is what the PGlite harness this door's own suite uses can answer, and driving the real
 * ROUTE is what makes the refusal real. The CONCURRENT arm (the route's transaction already open
 * and past its fence when the sweep arrives) needs two connections and lives in
 * `packages/services/test/erasure-fence-race.pg.test.ts`, which proves `withAccountTx`'s
 * `FOR SHARE` interlock on real Postgres for every door that goes through it — and after this
 * lane both ceremonies are such doors.
 *
 * MUTATION WATCHED RED, THEN RESTORED (pristine copy, `cmp`): `withAccountTx` removed from the
 * start handler, leaving the bare `createOAuthCeremony(deps.db, …)` → ERASED red naming the
 * recreated ceremony row.
 */

const TENANT = "common";
const CLIENT_ID = "26dd5904-19d1-495d-bc3c-67aa2da6f5e3";
const REDIRECT = "https://ohmail.app/api/mailboxes/oauth/microsoft/callback";

const app = createApp(apiRoutes);

async function world(onEncrypt?: () => Promise<void>) {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });

  // The registration as a row — the source the resolver prefers. Sealed with the ORIGINAL key
  // provider, before the hook below exists, so the fixture's own encrypt cannot open the window.
  const enc = await deps.keyProvider.encrypt("THE-CLIENT-SECRET");
  await db.insert(oauthProviderConfig).values({
    provider: "microsoft",
    clientId: CLIENT_ID,
    clientSecretEnc: enc.ciphertext,
    clientSecretKeyVersion: enc.keyVersion,
    tenant: TENANT,
    redirectUris: [REDIRECT, "http://localhost"],
    scopes: [...MS_AUTHORIZE_SCOPES],
    enabled: true,
    updatedAt: FIXED_NOW,
  });

  const ctx = {
    db: db as unknown as ServiceContext["db"],
    accountId: s.accountId,
    userId: null,
    now: () => FIXED_NOW,
    requestId: "redirect-fence",
  } as ServiceContext;

  /* THE SEAM. `keyProvider.encrypt` is the last await the handler makes before it writes the
     ceremony, and it is a key-service round trip in production — so a sweep committing inside it
     is the ordinary shape of this race, not a contrivance. Only the PKCE verifier's encrypt is
     hooked: the fixture above already sealed its secret with the untouched provider.

     A DELEGATING CLASS, not `{ ...deps.keyProvider, encrypt }`. The real provider is a CLASS
     (`StaticKeyProvider`), so a spread copies its own properties and leaves `decrypt` and
     `currentKeyVersion` on the prototype behind — the first draft did exactly that, the config
     resolve's decrypt threw before the handler ever reached the encrypt, and both cases failed
     with a 500 that had nothing to do with the fence. `SlowKeyProvider` in the services suite is
     the same shape for the same reason. */
  class HookedKeyProvider implements KeyProvider {
    constructor(private readonly inner: KeyProvider) {}
    async encrypt(plaintext: string): Promise<{ ciphertext: string; keyVersion: number }> {
      if (onEncrypt) await onEncrypt();
      return this.inner.encrypt(plaintext);
    }
    decrypt(ciphertext: string, keyVersion: number): Promise<string> {
      return this.inner.decrypt(ciphertext, keyVersion);
    }
    currentKeyVersion(): number { return this.inner.currentKeyVersion(); }
    deriveSubkey(info: string): Buffer { return this.inner.deriveSubkey(info); }
  }

  const base: ApiDeps = {
    ...deps,
    appOrigin: "https://ohmail.app",
    keyProvider: new HookedKeyProvider(deps.keyProvider),
  };

  return {
    db, accountId: s.accountId, ctx,
    start: () => app.handle(
      req("POST", "/mailboxes/oauth/microsoft/start", { bearer: s.token, body: "{}" }),
      { ...base, session: null, idempotency: null },
    ),
  };
}

const ceremonies = async (w: Awaited<ReturnType<typeof world>>) =>
  w.db.select().from(mailboxOauthCeremonies)
    .where(eq(mailboxOauthCeremonies.accountId, w.accountId));

describe("the redirect connect ceremony and the erasure fence", () => {
  it("ERASED — the sweep lands before the insert: no ceremony state is written", async () => {
    let w!: Awaited<ReturnType<typeof world>>;
    let swept = false;
    w = await world(async () => {
      if (swept) return;
      swept = true;
      await deleteAccount(w.ctx);
    });

    const res = await w.start();

    expect(swept, "the verifier was never sealed — the window did not exist").toBe(true);
    // THE ROW FIRST: recreating it is what the defect DOES, so that is what the red should name.
    expect(await ceremonies(w), "sealed ceremony state was recreated after erasure").toHaveLength(0);
    // Then the answer — by CODE, not merely "not 201": a 404 or a foreign-key 500 would also fail
    // a `toBe(201)` and would mean something else entirely.
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
    // The verifier is still sealed — the fence's transaction did not change what the row holds.
    expect(rows[0]!.codeVerifierEnc).not.toContain("THE-CLIENT-SECRET");
  });
});
