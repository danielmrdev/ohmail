import { describe, expect, it } from "vitest";
import { memoryImapServer } from "./_metaworld.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, makeProfileIo, parseProfileMessage, readOrganizerProfile,
  tidyOrganizerProfile, writeOrganizerProfile, type ProfileIo, type RawProfileMessage,
} from "../../src/adapters/organizer-profile.js";

/**
 * ONE SPELLING OF A SETTINGS DOCUMENT'S TIME. The reader orders documents by `updatedAt` taken
 * from the mailbox, and `Date.parse` of anything but the writer's ISO form is the platform's
 * choice, so two installs could pick different current documents: such a document is malformed.
 * The `Date` header is the server's to spell, so it is read as an RFC 5322 instant (`GMT` or a
 * numeric zone); anything else is no date group and the copy is kept. To watch it fail: admit any
 * string `Date.parse` takes in `isWrittenInstant` or `dateSecondOf`.
 */

const PRODUCER = { kind: "local", version: "0.0.0" };
const EMPTY = { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null };
const WRITTEN = "2026-09-28T10:00:00.000Z";

function rawWith(updatedAt: string, installId: string, signature: string | null = null): string {
  const doc = makeProfileDoc({ ...EMPTY, signature }, { updatedAt: new Date(WRITTEN), producer: PRODUCER });
  return formatProfileMessage(doc, { installId })
    .replace(`"updatedAt": "${WRITTEN}"`, `"updatedAt": ${JSON.stringify(updatedAt)}`);
}

