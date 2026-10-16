import { describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapServer } from "./_metaworld.js";
import { ImapDeadline, META_ENUM_BYTES_MAX } from "../../src/adapters/imap-bounds.js";
import {
  META_ENUM_RECORDS_MAX,
  MetaEnumRefusedError,
  enumerateMetaFolder,
  metaReadBudget,
  type MetaEnumClient,
} from "../../src/adapters/organizer-lease.js";

/**
 * THE ONE ENUMERATION OF `ohmail/_meta` (FIX-026; ARCH-META-ENUMERATOR-RULING §2.2). Every refusal
 * has its admit arm beside it, the ceiling is measured at the shipping constant, and every case runs
 * on the in-process server whose FETCH answers what a server answers: header sections only, flags,
 * INTERNALDATE, a messageset honoured. Its two readers are the settings listing and, past its
 * window, the lease.
 */

const META = "INBOX.ohmail._meta";
const CLAIM = "X-Ohmail-Lease: 1\r\nX-Ohmail-Install-Id: install-a\r\nX-Ohmail-Protocol: 1\r\n"
  + "X-Ohmail-Heartbeat: 2026-09-28T12:00:00.000Z\r\nSubject: claim\r\n\r\nclaim";
const SETTINGS = "X-Ohmail-Profile: 1\r\nX-Ohmail-Install-Id: install-a\r\nSubject: ohmail settings for this mailbox\r\n\r\n{}";
const STRAY = "Subject: a note\r\n\r\nbody";
const isClaim = (h: string): boolean => /^X-Ohmail-Lease:/im.test(h);

function folder(opts: Parameters<typeof memoryImapServer>[0] = {}): MemoryImapServer {
  return memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], ...opts });
}
async function selected(server: MemoryImapServer): Promise<MemoryImapServer> {
  await server.getMailboxLock(META);
  return server;
}
const fetches = (server: MemoryImapServer): string[] => server.log.filter((l) => l.startsWith(`fetch ${META} `));
async function refusal(p: Promise<unknown>): Promise<MetaEnumRefusedError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof MetaEnumRefusedError) return err;
    throw err;
  }
  throw new Error("the enumeration answered where it should have refused");
}

