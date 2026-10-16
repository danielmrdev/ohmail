import { describe, expect, it } from "vitest";

import { memoryImapServer } from "./_metaworld.js";
import {
  ImapBoundConfigError, ImapBoundExceeded, IMAP_META_BYTES_MAX, IMAP_META_DEADLINE_MS, META_ENUM_BYTES_MAX,
  IMAP_LIST_MAX_FOLDERS, IMAP_READ_DEADLINE_MS, boundFromEnv, boundedFetch, isImapBoundExceeded,
} from "../../src/adapters/imap-bounds.js";
import {
  CLAIM_PROTOCOL, META_RECORDS_MAX_PER_FETCH, metaFolderFullSentence, formatClaim,
  makeMetaFolderRef, readMetaFolderWindow,
  type LeaseImapClient, type MetaFolderClient,
} from "../../src/adapters/organizer-lease.js";

/**
 * ═══ `ohmail/_meta` IS BOUNDED IN BYTES AND ON A CLOCK, NOT ONLY IN COUNT ═══════════════════
 *
 * The count ceiling was the whole of it, and it leaves two shapes open. A server chooses the SIZE
 * of a header block, so one record inside a ceiling of 500 can be as large as it likes; and a
 * server chooses how FAST it answers, which no count ceiling and no socket timer can see — the
 * socket's timer measures silence, and a reply trickling in is never silent.
 *
 * ── WHY THE FIXTURE IS A FAKE SERVER AND NOT GreenMail ────────────────────────────────────────
 *
 * GreenMail is an HONEST server: it cannot be made to answer a bounded FETCH with a nine-megabyte
 * header block, and it cannot be made to answer slowly. Against it the two arms under test are
 * unreachable, which would make this file green whether or not they exist. The same argument the
 * adapter's own hostile-server suite makes, for the same reason. What a real server IS the right
 * instrument for is the POSITIVE control — an ordinary folder still reads exactly as it did — and
 * that is what the GreenMail-backed lease and peek suites next door do.
 *
 * The clock is INJECTED rather than lowered, so every case drives the shipping constant.
 */

const META = "INBOX.ohmail._meta";
const NOW = new Date("2026-09-10T12:00:00.000Z");
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

/** A folder holding `n` ordinary records plus one live claim last — the honest shape. */
function world(n: number) {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  for (let i = 0; i < n; i++) server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
  const claimUid = server.seed(META, liveClaim());
  return { server, claimUid };
}

/** Half the byte ceiling plus a little, so TWO of them cross it and ONE does not. */
const overHalfTheCeiling = (): string =>
  `Subject: ${"x".repeat(Math.ceil(IMAP_META_BYTES_MAX / 2) + 1024)}\r\n\r\nbody`;

describe("the meta window's BYTE ceiling — a count of 500 says nothing about one record's size", () => {
  it("keeps the newest that fit and reports it, where the records alone cross the ceiling", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, overHalfTheCeiling());
    server.seed(META, overHalfTheCeiling());
    await server.getMailboxLock(META);

    const read = await readMetaFolderWindow(server as unknown as LeaseImapClient, META);

    // ONE-WORD VERDICTS ONLY. Both records are megabytes wide and a failed assertion that
    // pretty-prints one of them takes the worker with it.
    expect(read.records.length).toBe(1);
    // `truncated` is the window's own word for it, and every caller already reads it as
    // "I could not look" — so the byte arm answers UNKNOWN by the route the count arm does.
    expect(read.truncated).toBe(true);
    // The NEWEST survived: this folder appends, so the last record is the live one.
    expect(read.records[0]!.ref).toBe(2);
  });

  it("the REFUSAL names the ceiling that fired, not the one it did not", async () => {
    /*
     * A report naming the wrong condition is worse than none: it sends whoever reads it to look
     * for a window's worth of records in a folder holding two. Before the byte arm existed every
     * truncation was the record count's, so the sentence could assume it; it cannot now.
     */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, overHalfTheCeiling());
    server.seed(META, overHalfTheCeiling());
    await server.getMailboxLock(META);
    const read = await readMetaFolderWindow(server as unknown as LeaseImapClient, META);

    expect(read.truncatedBy).toBe("bytes");
    const sentence = metaFolderFullSentence(2, META_ENUM_BYTES_MAX, "bytes");
    expect(sentence).toContain(`${META_ENUM_BYTES_MAX / (1024 * 1024)} MiB`);
    expect(sentence).not.toContain(String(META_ENUM_BYTES_MAX));
  });

  it("a RECORD-count refusal still names records — the default, and the other direction", () => {
    const sentence = metaFolderFullSentence(20_001, 20_000);
    expect(sentence).toBe("ohmail/_meta holds 20001" + " messages. ohmail reads at most 20000, so organizing "
      + "is paused on this mailbox until the folder is smaller.");
  });

  it("a folder well inside the ceiling reads whole and reports nothing evicted", async () => {
    const { server, claimUid } = world(3);
    await server.getMailboxLock(META);

    const read = await readMetaFolderWindow(server as unknown as LeaseImapClient, META);

    expect(read.records).toHaveLength(4);
    expect(read.truncated).toBe(false);
    expect(read.records.at(-1)!.ref).toBe(claimUid);
  });
});