class Folder implements ProfileIo {
  messages: RawProfileMessage[] = [];
  removed: unknown[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listProfileMessages(): Promise<RawProfileMessage[]> { return this.messages.map((m) => ({ ...m, generation: 1 })); }
  async appendProfile(raw: string): Promise<void> { this.messages.push({ ref: this.messages.length + 1, raw, generation: 1 }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    this.removed.push(...refs);
    this.messages = this.messages.filter((m) => !refs.includes(m.ref));
  }
}

describe("a settings document's updatedAt is the writer's ISO form or the document is malformed", () => {
  it.each([
    "Mon, 28 Sep 2026 11:00:00 GMT", "2026-09-28 11:00:00", "Sep 28 2026 11:00", "2026-09-28T11:00:00Z",
    "not a date", "",
  ])("%j is malformed", (s) => {
    const r = parseProfileMessage(rawWith(s, "i-a"), 1);
    expect(r !== null && isMalformedProfile(r) ? r.reason : "ok").toBe("updatedAt is not the ISO form ohmail writes");
  });

  it("CONTROL: the writer's own spelling parses", () => {
    const r = parseProfileMessage(rawWith("2026-09-28T11:00:00.000Z", "i-a"), 1);
    expect(r !== null && !isMalformedProfile(r) && r.status === "ok").toBe(true);
  });

  it("a document with an unreadable stamp never wins over a readable one", async () => {
    const io = new Folder();
    io.messages.push({ ref: 1, raw: rawWith("2026-09-28T09:00:00.000Z", "i-a", "iso"), generation: 1 });
    io.messages.push({ ref: 2, raw: rawWith("Mon, 28 Sep 2026 23:00:00 GMT", "i-b", "rfc"), generation: 1 });
    const read = await readOrganizerProfile(io);
    expect(read.state === "found" ? read.installId : read.state).toBe("i-a");
  });
});

describe("a Date header is read as its RFC 5322 instant; any other shape is no date group, and the copy is kept", () => {
  /** Our current document, and an older unreadable copy of ours whose Date header is `date`. */
  async function tidyBeside(date: string): Promise<unknown[]> {
    const io = new Folder();
    io.messages.push({ ref: 1, raw: rawWith("2026-09-28T12:00:00.000Z", "this-install").replace(/^Date: .*$/m, "Date: Mon, 28 Sep 2026 12:00:00 GMT"), generation: 1 });
    const broken = rawWith("2026-09-28T09:00:00.000Z", "this-install")
      .replace(/^Date: .*$/m, `Date: ${date}`).replace(/\{[\s\S]*\}/, "{ not json");
    io.messages.push({ ref: 2, raw: broken, generation: 1 });
    await tidyOrganizerProfile({ io, installId: "this-install", now: new Date("2026-09-28T13:00:00.000Z") });
    return io.removed;
  }

  it("CONTROL: the writer's shape, older than the current one, is removed", async () => {
    expect(await tidyBeside("Mon, 28 Sep 2026 09:00:00 GMT")).toEqual([2]);
  });

  it.each(["Mon, 28 Sep 2026 09:00:00 +0000", "Mon, 28 Sep 2026 09:00:00 -0000", "Mon, 28 Sep 2026 11:00:00 +0200",
    "28 Sep 2026 09:00:00 GMT", "Mon, 28 Sep 2026 09:00 UT"])(
    "%j is the same instant in the server's spelling, and is removed", async (date) => {
      expect(await tidyBeside(date)).toEqual([2]);
    });

  it.each(["Tue, 28 Sep 2026 09:00:00 GMT", "Mon, 28 Sep 2026 09:00:00 EST", "2026-09-28T09:00:00Z", "Mon, 31 Sep 2026 09:00:00 GMT"])(
    "%j is kept", async (date) => {
      expect(await tidyBeside(date)).toEqual([]);
    });
});

/* A SERVER THAT RE-RENDERS `Date` in another RFC 5322 spelling of the same instant: the write reads
   its own copy back by that second, so a one-spelling read answered `append_unreadable` on every
   write, the copies grew, and a stop said "could not be saved". A different instant on the same wall
   clock is never ours. To watch it fail: compare the header's spelling rather than its instant, drop
   the zone offset, or keep a trailing comment, in `dateSecondOf`. */
describe("a server that re-renders the Date header", () => {
  async function writesServedAs(rewrite: (dateLine: string) => string): Promise<{ outcomes: string[]; settings: number }> {
    resetMetaMemos();
    const META = "INBOX.ohmail._meta";
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const raw = makeProfileIo(server, (c: string) => c.replace(/\//g, "."), { installId: "w", mailboxId: "p" });
    const io: ProfileIo = {
      ...raw, listMeta: raw.listMeta?.bind(raw),
      appendProfile: (m: string) => raw.appendProfile(m.replace(/^(Date: .* GMT)(\r?)$/m, (_all, l: string, cr: string) => rewrite(l) + cr)),
    };
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const when = new Date(Date.UTC(2026, 8, 28, 12, i * 20, 0));
      const doc = makeProfileDoc({ ...EMPTY, tagNames: [`t${i}`] }, { updatedAt: when, producer: PRODUCER });
      const r = await writeOrganizerProfile({ io, doc, installId: "w", now: when });
      outcomes.push(r.written ? "written" : r.reason);
    }
    return { outcomes, settings: server.tree.get(META)!.messages.filter((m) => /^X-Ohmail-Profile:/im.test(m.raw)).length };
  }
  /** The same instant as the writer's `GMT` line, at `+0200`. */
  const at0200 = (line: string): string => {
    const t = Date.parse(line.replace(/^Date: /, "")) + 2 * 3600_000;
    return `Date: ${new Date(t).toUTCString().replace(/ GMT$/, " +0200")}`;
  };

  it.each<[string, (l: string) => string]>([
    ["+0000", (l) => l.replace(/ GMT$/, " +0000")],
    ["+0000 (UTC), a trailing comment", (l) => l.replace(/ GMT$/, " +0000 (UTC)")],
    ["the same instant at +0200", at0200],
  ])("served as %s, every write reads back as written and one settings message stays", async (_name, rewrite) => {
    expect(await writesServedAs(rewrite)).toEqual({ outcomes: ["written", "written", "written"], settings: 1 });
  });

  it("a different instant on the same wall clock (+0100) is never read back as ours", async () => {
    const { outcomes } = await writesServedAs((l) => l.replace(/ GMT$/, " +0100"));
    expect(outcomes.filter((o) => o === "written")).toEqual([]);
  });
});
