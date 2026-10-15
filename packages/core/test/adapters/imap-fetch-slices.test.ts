import { describe, expect, it } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { FETCH_SLICE_MS, slicedFetch } from "../../src/adapters/imap-bounds.js";
import type { ImapCursor } from "../../src/adapters/imap-types.js";

/**
 * A ROW STREAM HANDS THE EVENT LOOP BACK. imapflow under backpressure hands its rows over one at a
 * time through nextTick and microtasks, so a whole-folder `1:* (UID)` held the loop for a socket
 * chunk at a time (225 ms on a large mailbox here, 600 on the Windows guest) and a search typed then
 * waited it out. The fixture rows arrive the same way, with CPU per row; the control iterates them
 * raw and watches the loop starve, so the fixture has the property. Watched red: the turn removed
 * from `slicedFetch`, and the adapter's client left unwrapped.
 */
const ROWS = 6_000;
const ROW_CPU_MS = 0.1;
/** A turn may arrive one slice plus one row late, and a loaded host gets a margin. */
const GAP_BOUND_MS = FETCH_SLICE_MS + 12;

function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* the parse */ }
}

/** imapflow's shape: each row after a nextTick, never a macrotask, and CPU spent on each. */
async function* rowsByNextTick(n: number): AsyncGenerator<{ uid: number }> {
  for (let uid = 1; uid <= n; uid++) {
    await new Promise<void>((r) => process.nextTick(r));
    busy(ROW_CPU_MS);
    yield { uid };
  }
}

/** The longest stretch the loop went without a timer firing while `work` ran. */
async function longestGap(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);
  last = performance.now();
  await work();
  longest = Math.max(longest, performance.now() - last);
  clearInterval(tick);
  return longest;
}

describe("a row stream hands the loop back", () => {
  it("the raw stream starves the loop: the fixture has the property", async () => {
    const gap = await longestGap(async () => { for await (const _ of rowsByNextTick(ROWS)) { /* drained */ } });
    expect(gap).toBeGreaterThan(ROWS * ROW_CPU_MS * 0.5);
  });

  it("the sliced stream gives the loop a turn every slice, and keeps every row in order", async () => {
    const got: number[] = [];
    const sliced = slicedFetch((n: number) => rowsByNextTick(n));
    const gap = await longestGap(async () => { for await (const r of sliced(ROWS)) got.push(r.uid); });
    expect(gap).toBeLessThanOrEqual(GAP_BOUND_MS);
    expect(got).toEqual(Array.from({ length: ROWS }, (_, i) => i + 1));
  });

  it("an early break still closes the stream it pulled from", async () => {
    let closed = false;
    async function* source(): AsyncGenerator<number> {
      try { for (let i = 0; ; i++) yield i; } finally { closed = true; }
    }
    for await (const n of slicedFetch(source)()) if (n === 3) break;
    expect(closed).toBe(true);
  });

  it("the adapter's own enumeration reaches the loop through its client", async () => {
    const box = { path: "INBOX", uidValidity: 100n, uidNext: ROWS + 1, highestModseq: 50n, exists: ROWS };
    const client = {
      capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true]]),
      mailbox: box as typeof box | false,
      _path: "INBOX",
      async list() { return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }]; },
      async getMailboxLock(path: string) {
        this._path = path;
        this.mailbox = path === "INBOX" ? box : { ...box, path, exists: 0, uidNext: 1, highestModseq: 0n };
        return { path, release() {} };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(_range: unknown, _query: unknown, options: any) {
        if (this._path !== "INBOX" || options?.changedSince) return;
        yield* rowsByNextTick(ROWS);
      },
    };
    const adapter = new ImapAdapter({ host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } }, { client });
    await adapter.connect();
    const known = Array.from({ length: ROWS }, (_, i) => ({ uid: i + 1, messageId: `m${i + 1}@x` }));
    const cursor: ImapCursor = { folders: { INBOX: { uidValidity: "100", uidNext: ROWS + 1, highestModseq: "50", known } } };
    let batch: Awaited<ReturnType<ImapAdapter["changesSince"]>> | undefined;
    const gap = await longestGap(async () => { batch = await adapter.changesSince(cursor); });
    expect(gap, "the enumeration held the loop").toBeLessThanOrEqual(GAP_BOUND_MS + 20);
    expect(batch!.creates).toHaveLength(0);
    expect(batch!.deletes).toHaveLength(0);
  }, 30_000);
});