describe("the LIST the raw client answers — the read the adapter's own ceiling could not reach", () => {
  it("REFUSES past the folder ceiling rather than resolving from a truncated list", async () => {
    // The refusal is the right direction: a lease that cannot enumerate the folder must not
    // decide from a partial list, and the class is the one the adapter's own LIST raises — so a
    // server naming an absurd number of folders is attributed to this mailbox, which is what it is.
    const many = Array.from(
      { length: IMAP_LIST_MAX_FOLDERS + 5 },
      (_v, i) => ({ path: `INBOX.filler${i}`, subscribed: false, delimiter: "." }),
    );
    const listed: Array<{ path: string; subscribed: boolean; delimiter: string }> = [
      ...many, { path: META, subscribed: false, delimiter: "." },
    ];
    const ref = makeMetaFolderRef(
      { list: async () => listed } as unknown as MetaFolderClient, toServerPath,
    );

    const err = await ref.locate().then(() => null, (e: unknown) => e);

    expect(isImapBoundExceeded(err)).toBe(true);
    expect((err as ImapBoundExceeded).bound).toBe("list_folders");
  });

  it("a folder inside the ceiling is found — the arm admits an ordinary mailbox", async () => {
    const listed = [
      { path: "INBOX", subscribed: true, delimiter: "." },
      { path: META, subscribed: false, delimiter: "." },
    ];
    const ref = makeMetaFolderRef(
      { list: async () => listed } as unknown as MetaFolderClient, toServerPath,
    );

    const at = await ref.locate();

    expect(at.row?.path).toBe(META);
  });
});

describe("the meta window's CLOCK — the one instrument that sees a server answering slowly", () => {
  /**
   * A server that starts the reply and then stops. The clock the read was handed advances past
   * the budget while the first record is being consumed, so the next pull is refused with nothing
   * waited for in real time — the same arithmetic a sixty-second stall produces.
   */
  function stallsAfterOne(server: ReturnType<typeof memoryImapServer>, clock: { ms: number }) {
    return {
      ...server,
      /* SPREADING EVALUATES A GETTER ONCE, so `mailbox` is delegated rather than copied —
         a frozen `false` reads as a folder with no UIDVALIDITY. The methods copy fine. */
      get mailbox() { return server.mailbox; },
      fetch(range: string, query: Record<string, unknown>, options?: { uid?: boolean }) {
        const inner = server.fetch(range, query as never, options);
        return (async function* stall() {
          for await (const m of inner) {
            yield m;
            clock.ms += IMAP_META_DEADLINE_MS + 1;
          }
        })();
      },
    };
  }

  it("refuses with the read deadline rather than waiting on a stalled reply", async () => {
    const { server } = world(4);
    await server.getMailboxLock(META);
    const clock = { ms: 1_000_000 };
    const client = stallsAfterOne(server, clock) as unknown as LeaseImapClient;

    const err = await readMetaFolderWindow(client, META, () => clock.ms)
      .then(() => null, (e: unknown) => e);

    expect(isImapBoundExceeded(err)).toBe(true);
    expect((err as ImapBoundExceeded).bound).toBe("read_deadline");
    expect((err as ImapBoundExceeded).limit).toBe(IMAP_META_DEADLINE_MS);
  });

  it("the RE-READ shares the first attempt's budget rather than getting a fresh one", async () => {
    /*
     * A window that comes back short is read again from the start, because the count it was
     * computed from can have gone stale under an expunge. Two attempts with a budget each is
     * twice the ceiling for one read of the folder, which makes the constant's own claim false
     * exactly where a hostile server would spend it.
     *
     * So the clock crosses the budget as the FIRST attempt ENDS — after its last pull, which is
     * the only place it can cross without ending that attempt instead. With one budget the second
     * attempt refuses before it pulls; with a budget each it would read the folder again.
     */
    const { server } = world(4);
    await server.getMailboxLock(META);
    const clock = { ms: 1_000_000 };
    let pulls = 0;
    let spent = false;
    const shortWindowThenSpent = {
      ...server,
      get mailbox() { return server.mailbox; },
      // A count far above the truth is what makes the first window short, and a short window is
      // what triggers the re-read.
      async status(): Promise<{ messages: number }> { return { messages: META_RECORDS_MAX_PER_FETCH * 3 }; },
      fetch(range: string, query: Record<string, unknown>, options?: { uid?: boolean }) {
        const inner = server.fetch(range, query as never, options);
        return (async function* burnAtTheEnd() {
          for await (const m of inner) { pulls++; yield m; }
          if (!spent) { spent = true; clock.ms += IMAP_META_DEADLINE_MS + 1; }
        })();
      },
    } as unknown as LeaseImapClient;

    const err = await readMetaFolderWindow(shortWindowThenSpent, META, () => clock.ms)
      .then(() => null, (e: unknown) => e);

    expect(isImapBoundExceeded(err)).toBe(true);
    expect((err as ImapBoundExceeded).bound).toBe("read_deadline");
    // The first attempt's pulls and NOT ONE MORE — its window is `1001:*`, which against a
    // five-message folder is one record plus the closing pull. A fresh budget would read the
    // whole folder again from `1:*`, which is six more.
    expect(pulls).toBe(2);
  });

  it("a steady clock reads the same folder whole — the arm admits an ordinary server", async () => {
    const { server, claimUid } = world(4);
    await server.getMailboxLock(META);
    const clock = { ms: 1_000_000 };

    const read = await readMetaFolderWindow(
      server as unknown as LeaseImapClient, META, () => clock.ms,
    );

    expect(read.records).toHaveLength(5);
    expect(read.records.at(-1)!.ref).toBe(claimUid);
  });
});