describe("enumerateMetaFolder: one header FETCH, proved complete", () => {
  it("retains what `keep` accepts, counts every row, and carries flags and the server's clock", async () => {
    const server = folder();
    server.seed(META, STRAY, new Date("2026-09-01T00:00:00Z"), []);
    const claimUid = server.seed(META, CLAIM, new Date("2026-09-28T12:00:05Z"), ["\\Seen"]);
    server.seed(META, SETTINGS);
    await selected(server);

    const out = await enumerateMetaFolder(server, META, metaReadBudget(), { keep: isClaim });

    expect(out).toMatchObject({ total: 3, count: 3, probe: "unasked", generation: 1_000 });
    expect(out.records.map((r) => r.ref)).toEqual([claimUid]);
    expect(out.records[0]!.internalDate).toEqual(new Date("2026-09-28T12:00:05Z"));
    expect(out.records[0]!.flags).toEqual(["\\Seen"]);
    expect(out.records[0]!.raw).toContain("X-Ohmail-Install-Id: install-a");
    expect(out.records[0]!.raw, "a header FETCH returned the body").not.toContain("claim\r\n\r\nclaim");
    expect(fetches(server)).toEqual([`fetch ${META} 1:*`]);
    expect(server.log.filter((l) => l.startsWith("search ")), "an enumeration asked SEARCH").toEqual([]);
  });

  it("an empty folder is a complete answer with no FETCH; a probe there reads absent", async () => {
    const server = await selected(folder());
    expect(await enumerateMetaFolder(server, META, metaReadBudget(), { keep: () => true }))
      .toMatchObject({ records: [], total: 0, count: 0, probe: "unasked" });
    expect(await enumerateMetaFolder(server, META, metaReadBudget(), {
      keep: () => true, probe: { uid: 7, recognised: () => true },
    })).toMatchObject({ records: [], probe: "absent" });
    expect(fetches(server), "an empty folder was fetched").toEqual([]);
  });

  it("no count refuses `no_count` before any FETCH; a count admits", async () => {
    const countless = folder({ refuseMessagesCount: true });
    countless.seed(META, CLAIM);
    await selected(countless);
    expect((await refusal(enumerateMetaFolder(countless, META, metaReadBudget(), { keep: isClaim }))).code).toBe("no_count");
    expect(fetches(countless)).toEqual([]);

    const counted = folder();
    counted.seed(META, CLAIM);
    await selected(counted);
    await expect(enumerateMetaFolder(counted, META, metaReadBudget(), { keep: isClaim })).resolves.toMatchObject({ count: 1 });
  });

  it(`the ceiling at the shipping constant: ${META_ENUM_RECORDS_MAX} admitted, one more refused before any FETCH`, async () => {
    const server = folder();
    for (let i = 0; i < META_ENUM_RECORDS_MAX; i++) server.seed(META, STRAY);
    await selected(server);
    await expect(enumerateMetaFolder(server, META, metaReadBudget(), { keep: isClaim }))
      .resolves.toMatchObject({ total: META_ENUM_RECORDS_MAX, records: [] });

    server.seed(META, CLAIM);
    server.log.length = 0;
    const r = await refusal(enumerateMetaFolder(server, META, metaReadBudget(), { keep: isClaim }));
    expect(r).toMatchObject({ code: "over_ceiling", total: META_ENUM_RECORDS_MAX + 1, ceiling: META_ENUM_RECORDS_MAX });
    expect(fetches(server), "the folder was fetched above the ceiling").toEqual([]);
  });

  it("a server that sends more rows than it counts past the ceiling refuses `over_ceiling`", async () => {
    const server = folder();
    for (let i = 0; i < 12; i++) server.seed(META, STRAY);
    const overSending: MetaEnumClient = {
      get mailbox() { return server.mailbox; },
      status: async () => ({ messages: 10 }),
      fetch: (range, query, options) => server.fetch(range, query, options),
    };
    await selected(server);
    expect((await refusal(enumerateMetaFolder(overSending, META, metaReadBudget(), { keep: isClaim, recordsMax: 10 }))).code)
      .toBe("over_ceiling");
  });

  it("header bytes past the byte ceiling refuse `bytes`; the default is the shared 32 MiB", async () => {
    expect(META_ENUM_BYTES_MAX).toBe(32 * 1024 * 1024);
    const server = folder();
    for (let i = 0; i < 5; i++) server.seed(META, `X-Pad: ${"p".repeat(400)}\r\n\r\nbody`);
    await selected(server);
    expect((await refusal(enumerateMetaFolder(server, META, metaReadBudget(), { keep: () => true, bytesMax: 1_000 }))).code)
      .toBe("bytes");
    await expect(enumerateMetaFolder(server, META, metaReadBudget(), { keep: () => true, bytesMax: 10_000 }))
      .resolves.toMatchObject({ total: 5 });
  });

  it("a read that runs out of its budget refuses `read_deadline`", async () => {
    const server = folder();
    server.seed(META, CLAIM);
    let t = 0;
    const budget = ImapDeadline.in(1_000, "read_deadline", () => t);
    const slow: MetaEnumClient = {
      get mailbox() { return server.mailbox; },
      status: (p, q) => server.status!(p, q),
      fetch: (range, query, options) => { t = 5_000; return server.fetch(range, query, options); },
    };
    await selected(server);
    expect((await refusal(enumerateMetaFolder(slow, META, budget, { keep: isClaim }))).code).toBe("read_deadline");
  });

  it("fewer rows than the count refuses `incomplete`; a count that settles on the re-ask admits; an extra row is no shortfall", async () => {
    const short = folder({ fetchTruncatesAt: 2 });
    for (let i = 0; i < 3; i++) short.seed(META, CLAIM);
    await selected(short);
    expect(await refusal(enumerateMetaFolder(short, META, metaReadBudget(), { keep: isClaim })))
      .toMatchObject({ code: "incomplete", rows: 2, total: 3 });

    const settles = folder();
    for (let i = 0; i < 3; i++) settles.seed(META, CLAIM);
    let asked = 0;
    const overcountOnce: MetaEnumClient = {
      get mailbox() { return settles.mailbox; },
      status: async (p, q) => { asked += 1; const s = await settles.status!(p, q); return asked === 1 ? { ...s, messages: 4 } : s; },
      fetch: (range, query, options) => settles.fetch(range, query, options),
    };
    await selected(settles);
    await expect(enumerateMetaFolder(overcountOnce, META, metaReadBudget(), { keep: isClaim })).resolves.toMatchObject({ total: 3 });
    expect(asked, "the shortfall was not asked a second time").toBe(2);

    const grew = folder();
    for (let i = 0; i < 3; i++) grew.seed(META, CLAIM);
    const undercount: MetaEnumClient = {
      get mailbox() { return grew.mailbox; },
      status: async () => ({ messages: 2 }),
      fetch: (range, query, options) => grew.fetch(range, query, options),
    };
    await selected(grew);
    await expect(enumerateMetaFolder(undercount, META, metaReadBudget(), { keep: isClaim })).resolves.toMatchObject({ total: 3, count: 2 });
  });

  it("a row without headers refuses `headerless`; the same folder with headers admits", async () => {
    const server = folder();
    server.seed(META, CLAIM);
    const blank = server.seed(META, STRAY);
    await selected(server);
    server.misbehave({ headersBlankFor: [blank] });
    expect((await refusal(enumerateMetaFolder(server, META, metaReadBudget(), { keep: isClaim }))).code).toBe("headerless");
    server.heal("headersBlankFor");
    await expect(enumerateMetaFolder(server, META, metaReadBudget(), { keep: isClaim })).resolves.toMatchObject({ total: 2 });
  });

  it("the probe: our own record listed and recognised is kept; blank or unrecognised refuses `blind`, before `headerless`", async () => {
    const server = folder();
    const own = server.seed(META, CLAIM);
    const other = server.seed(META, STRAY);
    await selected(server);
    const probe = { uid: own, recognised: isClaim };
    await expect(enumerateMetaFolder(server, META, metaReadBudget(), { keep: isClaim, probe })).resolves.toMatchObject({ probe: "kept" });
    expect((await refusal(enumerateMetaFolder(server, META, metaReadBudget(), {
      keep: isClaim, probe: { uid: other, recognised: isClaim },
    }))).code).toBe("blind");

    server.misbehave({ headersBlankFor: [own, other] });
    expect((await refusal(enumerateMetaFolder(server, META, metaReadBudget(), { keep: isClaim, probe }))).code,
      "the positive control did not name itself").toBe("blind");

    server.heal("headersBlankFor");
    server.tree.get(META)!.messages = server.tree.get(META)!.messages.filter((m) => m.uid !== own);
    await expect(enumerateMetaFolder(server, META, metaReadBudget(), { keep: isClaim, probe })).resolves.toMatchObject({ probe: "absent" });
  });

  it("a renumbering during the read refuses `generation_moved`; a steady one admits", async () => {
    const server = folder();
    server.seed(META, CLAIM);
    await selected(server);
    const renumbering: MetaEnumClient = {
      get mailbox() { return server.mailbox; },
      status: (p, q) => server.status!(p, q),
      fetch: (range, query, options) => {
        const rows = server.fetch(range, query, options);
        return (async function* () {
          for await (const r of rows) yield r;
          server.tree.get(META)!.uidValidity += 1;
        })();
      },
    };
    expect((await refusal(enumerateMetaFolder(renumbering, META, metaReadBudget(), { keep: isClaim }))).code).toBe("generation_moved");
    await expect(enumerateMetaFolder(server, META, metaReadBudget(), { keep: isClaim })).resolves.toMatchObject({ total: 1 });
  });
});
