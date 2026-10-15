import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, getTableName, is } from "drizzle-orm";
import { PgTable, PgColumn, getTableConfig } from "drizzle-orm/pg-core";
import { makeTestDb } from "../src/testing.js";
import { schema } from "../src/schema.js";
import { accounts, users, mailboxes, mailboxCredentials } from "../src/schema-mail.js";
import {
  totpSecrets, staffUsers, mailboxOauthCeremonies,
  mailboxOauthDeviceCeremonies, oauthProviderConfig,
} from "../src/schema-cloud.js";
import {
  runKekRewrap, kekRewrapCensus, formatCensus, WRAPPED_SECRET_SITES,
  type RewrapKeyProvider, type KekRewrapResult,
} from "../src/kek-rewrap.js";
import type { Tx } from "../src/change-log.js";

/**
 * CRYPTO-4 — the KEK re-wrap pass, everything a single connection can prove.
 *
 * The three properties that need REAL Postgres — resume after a kill, the atomicity of the
 * write, and the lost update a snapshot-based implementation causes — live in
 * `kek-rewrap.pg.test.ts`. What is here is the registry's completeness, the census arithmetic,
 * and the fail-closed behaviours, all of which are single-connection questions.
 *
 * The registry test is the one that matters most in a year's time: it is what makes a SIXTH
 * encrypted column added by somebody who has never read this file fail the suite rather than sit
 * outside rotation for ever.
 */

/** A KeyProvider over toy "keys" — the envelope format is core's business, not this module's. */
function fakeProvider(version: number, opts: {
  /** Versions this ring can open. Defaults to every version at or below `version`. */
  canDecrypt?: number[];
  /** Corrupt the envelope so the round-trip check must catch it. */
  breakRoundTrip?: boolean;
} = {}): RewrapKeyProvider & { encrypts: number } {
  const openable = opts.canDecrypt ?? Array.from({ length: version }, (_, i) => i + 1);
  return {
    encrypts: 0,
    async encrypt(plaintext: string) {
      this.encrypts++;
      const body = opts.breakRoundTrip ? "CORRUPT" : plaintext;
      return { ciphertext: `v${version}:${Buffer.from(body).toString("base64url")}`, keyVersion: version };
    },
    async decrypt(ciphertext: string, keyVersion: number) {
      if (!openable.includes(keyVersion)) throw new Error(`no KEK for version ${keyVersion}`);
      const m = /^v(\d+):(.*)$/.exec(ciphertext);
      if (!m) throw new Error("Unsupported state or unable to authenticate data");
      if (Number(m[1]) !== keyVersion) throw new Error("Unsupported state or unable to authenticate data");
      return Buffer.from(m[2]!, "base64url").toString("utf8");
    },
    currentKeyVersion: () => version,
  };
}

function sealedAt(version: number, plaintext: string): string {
  return `v${version}:${Buffer.from(plaintext).toString("base64url")}`;
}

let db: Awaited<ReturnType<typeof makeTestDb>>;
let accountId: string;
let userId: string;
let mailboxId: string;

