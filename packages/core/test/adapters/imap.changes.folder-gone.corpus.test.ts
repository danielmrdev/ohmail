import { describe, expect, it } from "vitest";
import * as imap from "../../src/adapters/imap.js";
import { WATCHED_FOLDERS, type ImapCursor } from "../../src/adapters/imap-types.js";
import { CORPUS, loadShape, recordedLine, replayStatusOfMissing, type ProviderShape } from "./_providershape.js";

/**
 * THE FOLDER-GONE RECONCILE, OVER THE CORPUS. A remembered folder an answered LIST leaves out is asked
 * by name, and STATUS answers through imapflow's own command module over the shape's RECORDED line.
 * Each recorded wording is the server's statement and reaps the letters
 * (`statesMailboxNonexistent`); a NO carrying another code keeps every letter.
 */

interface Mail { uid: number; id: string }
interface FakeFolder { uidValidity: bigint; uidNext: number; modseq: bigint; mails: Mail[] }
const folder = (mails: Mail[], uidValidity = 100n): FakeFolder => ({
  uidValidity, uidNext: Math.max(0, ...mails.map((m) => m.uid)) + 1, modseq: 60n, mails,
});
const watched = (): Record<string, FakeFolder> => Object.fromEntries(WATCHED_FOLDERS.map((f) => [f, folder([])]));
const projects = folder([1, 2, 3].map((uid) => ({ uid, id: `p-${uid}@fixture.invalid` })), 777n);

/** A server holding `folders`; STATUS of any other name is the shape's recorded answer. */
function clientOf(shape: ProviderShape, folders: Record<string, FakeFolder>) {
  const asked: string[] = [];
  const client = {
    capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true]]),
    mailbox: {} as { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number },
    asked,
    _path: "INBOX",
    async list() {
      return Object.keys(folders).map((path) => ({ path, name: path.split("/").pop()!, delimiter: "/", flags: new Set<string>() }));
    },
    async status(path: string, query: unknown) {
      asked.push(path);
      const f = folders[path];
      return f ? { path, messages: f.mails.length } : replayStatusOfMissing(shape, path, query);
    },
    async getMailboxLock(path: string) {
      const f = folders[path];
      if (!f) throw new Error(`no such mailbox ${path}`);
      this._path = path;
      this.mailbox = { path, uidValidity: f.uidValidity, uidNext: f.uidNext, highestModseq: f.modseq, exists: f.mails.length };
      return { path, release() { /* no lock in the fake */ } };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      const f = folders[this._path]!;
      if (options?.changedSince !== undefined) return;
      if (query?.headers) {
        for (const m of f.mails) yield { uid: m.uid, headers: Buffer.from(`Message-ID: <${m.id}>\r\n\r\n`) };
        return;
      }
      const from = Number(String(range).split(":")[0]) || 1;
      for (const [i, m] of f.mails.entries()) if ((options?.uid ? m.uid : i + 1) >= from) yield { uid: m.uid };
    },
  };
  return client;
}

function cursorOf(remembered: Record<string, FakeFolder>): ImapCursor {
  const cursor: ImapCursor = { folders: {} };
  for (const [name, f] of Object.entries(remembered)) {
    cursor.folders[name] = {
      uidValidity: String(f.uidValidity), uidNext: f.uidNext, highestModseq: String(f.modseq),
      known: f.mails.map((m) => ({ uid: m.uid, messageId: m.id, seen: true })),
    };
  }
  return cursor;
}

async function pass(shape: ProviderShape) {
  const client = clientOf(shape, watched());
  const adapter = new imap.ImapAdapter({ host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } }, { client });
  await adapter.connect();
  const batch = await adapter.changesSince(cursorOf({ ...watched(), Projects: projects }));
  const refs = batch.deletes.filter((c) => c.locator.folder === "Projects").map((c) => c.locator.ref).sort();
  return { batch: batch as typeof batch & { foldersGone?: readonly string[] }, refs };
}

/** The same shape with the recorded missing-folder line carrying another RFC 5530 code. */
function withCode(shape: ProviderShape, code: string): ProviderShape {
  const ns = shape.semantics.nonexistent!;
  return { ...shape, semantics: { ...shape.semantics, nonexistent: { ...ns, status: { ...ns.status, code } } } };
}

const measured = CORPUS.map(loadShape);

describe("the replayed STATUS of a missing folder fails the way imapflow fails", () => {
  it("every corpus shape carries a recorded missing-folder answer", () => {
    expect(CORPUS.filter((n) => loadShape(n).semantics.nonexistent === null)).toEqual([]);
  });

  it("the recorded wordings: code-less on GreenMail, Dovecot and Infomaniak, [NONEXISTENT] on Gmail", () => {
    const answer = (n: (typeof CORPUS)[number]) => loadShape(n).semantics.nonexistent!.status;
    expect(answer("greenmail")).toMatchObject({ status: "NO", code: null, text: "STATUS failed. No such mailbox" });
    for (const n of ["dovecot", "infomaniak"] as const) {
      expect(answer(n).code, n).toBeNull();
      expect(answer(n).text.startsWith("Mailbox doesn't exist: {name}"), n).toBe(true);
    }
    expect(answer("gmail")).toMatchObject({ status: "NO", code: "NONEXISTENT" });
  });

  for (const shape of measured) {
    it(`${shape.provider}: a NO then an empty LIST of the name is imapflow's NotFound over the recorded line`, async () => {
      const ns = shape.semantics.nonexistent!;
      const err = await replayStatusOfMissing(shape, "Projects", { messages: true }).then(() => null, (e: unknown) => e);
      type Attr = { type: string; value: string; section?: Array<{ value: string }> };
      const e = err as { code?: string; response?: { responseStatus?: string; response?: { attributes?: Attr[] } } };
      expect(e?.code).toBe("NotFound");
      expect(e.response?.responseStatus).toBe(ns.status.status);
      const attrs = e.response?.response?.attributes ?? [];
      expect(attrs[0]?.section?.[0]?.value ?? null).toBe(ns.status.code);
      const text = attrs.filter((a) => a.type === "TEXT").map((a) => a.value).join(" ");
      expect(text).toBe(ns.status.text.split("{name}").join("Projects"));
      expect(recordedLine(ns.status, "Projects").endsWith(text)).toBe(true);
    });

    it(`${shape.provider}: a NO while LIST still names the folder resolves false, never NotFound`, async () => {
      const named = { ...shape, semantics: { ...shape.semantics, nonexistent: { ...shape.semantics.nonexistent!, listByName: "named" as const } } };
      await expect(replayStatusOfMissing(named, "Projects", { messages: true })).resolves.toBe(false);
    });
  }
});

describe("changesSince over a folder deleted elsewhere", () => {
  for (const shape of measured) {
    it(`${shape.provider}: the recorded wording is the server's statement, and each letter is a delete at its epoch`, async () => {
      const { batch, refs } = await pass(shape);
      expect(batch.foldersGone).toEqual(["Projects"]);
      expect(refs).toEqual(["777:1", "777:2", "777:3"]);
    });

    it(`${shape.provider}: the same wording under [NOPERM] keeps every letter`, async () => {
      const { batch, refs } = await pass(withCode(shape, "NOPERM"));
      expect(batch.foldersGone ?? []).toEqual([]);
      expect(refs).toEqual([]);
    });
  }
});
