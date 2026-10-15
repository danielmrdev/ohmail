import { describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapServer } from "./_metaworld.js";
import { IMAP_META_DEADLINE_MS, isImapBoundExceeded } from "../../src/adapters/imap-bounds.js";
import {
  CLAIM_PROTOCOL, formatClaim, makeLeasePeekIo, type LeaseImapClient,
} from "../../src/adapters/organizer-lease.js";

/**
 * ═══ ONE READ OF `ohmail/_meta` IS FOUR COMMANDS, AND THEY SHARE ONE CLOCK ══════════════════
 *
 * `IMAP_META_DEADLINE_MS` is named "one read of `ohmail/_meta`" and bounded the FETCH alone. The
 * three commands in front of it — the LIST that resolves the folder, the SELECT that opens it,
 * the STATUS that counts it — ran under no clock at all, and the FETCH then started the whole
 * ceiling fresh however long they had taken. A server that answers each of them slowly holds the
 * peek, the door waiting on it and the folder's lock for as long as it likes while every ceiling
 * in the module reports nothing.
 *
 * The cases below drive the SHIPPING constant with an injected clock, the way the window's own
 * suite does: each command costs wall time, and the ceiling fires on the TOTAL. The discriminating
 * one is `four segments of twenty seconds`: under one budget that is eighty seconds and refuses;
 * under a clock per segment it is four commands of twenty, each comfortably inside its own sixty,
 * and the read completes. That case is the mechanism, and the three before it say the clock
 * reaches every segment rather than the last two.
 */

const META = "INBOX.ohmail._meta";
const NOW = new Date("2026-09-13T00:00:00.000Z");
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");

function liveClaim(): string {
  return formatClaim({
    installId: "incumbent-install",
    kind: "local",
    displayName: "The Kitchen Mac",
    claimedAt: new Date(NOW.getTime() - 600_000),
    heartbeat: new Date(NOW.getTime() - 5_000),
    nonce: "incumbent-nonce",
    authorizedAt: new Date(NOW.getTime() - 600_000),
    capabilities: ["requests"],
    protocol: CLAIM_PROTOCOL,
  });
}

/** Which of the read's four commands a cost is charged to. */
type Segment = "list" | "lock" | "status" | "fetch";

/**
 * A server that answers correctly and SLOWLY — the one behaviour a real server can have that no
 * count ceiling sees and the socket's inactivity timer never notices. The clock is the test's, so
 * a case charges sixty-one seconds without waiting sixty-one seconds; the constant under test is
 * the shipping one.
 */
function costing(
  server: MemoryImapServer, clock: { ms: number }, costs: Partial<Record<Segment, number>>,
): LeaseImapClient {
  const spend = (s: Segment): void => { clock.ms += costs[s] ?? 0; };
  const slow = Object.create(server) as MemoryImapServer;
  Object.defineProperties(slow, {
    list: {
      value: async (): Promise<unknown> => { spend("list"); return server.list(); },
    },
    getMailboxLock: {
      value: async (name: string): Promise<unknown> => {
        spend("lock");
        return server.getMailboxLock(name);
      },
    },
    status: {
      value: async (path: string, query: { messages?: boolean; uidNext?: boolean }) => {
        spend("status");
        // `status` is optional on the probe client this fake satisfies; the memory server always
        // has one, and a fake that quietly answered `undefined` would make the STATUS segment
        // unreachable — which is one of the segments under test.
        return server.status!(path, query);
      },
    },
    fetch: {
      value: (range: string, query: unknown, opts?: unknown): AsyncIterable<unknown> => ({
        async *[Symbol.asyncIterator]() {
          let first = true;
          for await (const m of server.fetch!(
            range, query as never, opts as never,
          ) as AsyncIterable<unknown>) {
            // Charged ONCE, on the first row: the cost models a server that takes its time
            // starting to answer, which is the shape the socket's timer cannot see.
            if (first) { spend("fetch"); first = false; }
            yield m;
          }
        },
      }),
    },
  });
  return slow as unknown as LeaseImapClient;
}

