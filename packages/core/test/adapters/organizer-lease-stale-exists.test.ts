import { describe, expect, it } from "vitest";
import { memoryImapServer } from "./_metaworld.js";
import {
  makeLeaseIo,
  makeLeasePeekIo,
  formatClaim,
  decideLease,
  parseClaim,
  CLAIM_PROTOCOL,
  type ClaimRecord,
  type OrganizerClaim,
} from "../../src/adapters/organizer-lease.js";

/** The io seams refuse a memory they cannot attribute, so every fixture states one. */
const TEST_META_ID = { installId: "test-install", mailboxId: "test-mailbox" };

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A CACHED `exists` IS NOT A POSITIVELY KNOWN ZERO
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Three reads in `organizer-lease.ts` skip their `FETCH 1:*` when the selected folder holds no
 * messages, because `1:*` is not a valid messageset against an empty mailbox and Dovecot refuses
 * the command outright. Each said the rule was *"only a POSITIVELY KNOWN zero skips the fetch"*.
 *
 * `client.mailbox.exists` does not meet that bar. It is a CACHE a connection updates only from
 * untagged responses, and `getMailboxLock` does not re-SELECT a folder that is already selected.
 *
 * ── MEASURED, against the real Dovecot behind the project's own test mailboxes, 2026-09-04 ────
 *
 * Two connections on one `ohmail/_meta`. B empties the folder, so B's cache reaches a TRUE zero.
 * A — a different connection — then appends a claim. B's cached `exists` stayed **0** across gaps
 * of 1.5 s, 3 s, 6 s and 10 s; taking `getMailboxLock` again did not refresh it; a forced
 * `FETCH 1:*` in that window was refused by the server outright. Only by 20 s had imapflow's IDLE
 * delivered the EXISTS, and one explicit NOOP corrected it immediately (0 → 1).
 *
 * ── WHY IT MATTERS MORE THAN A MISSED READ ───────────────────────────────────────────────────
 *
 * The gate reads that empty folder, takes `decideLease`'s arm 4 — "nobody has ever organized this
 * mailbox" — and claims it with an EMPTY displacement. The live incumbent's claim stays. **Two
 * live claims, two organizers**, which is the single-organizer invariant the module exists to
 * hold. It also spends the caller's one-shot takeover authorization while leaving the beaten claim
 * standing to win the next election — the exact outcome `removeClaims` already refuses to let a
 * silently-failed EXPUNGE cause.
 *
 * Reproduced end to end against a live mailbox before it was reproduced here: two 0.14.1 installs
 * on one real folder, the second install's authorized press answering `organize` with
 * `displace: []` while the first install's claim stood, leaving both in the folder.
 *
 * ── WHY NO EXISTING GUARD COULD SEE IT ───────────────────────────────────────────────────────
 *
 * `memoryImapServer` computed `exists` live from its own tree, so it modelled a connection that
 * is always perfectly current. That is the one property a real long-lived connection does not
 * have. `staleExists` is what lets the fake express it at all.
 */

const NOW = new Date("2026-09-04T05:00:00.000Z");
const META = "INBOX.ohmail._meta";

function world() {
  return memoryImapServer({
    prefix: "INBOX.",
    folders: ["INBOX.ohmail", META],
    staleExists: true,
  });
}

/** An incumbent's live claim, as `formatClaim` writes one. */
function incumbentClaim(): string {
  return formatClaim({
    installId: "incumbent-install",
    kind: "local",
    displayName: "The Incumbent",
    claimedAt: new Date(NOW.getTime() - 60_000),
    heartbeat: new Date(NOW.getTime() - 5_000),
    nonce: "incumbent-nonce",
    authorizedAt: new Date(NOW.getTime() - 60_000),
    capabilities: ["requests"],
    protocol: CLAIM_PROTOCOL,
  });
}

/**
 * Drive the fake into the exact state the live measurement found: the connection's cache holds a
 * TRUE zero, and then the folder gains a claim by a route that sends this connection no untagged
 * response — which `seed()` is, being a fixture rather than a write path.
 */