beforeEach(async () => {
  db = await makeTestDb();
  const [a] = await db.insert(accounts).values({ name: "rewrap" }).returning();
  accountId = a!.id;
  const [u] = await db.insert(users).values({
    accountId, email: `${randomUUID()}@example.test`,
  }).returning();
  userId = u!.id;
  const [m] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@example.test`,
  }).returning();
  mailboxId = m!.id;
});

/** Seed one row at every site, all at `version`, with a distinct plaintext each. */
async function seedAllSites(version: number): Promise<Record<string, string>> {
  const secrets = {
    "mailbox_credentials.secret_enc": `imap-pass-${randomUUID()}`,
    "totp_secrets.secret_enc": `totp-${randomUUID()}`,
    // Cloud 0046's replacement in progress — the same row's second sealed site.
    "totp_secrets.pending_secret_enc": `totp-pending-${randomUUID()}`,
    "staff_users.totp_secret_enc": `staff-totp-${randomUUID()}`,
    // Cloud 0036's PENDING pair — the same row's second sealed site. Seeded with its own
    // plaintext, because a rotation that re-wrapped the live secret and left an enrolment in
    // progress sealed under a retired key is a confirmation that simply never works.
    "staff_users.totp_pending_secret_enc": `staff-totp-pending-${randomUUID()}`,
    "mailbox_oauth_ceremonies.code_verifier_enc": `verifier-${randomUUID()}`,
    "mailbox_oauth_device_ceremonies.device_code_enc": `device-code-${randomUUID()}`,
    "oauth_provider_config.client_secret_enc": `client-secret-${randomUUID()}`,
  };
  await db.insert(mailboxCredentials).values({
    mailboxId, transport: "imap",
    secretEnc: sealedAt(version, secrets["mailbox_credentials.secret_enc"]), keyVersion: version,
  });
  await db.insert(totpSecrets).values({
    userId, secretEnc: sealedAt(version, secrets["totp_secrets.secret_enc"]), keyVersion: version,
    activated: true,
    pendingSecretEnc: sealedAt(version, secrets["totp_secrets.pending_secret_enc"]),
    pendingKeyVersion: version, pendingStartedAt: new Date(),
  });
  await db.insert(staffUsers).values({
    email: `staff-${randomUUID()}@example.test`, passwordHash: "scrypt-x-password-hash",
    totpSecretEnc: sealedAt(version, secrets["staff_users.totp_secret_enc"]), totpKeyVersion: version,
    totpPendingSecretEnc: sealedAt(version, secrets["staff_users.totp_pending_secret_enc"]),
    totpPendingKeyVersion: version,
  });
  await db.insert(mailboxOauthCeremonies).values({
    state: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
    accountId, provider: "microsoft",
    codeVerifierEnc: sealedAt(version, secrets["mailbox_oauth_ceremonies.code_verifier_enc"]),
    codeVerifierKeyVersion: version,
  });
  await db.insert(mailboxOauthDeviceCeremonies).values({
    state: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
    accountId, provider: "microsoft",
    deviceCodeEnc: sealedAt(version, secrets["mailbox_oauth_device_ceremonies.device_code_enc"]),
    deviceCodeKeyVersion: version,
    userCode: "ABCD-EFGH",
    verificationUri: "https://microsoft.com/devicelogin",
    pollIntervalMs: 5_000,
    grantExpiresAt: new Date(Date.now() + 900_000),
  });
  await db.insert(oauthProviderConfig).values({
    provider: "microsoft",
    clientSecretEnc: sealedAt(version, secrets["oauth_provider_config.client_secret_enc"]),
    clientSecretKeyVersion: version,
  });
  return secrets;
}

/** Read every site's stored (ciphertext, version), keyed by site id. */
async function readAll(): Promise<Record<string, { ct: string | null; kv: number | null }>> {
  const [c] = await db.select().from(mailboxCredentials);
  const [t] = await db.select().from(totpSecrets);
  const [s] = await db.select().from(staffUsers);
  const [o] = await db.select().from(mailboxOauthCeremonies);
  const [d] = await db.select().from(mailboxOauthDeviceCeremonies);
  const [p] = await db.select().from(oauthProviderConfig);
  return {
    "mailbox_credentials.secret_enc": { ct: c?.secretEnc ?? null, kv: c?.keyVersion ?? null },
    "totp_secrets.secret_enc": { ct: t?.secretEnc ?? null, kv: t?.keyVersion ?? null },
    "totp_secrets.pending_secret_enc": { ct: t?.pendingSecretEnc ?? null, kv: t?.pendingKeyVersion ?? null },
    "staff_users.totp_secret_enc": { ct: s?.totpSecretEnc ?? null, kv: s?.totpKeyVersion ?? null },
    "staff_users.totp_pending_secret_enc": {
      ct: s?.totpPendingSecretEnc ?? null, kv: s?.totpPendingKeyVersion ?? null,
    },
    "mailbox_oauth_ceremonies.code_verifier_enc": {
      ct: o?.codeVerifierEnc ?? null, kv: o?.codeVerifierKeyVersion ?? null,
    },
    "mailbox_oauth_device_ceremonies.device_code_enc": {
      ct: d?.deviceCodeEnc ?? null, kv: d?.deviceCodeKeyVersion ?? null,
    },
    "oauth_provider_config.client_secret_enc": {
      ct: p?.clientSecretEnc ?? null, kv: p?.clientSecretKeyVersion ?? null,
    },
  };
}

describe("CRYPTO-4 — the registry names EVERY envelope column in the schema", () => {
  /**
   * `_enc` is the naming convention every envelope column in this schema already follows, and
   * this walk is what turns the convention into a constraint. A new one added without a
   * `WRAPPED_SECRET_SITES` entry lands here as a red test with the column's name in the message,
   * which is the moment to either register it or record WHY it is exempt — in this list, in the
   * open, rather than by omission.
   *
   * Watched fail: deleting the `oauth_provider_config` entry from `WRAPPED_SECRET_SITES` turns
   * this red with `oauth_provider_config.client_secret_enc` named.
   */
  it("every `_enc` column in the drizzle schema is a registered site", () => {
    const registered = new Set(WRAPPED_SECRET_SITES.map((s) => s.site));
    const found: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const table = getTableName(value as PgTable);
      for (const col of getTableConfig(value as PgTable).columns) {
        if (col.name.endsWith("_enc")) found.push(`${table}.${col.name}`);
      }
    }
    expect(found.length).toBeGreaterThan(0);          // the walk itself must not be vacuous
    expect([...found].sort()).toEqual([...registered].sort());
  });

  it("every declared property resolves to a real column, and the key columns are real too", () => {
    for (const site of WRAPPED_SECRET_SITES) {
      const cols = getTableConfig(site.table).columns;
      const names = new Set(cols.map((c) => c.name));
      const ct = (site.table as unknown as Record<string, PgColumn>)[site.ciphertext];
      const kv = (site.table as unknown as Record<string, PgColumn>)[site.keyVersion];
      expect(names.has(ct!.name), `${site.site}: ciphertext`).toBe(true);
      expect(names.has(kv!.name), `${site.site}: key version`).toBe(true);
      expect(site.site).toBe(`${getTableName(site.table)}.${ct!.name}`);
      expect(site.key.length).toBeGreaterThan(0);
      for (const k of site.key) {
        const col = (site.table as unknown as Record<string, PgColumn>)[k];
        expect(names.has(col!.name), `${site.site}: key ${k}`).toBe(true);
      }
    }
  });

  /**
   * The ceremony `state` is the single-use consumption key of a live authorization. Naming a
   * failing row by it would put a redeemable credential in a log, so that site — and only that
   * site — must declare `keyIsSecret`.
   */
  it("the only sites keyed on a secret are the two OAuth ceremonies, and both declare so", () => {
    /*
     * BOTH ceremony tables are keyed by a value that is itself a credential — the redirect flow's
     * `state` and the device flow's poll handle — so a report naming rows by primary key would
     * print one. `keyIsSecret` is what turns that key into a domain-separated digest prefix:
     * correlatable across two log lines, useless as a credential. Every OTHER site is keyed on an
     * id that is safe to print, and this list is exact so a new secret-keyed site cannot be added
     * without someone confirming the declaration, nor an existing one silently lose it.
     */
    const secretKeyed = WRAPPED_SECRET_SITES.filter((s) => s.keyIsSecret).map((s) => s.site).sort();
    expect(secretKeyed).toEqual([
      "mailbox_oauth_ceremonies.code_verifier_enc",
      "mailbox_oauth_device_ceremonies.device_code_enc",
    ]);
  });
});

describe("CRYPTO-4 — the census answers 'does anything still reference V<n>'", () => {
  it("counts every site by version and reports nothing outstanding at the target", async () => {
    await seedAllSites(1);
    const census = await kekRewrapCensus(db as unknown as Tx, 1);
    expect(census.outstanding).toBe(0);
    expect(census.versionsInUse).toEqual([1]);
    expect(census.sites.map((s) => s.site).sort())
      .toEqual(WRAPPED_SECRET_SITES.map((s) => s.site).sort());
    for (const s of census.sites) {
      expect(s.total, s.site).toBe(1);
      expect(s.byVersion, s.site).toEqual({ 1: 1 });
      expect(s.ahead, s.site).toBe(0);
      expect(s.mismatched, s.site).toBe(0);
    }
  });

  it("counts the same rows as OUTSTANDING once the target moves to key version 2", async () => {
    await seedAllSites(1);
    const census = await kekRewrapCensus(db as unknown as Tx, 2);
    // EIGHT since cloud 0046: `staff_users` and `totp_secrets` each carry two sealed sites, the
    // live pair and the pending one an enrolment or a replacement in progress holds.
    expect(census.outstanding).toBe(8);
    for (const s of census.sites) expect(s.outstanding, s.site).toBe(1);
    expect(formatCensus(census).at(-1)).toContain("8 row(s) still below V" + "2");
  });

  /**
   * A row written by a host that holds a KEK this one does not. It is NOT outstanding — there is
   * nothing this host could do with it — and it must never be silently folded into "done",
   * because "0 outstanding" is the sentence that licenses deleting a key.
   */
  it("rows ABOVE the target are reported separately and never counted as done", async () => {
    await seedAllSites(3);
    const census = await kekRewrapCensus(db as unknown as Tx, 2);
    expect(census.outstanding).toBe(0);
    for (const s of census.sites) expect(s.ahead, s.site).toBe(1);
    expect(formatCensus(census).join("\n")).toContain("AHEAD of this host's ring");
  });

  /**
   * "Null iff the secret is null" is not merely the schema's claim — cloud 0007 and 0009 each
   * carry a `… sealed_together` CHECK, so a half-null row is UNREPRESENTABLE on both nullable
   * sites. Measured here rather than assumed: the first draft of this file tried to seed one and
   * the database refused it.
   *
   * The census keeps its `mismatched` counter anyway, and that is a two-layer arrangement rather
   * than dead code. The CHECK is the real guard; the counter is what would notice a SIXTH,
   * nullable site registered next year without one. `kek-rewrap.pg.test.ts` asserts the CHECK
   * exists for every nullable site, so the two layers are tested as two layers.
   */
  it("a half-null row cannot be inserted at all — the CHECK, not the census, is the guard", async () => {
    await expect(db.insert(staffUsers).values({
      email: `staff-${randomUUID()}@example.test`, passwordHash: "scrypt-x-password-hash",
      totpSecretEnc: sealedAt(1, "orphan"), totpKeyVersion: null,
    })).rejects.toThrow(/staff_users_totp_sealed_together/);

    await expect(db.insert(oauthProviderConfig).values({
      provider: "microsoft", clientSecretEnc: sealedAt(1, "orphan"), clientSecretKeyVersion: null,
    })).rejects.toThrow(/oauth_provider_config_secret_sealed_together/);

    // Cloud 0046 seals a TRIO: a start time without its secret would be a replacement that is
    // fresh for ever, and a secret without its version cannot be opened.
    for (const trio of [
      { pendingSecretEnc: sealedAt(1, "orphan"), pendingKeyVersion: 1, pendingStartedAt: null },
      { pendingSecretEnc: sealedAt(1, "orphan"), pendingKeyVersion: null, pendingStartedAt: new Date() },
      { pendingSecretEnc: null, pendingKeyVersion: null, pendingStartedAt: new Date() },
    ]) {
      await expect(db.insert(totpSecrets).values({
        userId, secretEnc: sealedAt(1, "live"), keyVersion: 1, activated: true, ...trio,
      })).rejects.toThrow(/totp_secrets_pending_sealed_together/);
    }
  });

  it("reports no half-null defect on a healthy database", async () => {
    await seedAllSites(1);
    const census = await kekRewrapCensus(db as unknown as Tx, 1);
    for (const s of census.sites) expect(s.mismatched, s.site).toBe(0);
    expect(formatCensus(census).join("\n")).not.toContain("HALF-NULL");
  });

  /**
   * A NULL secret is not a candidate and not a defect: a staff row before enrolment and an
   * unconfigured provider both hold nothing to re-wrap.
   */
  it("rows holding no secret at all are neither counted nor visited", async () => {
    await db.insert(staffUsers).values({
      email: `staff-${randomUUID()}@example.test`, passwordHash: "scrypt-x-password-hash",
    });
    await db.insert(oauthProviderConfig).values({ provider: "microsoft" });

    const census = await kekRewrapCensus(db as unknown as Tx, 2);
    for (const s of census.sites) {
      expect(s.total, s.site).toBe(0);
      expect(s.mismatched, s.site).toBe(0);
      expect(s.outstanding, s.site).toBe(0);
    }
    const r = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: fakeProvider(2), apply: true,
    });
    expect(r.rewrapped).toBe(0);
    expect(r.failed).toBe(0);
  });
});

describe("CRYPTO-4 — the pass moves every site onto the current version", () => {
  it("re-wraps all eight sites, preserving every plaintext exactly", async () => {
    const secrets = await seedAllSites(1);
    const kp = fakeProvider(2);
    const r = await runKekRewrap({ db: db as unknown as Tx, keyProvider: kp, apply: true });

    expect(r.rewrapped).toBe(8);
    expect(r.failed).toBe(0);
    expect(r.raced).toBe(0);
    expect(r.truncated).toBe(false);

    const after = await readAll();
    for (const [site, plaintext] of Object.entries(secrets)) {
      expect(after[site]!.kv, site).toBe(2);
      expect(await kp.decrypt(after[site]!.ct!, 2), site).toBe(plaintext);
    }
  });

  it("a dry run writes NOTHING and still reports what it would do", async () => {
    const secrets = await seedAllSites(1);
    const before = await readAll();
    const kp = fakeProvider(2);
    const r = await runKekRewrap({ db: db as unknown as Tx, keyProvider: kp, apply: false });

    expect(r.rewrapped).toBe(0);
    expect(r.census.outstanding).toBe(8);
    expect(kp.encrypts).toBe(0);                       // not one envelope was even built
    expect(await readAll()).toEqual(before);
    expect(Object.keys(secrets)).toHaveLength(8);
  });

  /**
   * The idempotency claim, and it is structural rather than careful: a re-wrapped row no longer
   * matches `key_version < target`, so the second pass has no candidates to visit.
   */
  it("a second pass is a pair of reads: nothing re-wrapped, nothing changed", async () => {
    await seedAllSites(1);
    const kp = fakeProvider(2);
    await runKekRewrap({ db: db as unknown as Tx, keyProvider: kp, apply: true });
    const afterFirst = await readAll();
    const encryptsAfterFirst = kp.encrypts;

    const second = await runKekRewrap({ db: db as unknown as Tx, keyProvider: kp, apply: true });
    expect(second.rewrapped).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.census.outstanding).toBe(0);
    expect(kp.encrypts).toBe(encryptsAfterFirst);      // no row was re-encrypted a second time
    expect(await readAll()).toEqual(afterFirst);       // byte-identical, so no envelope churned
  });

  /**
   * A re-wrap changes how a secret is stored, not the secret. `oauth_provider_config.updated_at`
   * sits beside `updated_by`, which names the staff actor who last changed the registration —
   * bumping it would file this pass as an operator's edit.
   */
  it("does not touch `updated_at` on any site that has one", async () => {
    await seedAllSites(1);
    const beforeCred = (await db.select().from(mailboxCredentials))[0]!.updatedAt;
    const beforeCfg = (await db.select().from(oauthProviderConfig))[0]!.updatedAt;
    const beforeStaff = (await db.select().from(staffUsers))[0]!.updatedAt;
    const beforeTotp = (await db.select().from(totpSecrets))[0]!.updatedAt;

    await runKekRewrap({ db: db as unknown as Tx, keyProvider: fakeProvider(2), apply: true });

    expect((await db.select().from(mailboxCredentials))[0]!.updatedAt).toEqual(beforeCred);
    expect((await db.select().from(oauthProviderConfig))[0]!.updatedAt).toEqual(beforeCfg);
    expect((await db.select().from(staffUsers))[0]!.updatedAt).toEqual(beforeStaff);
    expect((await db.select().from(totpSecrets))[0]!.updatedAt).toEqual(beforeTotp);
  });

  it("honours the batch limit and says another pass is owed", async () => {
    await seedAllSites(1);
    // A second credential row on the same mailbox, so one site holds two candidates.
    await db.insert(mailboxCredentials).values({
      mailboxId, transport: "smtp", secretEnc: sealedAt(1, "smtp-pass-password"), keyVersion: 1,
    });
    const r = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: fakeProvider(2), apply: true, batchLimit: 1,
    });
    expect(r.truncated).toBe(true);
    expect(r.rewrapped).toBe(8);                       // one per site, the ninth deferred

    const second = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: fakeProvider(2), apply: true, batchLimit: 1,
    });
    expect(second.rewrapped).toBe(1);
    expect(second.truncated).toBe(false);
    expect((await kekRewrapCensus(db as unknown as Tx, 2)).outstanding).toBe(0);
  });
});

describe("CRYPTO-4 — fail closed: a value that will not decrypt is REPORTED, never destroyed", () => {
  /**
   * The whole point of the pass failing closed. A ring that has lost version one cannot re-wrap a version-one row,
   * and the only two acceptable outcomes are "leave it exactly as it is" and "say so". Writing a
   * blank, a null, or an envelope built from a failed decrypt would destroy a secret that exists
   * in no other place.
   *
   * Watched fail: moving the UPDATE above the decrypt (or catching the decrypt and continuing
   * with `""`) turns the `toEqual(before)` assertion red on every site.
   */
  it("a row whose version this ring cannot open is left byte-identical and named", async () => {
    await seedAllSites(1);
    const before = await readAll();
    // A ring that has already RETIRED exactly the state after a premature removal.
    const kp = fakeProvider(3, { canDecrypt: [2, 3] });

    const r = await runKekRewrap({ db: db as unknown as Tx, keyProvider: kp, apply: true });

    expect(r.rewrapped).toBe(0);
    expect(r.failed).toBe(8);
    expect(await readAll()).toEqual(before);
    for (const f of r.failures) {
      expect(f.reason, f.site).toBe("no_kek_for_version");
      expect(f.keyVersion, f.site).toBe(1);
    }
  });

  it("a corrupt envelope is reported as decrypt_failed and left alone", async () => {
    await db.insert(mailboxCredentials).values({
      mailboxId, transport: "imap", secretEnc: "not-an-envelope", keyVersion: 1,
    });
    const r = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: fakeProvider(2), apply: true,
    });
    expect(r.failed).toBe(1);
    expect(r.failures[0]!.reason).toBe("decrypt_failed");
    expect((await db.select().from(mailboxCredentials))[0]!.secretEnc).toBe("not-an-envelope");
    expect((await db.select().from(mailboxCredentials))[0]!.keyVersion).toBe(1);
  });

  /**
   * THE ONE WITH NO RECOVERY. If `encrypt` produced an envelope this ring cannot reopen and the
   * pass wrote it over the only copy, the secret is gone — no backup taken after the run has it.
   * So the new envelope is decrypted and compared BEFORE the UPDATE, in the same transaction.
   *
   * Watched fail: delete the `proof !== plaintext` check and this test's `toEqual(before)` goes
   * red with the corrupted envelope stored at the new version.
   */
  it("an envelope that does not decrypt back is NEVER written", async () => {
    await seedAllSites(1);
    const before = await readAll();
    const kp = fakeProvider(2, { breakRoundTrip: true });

    const r = await runKekRewrap({ db: db as unknown as Tx, keyProvider: kp, apply: true });

    expect(r.rewrapped).toBe(0);
    expect(r.failed).toBe(8);
    for (const f of r.failures) expect(f.reason, f.site).toBe("roundtrip_mismatch");
    expect(await readAll()).toEqual(before);
  });

  it("one failing row does not deny rotation to the rest", async () => {
    await seedAllSites(1);
    await db.insert(mailboxCredentials).values({
      mailboxId, transport: "smtp", secretEnc: "corrupt", keyVersion: 1,
    });
    const r = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: fakeProvider(2), apply: true,
    });
    expect(r.failed).toBe(1);
    expect(r.rewrapped).toBe(8);
    const census = await kekRewrapCensus(db as unknown as Tx, 2);
    expect(census.outstanding).toBe(1);               // the corrupt row, and only it
  });
});

describe("CRYPTO-4 — nothing this pass emits can carry key material", () => {
  /**
   * `SECRET_VALUE_PATTERNS` in `log.ts` names its own limits, so this does not rely on the
   * redactor: the events and failures are built from a closed set of reasons, counts and row
   * labels, and this asserts that neither a plaintext nor a stored ciphertext appears in the
   * JSON a caller would log.
   */
  it("no plaintext or ciphertext appears anywhere in the result or the events", async () => {
    const secrets = await seedAllSites(1);
    const before = await readAll();
    const events: unknown[] = [];
    const r: KekRewrapResult = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: fakeProvider(2), apply: true,
      onEvent: (e) => events.push(e),
    });

    const emitted = JSON.stringify({ r, events });
    for (const [site, plaintext] of Object.entries(secrets)) {
      expect(emitted, `${site} plaintext`).not.toContain(plaintext);
      expect(emitted, `${site} stored ciphertext`).not.toContain(before[site]!.ct);
    }
    expect(events).toHaveLength(8);
  });

  /**
   * The ceremony's `state` IS a credential — the single-use consumption key of a live
   * authorization. It must not appear in a row label even though the other four sites' keys may.
   *
   * Watched fail: setting `keyIsSecret: false` on that site puts the raw state into the label and
   * this goes red.
   */
  it("the OAuth ceremony's state is hashed in its row label, never printed", async () => {
    await seedAllSites(1);
    const [ceremony] = await db.select().from(mailboxOauthCeremonies);
    const events: Array<{ site: string; row: string }> = [];
    await runKekRewrap({
      db: db as unknown as Tx, keyProvider: fakeProvider(2), apply: true,
      onEvent: (e) => events.push(e as { site: string; row: string }),
    });

    const label = events.find((e) => e.site === "mailbox_oauth_ceremonies.code_verifier_enc")!.row;
    expect(label).not.toContain(ceremony!.state);
    expect(label).toMatch(/^#[0-9a-f]{12}$/);

    // And the other four DO print their identifier, because a uuid is not a credential and an
    // operator chasing a failure needs to be able to find the row.
    const credLabel = events.find((e) => e.site === "mailbox_credentials.secret_enc")!.row;
    expect(credLabel).toBe(`${mailboxId}/imap`);
  });
});

describe("CRYPTO-4 — the pass visits rows the live system is still using", () => {
  it("re-wraps a mailbox credential without disturbing the mailbox row or its meta", async () => {
    await db.insert(mailboxCredentials).values({
      mailboxId, transport: "imap", secretEnc: sealedAt(1, "pw"), keyVersion: 1,
      meta: { host: "imap.example.test", port: 993, secure: true },
    });
    await runKekRewrap({ db: db as unknown as Tx, keyProvider: fakeProvider(2), apply: true });
    const [row] = await db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, mailboxId));
    expect(row!.meta).toEqual({ host: "imap.example.test", port: 993, secure: true });
    expect(row!.keyVersion).toBe(2);
  });
});