/**
 * A folder with two ordinary records and a live claim last — the honest shape. The one door
 * (`readMetaRecords`) hands a lease reader the claim alone, so an ordinary read answers one.
 */
function world(): MemoryImapServer {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  server.seed(META, "Subject: newsletter 1\r\n\r\nbody");
  server.seed(META, "Subject: newsletter 2\r\n\r\nbody");
  server.seed(META, liveClaim());
  return server;
}

async function peek(
  server: MemoryImapServer, clock: { ms: number }, costs: Partial<Record<Segment, number>>,
): Promise<{ ok: boolean; claims: number; bound: string | null }> {
  const io = makeLeasePeekIo(costing(server, clock, costs), toServerPath, { now: () => clock.ms });
  try {
    const claims = await io.listClaims();
    return { ok: true, claims: claims.length, bound: null };
  } catch (err) {
    if (!isImapBoundExceeded(err)) throw err;
    return { ok: false, claims: 0, bound: err.bound };
  }
}

describe("the meta read's budget covers every segment, not only the FETCH", () => {
  /**
   * THE POSITIVE CONTROL, and it is not optional: every refusal below is only worth the fact that
   * an ordinary read of the same folder over the same fake still answers.
   */
  it("admits a read whose four commands together stay inside the ceiling", async () => {
    const clock = { ms: NOW.getTime() };
    const each = Math.floor(IMAP_META_DEADLINE_MS / 6);
    const out = await peek(world(), clock, {
      list: each, lock: each, status: each, fetch: each,
    });
    expect(out.ok).toBe(true);
    expect(out.claims).toBe(1);
  });

  /**
   * ── THE DISCRIMINATING CASE ───────────────────────────────────────────────────────────────
   *
   * Four segments at a third of the ceiling apiece. One budget: the total is four thirds of the
   * ceiling and the read refuses. A budget per segment: every command is inside its own ceiling
   * and the read completes — which is what this file exists to tell apart, and what the code did
   * before the budget moved to the entry point.
   */
  it("refuses a read whose segments are each inside the ceiling but together past it", async () => {
    const clock = { ms: NOW.getTime() };
    const third = Math.ceil(IMAP_META_DEADLINE_MS / 3);
    const out = await peek(world(), clock, {
      list: third, lock: third, status: third, fetch: third,
    });
    expect(out.ok).toBe(false);
    expect(out.bound).toBe("read_deadline");
  });

  /**
   * One segment over the whole ceiling, four times — the clock reaches each of them. A refusal
   * charged to the LIST, the SELECT or the STATUS surfaces at the next raced command, because a
   * command that has already answered cannot be un-answered; what is under test is that the time
   * it spent is still on the read's account when the next one runs.
   */
  const overTheCeiling = IMAP_META_DEADLINE_MS + 1_000;
  for (const segment of ["list", "lock", "status", "fetch"] as const) {
    it(`refuses when the ${segment} alone spends the whole ceiling`, async () => {
      const clock = { ms: NOW.getTime() };
      const out = await peek(world(), clock, { [segment]: overTheCeiling });
      expect(out.ok).toBe(false);
      expect(out.bound).toBe("read_deadline");
    });
  }

  /**
   * AND THE CEILING IS NOT A PER-COMMAND ONE. A single command just under the ceiling, with
   * nothing else spending, still answers — so the refusals above are the TOTAL crossing the line
   * and not a command being slow enough to be refused on its own.
   */
  it("admits one slow command that stays inside the ceiling on its own", async () => {
    const clock = { ms: NOW.getTime() };
    const out = await peek(world(), clock, { status: IMAP_META_DEADLINE_MS - 1_000 });
    expect(out.ok).toBe(true);
    expect(out.claims).toBe(1);
  });
});