async function connectionWithStaleZero() {
  const server = world();
  const io = makeLeaseIo(server, (c) => c.replace(/\//g, "."), TEST_META_ID);

  // The connection selects `_meta` while it is genuinely empty, so its cache is a true 0.
  await io.listClaims();
  expect(server.mailbox && server.mailbox.exists).toBe(0);

  // Another connection appends. This one is told nothing.
  server.seed(META, incumbentClaim());

  return { server, io };
}

describe("a stale `exists` must not be read as an empty folder", () => {
  it("listClaims RETURNS the live claim even though the cached count says zero", async () => {
    const { server, io } = await connectionWithStaleZero();

    // The premise: the cache still says empty while the folder holds one claim.
    expect(server.mailbox && server.mailbox.exists).toBe(0);
    expect(server.tree.get(META)!.messages).toHaveLength(1);

    const claims = await io.listClaims();

    // MUTATION WATCH: trust the cached zero before asking the server and this is `[]` — the defect.
    expect(claims).toHaveLength(1);
    expect(claims[0]!.raw).toContain("incumbent-install");
    /* THE MECHANISM CHANGED, AND THE OLD ASSERTION PINNED A CEREMONY RATHER THAN A GUARANTEE.
     * This required that a NOOP had been issued, on the premise that a NOOP proves the cache is
     * current. It does not: the library discards the command's result (`async noop() { await
     * this.run('NOOP'); }`), so a REFUSED noop resolves exactly like an accepted one and the
     * "refreshed" flag built on it was inferring a refresh from the absence of a throw. What
     * closes a stale zero is asking the SERVER for the count — a STATUS naming the folder. */
    expect(server.log.filter((l) => l.startsWith(`status ${META}`)),
      "the cached zero was not confirmed against the server").not.toHaveLength(0);
  });

  it("THE INVARIANT: an authorized press over a stale zero DISPLACES the incumbent rather than joining it", async () => {
    const { io } = await connectionWithStaleZero();

    const raw = await io.listClaims();
    const parsed = raw
      // The gate parses what it listed; a claim that does not come back cannot be displaced.
      .map((m) => parseClaim(m.raw, m.ref))
      .filter((c): c is ClaimRecord => c !== null);

    const verdict = decideLease({
      claims: parsed,
      self: { installId: "taker-install", kind: "local", displayName: "The Taker", lastNonce: null },
      now: NOW,
      takeover: { authorizedAt: NOW, intent: "takeover" },
    });

    expect(verdict.verdict).toBe("organize");
    // Arm 4 would answer `organize` too — with NOTHING displaced. That is the difference between
    // taking a mailbox over and quietly becoming its second organizer.
    expect((verdict as { displace: unknown[] }).displace).toHaveLength(1);
    expect((parsed[0] as OrganizerClaim).installId).toBe("incumbent-install");
  });

  it("the PEEK reports the holder rather than an unorganized mailbox", async () => {
    const server = world();
    const peek = makeLeasePeekIo(server, (c) => c.replace(/\//g, "."));

    await peek.listClaims();
    expect(server.mailbox && server.mailbox.exists).toBe(0);
    server.seed(META, incumbentClaim());

    const claims = await peek.listClaims();
    // Without the refresh a reader is told nobody organizes a mailbox that is held — and the
    // once-only notice is derived from exactly this.
    expect(claims).toHaveLength(1);
  });

  it("a NOOP that FAILS leaves the caller no worse off than not asking", async () => {
    const server = world();
    const io = makeLeaseIo(server, (c) => c.replace(/\//g, "."), TEST_META_ID);
    await io.listClaims();
    server.seed(META, incumbentClaim());

    // A server that refuses NOOP must not turn a readable folder into a lease fault.
    (server as { noop?: () => Promise<unknown> }).noop = async () => {
      throw new Error("NOOP refused");
    };

    // The cached zero stands, so this returns empty — but it RETURNS, rather than throwing.
    await expect(io.listClaims()).resolves.toBeInstanceOf(Array);
  });

  it("the default fake is unchanged — `exists` stays live unless a test asks for the cache", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const io = makeLeaseIo(server, (c) => c.replace(/\//g, "."), TEST_META_ID);
    await io.listClaims();
    server.seed(META, incumbentClaim());
    // No `staleExists`, so the count was never stale and this passed before the fix too.
    expect(await io.listClaims()).toHaveLength(1);
  });
});