describe("the ceilings themselves", () => {
  it("are finite and positive, and the folder's clock cannot outlive the general per-read one", () => {
    expect(Number.isFinite(IMAP_META_BYTES_MAX)).toBe(true);
    expect(IMAP_META_BYTES_MAX).toBeGreaterThan(0);
    expect(Number.isFinite(IMAP_META_DEADLINE_MS)).toBe(true);
    expect(IMAP_META_DEADLINE_MS).toBeGreaterThan(0);
    // A metadata read of ONE folder can never legitimately need longer than the general ceiling.
    expect(IMAP_META_DEADLINE_MS).toBeLessThanOrEqual(IMAP_READ_DEADLINE_MS);
    // Generous against the legitimate population: a full window of records at their own payload ceiling.
    expect(IMAP_META_BYTES_MAX).toBeGreaterThan(META_RECORDS_MAX_PER_FETCH * 4096);
  });

  it("REFUSE a non-numeric override BY NAME, and admit an absent one", () => {
    const bad = ["2 000", "abc", "", "  ", "1.5", "-1", "0", "1e3x"];
    for (const raw of bad) {
      const got = ((): unknown => {
        try { return boundFromEnv("TF_PROBE_CEILING", 7, { TF_PROBE_CEILING: raw }); } catch (e) { return e; }
      })();
      if (raw.trim() === "") {
        // An UNSET or blank value is not a bad value — it is the default, and the positive
        // control for this rule: a reader that refused it would refuse every ordinary boot.
        expect(got, JSON.stringify(raw)).toBe(7);
        continue;
      }
      expect(got instanceof ImapBoundConfigError, JSON.stringify(raw)).toBe(true);
      expect((got as ImapBoundConfigError).configVar).toBe("TF_PROBE_CEILING");
      // The VALUE is never quoted back — a ceiling is not a secret, but the habit is the rule.
      expect((got as ImapBoundConfigError).message).not.toContain(raw);
    }
    expect(boundFromEnv("TF_PROBE_CEILING", 7, {})).toBe(7);
    expect(boundFromEnv("TF_PROBE_CEILING", 7, { TF_PROBE_CEILING: "12" })).toBe(12);
  });
});

describe("boundedFetch — the three axes and the three dispositions", () => {
  async function* stream(n: number, bytesEach = 10): AsyncGenerator<{ i: number; size: number }> {
    for (let i = 0; i < n; i++) yield { i, size: bytesEach };
  }

  it("REFUSES past the byte ceiling under the throwing disposition, before the item is kept", async () => {
    const err = await boundedFetch(stream(10, 100), {
      max: 100,
      bound: "sample_rows",
      bytes: { max: 250, of: (m) => m.size },
      map: (m) => m.i,
    }).then(() => null, (e: unknown) => e);

    expect(isImapBoundExceeded(err)).toBe(true);
    expect((err as ImapBoundExceeded).bound).toBe("read_bytes");
    expect((err as ImapBoundExceeded).limit).toBe(250);
  });

  it("counts what the stream SENDS, so a mapper that yields nothing still spends the ceiling", async () => {
    const read = await boundedFetch(stream(6, 1), {
      max: 4,
      onOverflow: "evict",
      map: () => null,
    });
    expect(read.items).toHaveLength(4);
    expect(read.evicted).toBe(true);
  });

  it("reports the retirement ONCE per breach, and says whether it will throw", async () => {
    const seen: Array<{ notify: boolean; bound: string }> = [];
    await boundedFetch(stream(9, 1), {
      max: 3,
      bound: "sample_rows",
      onOverflow: "stop",
      onAbandon: (notify, because) => seen.push({ notify, bound: because.bound }),
      map: (m) => m.i,
    });
    expect(seen).toEqual([{ notify: true, bound: "sample_rows" }]);
  });

  it("evict abandons nothing, so it never reports a retirement", async () => {
    const seen: string[] = [];
    const read = await boundedFetch(stream(9, 1), {
      max: 3,
      onOverflow: "evict",
      onAbandon: (_notify, because) => seen.push(because.bound),
      map: (m) => m.i,
    });
    expect(read.items).toEqual([6, 7, 8]);
    expect(seen).toEqual([]);
  });
});
