import { describe, it, expect } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { authThrottle } from "../src/schema-cloud.js";
import { pruneAuthThrottle, AUTH_THROTTLE_RETENTION_MS, KNOWN_CLIENT_RETENTION_MS } from "../src/auth-throttle-prune.js";

/**
 * NOTHING DELETED THROTTLE ROWS BUT AN ERASURE: every typed address and client hash stayed for
 * ever. The worker's maintenance pass now prunes past one retention (48 h, a known client 90 d),
 * and never a row whose lock is still live.
 */
describe("pruneAuthThrottle", () => {
  it("keeps a live lock and a known client under 90 days, and deletes what is past retention", async () => {
    const db = await makeTestDb();
    const now = new Date();
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    const H = 3_600_000;
    await db.insert(authThrottle).values([
      { key: "pw:old-locked", failures: 5, windowStartedAt: ago(49 * H), lockedUntil: new Date(now.getTime() + H) },
      { key: "pw:old", failures: 2, windowStartedAt: ago(49 * H) },
      { key: "email:legacy@example.com", failures: 1, windowStartedAt: ago(49 * H) },
      { key: "factor-day:recent", failures: 20, windowStartedAt: ago(47 * H), lockedUntil: ago(H) },
      { key: "known:a:b", failures: 0, windowStartedAt: ago(49 * H) },
      { key: "known:c:d", failures: 0, windowStartedAt: ago(KNOWN_CLIENT_RETENTION_MS + H) },
      { key: "mail:x", failures: 1, windowStartedAt: ago(AUTH_THROTTLE_RETENTION_MS + H) },
    ]);
    expect(await pruneAuthThrottle(db as never, now)).toBe(4);
    const left = (await db.select({ key: authThrottle.key }).from(authThrottle)).map((r) => r.key).sort();
    expect(left).toEqual(["factor-day:recent", "known:a:b", "pw:old-locked"]);
  });

  /**
   * the prune half: the IMAP admission counters (`imap:mailbox:<id>`, the probe's
   * `imap:mailbox:probe:<hash>`) are swept by this pass like every other prefix — a counter no
   * acquire has touched for a retention holds no live connection (one lives far shorter) — and a fresh
   * one is kept.
   */
  it("sweeps the IMAP admission counters past retention and keeps a fresh one", async () => {
    const db = await makeTestDb();
    const now = new Date();
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    await db.insert(authThrottle).values([
      { key: "imap:mailbox:00000000-0000-4000-8000-000000000001", failures: 0, windowStartedAt: ago(AUTH_THROTTLE_RETENTION_MS + 60_000) },
      { key: "imap:mailbox:probe:abc", failures: 0, windowStartedAt: ago(AUTH_THROTTLE_RETENTION_MS + 60_000) },
      { key: "imap:mailbox:00000000-0000-4000-8000-000000000002", failures: 1, windowStartedAt: ago(30_000) },
    ]);
    expect(await pruneAuthThrottle(db as never, now)).toBe(2);
    const left = (await db.select({ key: authThrottle.key }).from(authThrottle)).map((r) => r.key);
    expect(left).toEqual(["imap:mailbox:00000000-0000-4000-8000-000000000002"]);
  });
});
