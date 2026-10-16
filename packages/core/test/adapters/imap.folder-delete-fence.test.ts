import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * ═══ A FOLDER IS DELETED ONLY AGAINST THE STATE THE SWEEP LEFT ═════════════════════════════
 *
 * IMAP's DELETE takes a folder's messages with it. The delete ceremony sweeps everything to
 * Trash first, so by the time DELETE is issued there is nothing to lose — unless a message
 * arrived in the meantime. Emptiness was read by STATUS on the mailbox the sweep had just left
 * SELECTED, which is the one place RFC 3501 §6.3.10 says not to ask ("the STATUS command SHOULD
 * NOT be used on the currently selected mailbox" — the server may answer from the state it has
 * already reported). A server that does exactly that reports 0 while a message another client
 * filed a moment ago sits in the folder, and the DELETE takes it: not in Trash, not in the
 * mirror, gone from the server. The mailbox is the master, so nothing restores it.
 *
 * The fence: the sweep ends by EXAMINING its own folder and reporting what it left (EXISTS, and
 * HIGHESTMODSEQ where the server has CONDSTORE); the DELETE re-examines immediately before
 * issuing and goes ahead only on EXISTS 0 with the modseq unchanged. Anything else refuses.
 *
 * ## Why a fake server here and GreenMail next door
 *
 * The interleaving GreenMail CAN do — a second client appends between the sweep and the check —
 * is `imap.folder-delete-fence.greenmail.test.ts`, and it is the arm that proves the product
 * fact against a real server. What GreenMail cannot do is answer a stale STATUS, have CONDSTORE
 * (it has none), refuse an EXAMINE, or move a modseq without leaving a message behind, so the
 * rest is driven at the client seam with a real `ImapAdapter` on this side of it.
 *
 * ## Mutations watched red and restored (`cmp` against a pristine copy)
 *
 *  · `if (now.exists > 0) return "not_empty"` → never ⇒ the first case red on the MESSAGE, not
 *    on a return value: the folder is gone from the server's map.
 *  · the modseq comparison → never ⇒ the CONDSTORE case red.
 *  · `if (fence === null) return "unverified"` → a fabricated empty fence ⇒ the fail-closed case
 *    red on a DELETE issued against nothing.
 *  · `folderFence`'s EXAMINE → `this.client.mailbox` (the reading as a memory) ⇒ three cases
 *    red, the positive control among them. The first case stays green there, and the reason is
 *    worth keeping: a stale fence over-refuses, which loses no mail. The direction that loses
 *    mail is the first mutation, and that one is red.
 */

const cfg: ImapConfig = {
  host: "127.0.0.1", port: 143, secure: false,
  auth: { user: "u@x.test", pass: "p" }, sentDomain: "x.test",
};

/**
 * A small IMAP server: it holds folders and message counts, it moves mail, and it deletes a
 * folder WITH WHATEVER IS IN IT — the server behaviour the fence exists to stay ahead of, so the
 * fake reproduces it exactly rather than refusing a non-empty DELETE.
 *
 * Two behaviours are modelled because the adapter's correctness turns on them:
 *  · `cachedStatus` — STATUS on the CURRENTLY SELECTED mailbox answers the count as of that
 *    SELECT. RFC 3501 §6.3.10 permits it, which is why it says not to ask there.
 *  · imapflow's mailbox-lock FAST PATH: an already-open mailbox in the same access mode is
 *    handed back with no new SELECT. That is why the fence cannot be read off `client.mailbox`
 *    — there the count would be a memory, not a reading.
 */
function folderServer(o: { condstore?: boolean; refuseExamine?: boolean; cachedStatus?: boolean } = {}) {
  const folders = new Map<string, { exists: number; modseq: bigint }>([
    ["INBOX", { exists: 0, modseq: 10n }],
    ["Proj", { exists: 2, modseq: 20n }],
    ["Trash", { exists: 0, modseq: 30n }],
  ]);
  /** Every command the adapter put on the wire, in order — the ORDER is half of what is proved. */
  const wire: string[] = [];
  /** What the last SELECT/EXAMINE reported, which is what a cached STATUS keeps answering. */
  let reported: { path: string; exists: number } | undefined;
  const open = (path: string, readOnly: boolean) => {
    if (readOnly && o.refuseExamine === true) throw new Error("NO [SERVERBUG] cannot examine");
    const f = folders.get(path);
    if (f === undefined) throw new Error(`no such mailbox: ${path}`);
    wire.push(`${readOnly ? "examine" : "select"}:${path}`);
    const mb = {
      path, readOnly, exists: f.exists, uidNext: f.exists + 1, uidValidity: 7n,
      ...(o.condstore === true ? { highestModseq: f.modseq } : { noModseq: true }),
    };
    client.mailbox = mb;
    reported = { path, exists: f.exists };
    return mb;
  };
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true]]),
    mailbox: undefined as unknown,
    async list() {
      return [...folders.keys()].map((path) => ({
        path, name: path, delimiter: "/", flags: new Set<string>(),
      }));
    },
    async getMailboxLock(path: string, opts?: { readOnly?: boolean }) {
      const ro = opts?.readOnly === true;
      const held = client.mailbox as { path: string; readOnly: boolean } | undefined;
      if (!(held !== undefined && held.path === path && held.readOnly === ro)) open(path, ro);
      return { path, release() { /* nothing */ } };
    },
    async mailboxOpen(path: string, opts?: { readOnly?: boolean }) {
      return open(path, opts?.readOnly === true);
    },
    async status(path: string) {
      wire.push(`status:${path}`);
      const stale = o.cachedStatus === true && reported !== undefined && reported.path === path;
      return { path, messages: stale ? reported!.exists : (folders.get(path)?.exists ?? 0) };
    },
    async messageMove(_range: string, dst: string) {
      const srcPath = (client.mailbox as { path: string }).path;
      const src = folders.get(srcPath)!;
      const to = folders.get(dst)!;
      wire.push(`move:${srcPath}->${dst}:${src.exists}`);
      to.exists += src.exists;
      to.modseq += 1n;
      src.exists = 0;
      src.modseq += 1n;
      reported = { path: srcPath, exists: 0 };
      return {};
    },
    async mailboxDelete(path: string) {
      wire.push(`delete:${path}`);
      folders.delete(path);            // …and everything in it, exactly like a real server
      return { path };
    },
  };
  return {
    client, wire, folders,
    /** A SECOND CLIENT files a message into `path` — the arrival this fence is about. */
    deliver(path: string) {
      const f = folders.get(path)!;
      f.exists += 1;
      f.modseq += 1n;
    },
    /** A second client's message arrives and leaves again: EXISTS back to 0, modseq moved. */
    touch(path: string) {
      folders.get(path)!.modseq += 2n;
    },
    deletes() {
      return wire.filter((w) => w.startsWith("delete:"));
    },
  };
}

async function connected(server: ReturnType<typeof folderServer>): Promise<ImapAdapter> {
  const a = new ImapAdapter(cfg, { client: server.client as unknown as object });
  await a.connect();
  return a;
}

describe("the folder delete's fence", () => {
  it("a message that arrives after the sweep survives — even where STATUS keeps saying the folder is empty", async () => {
    const s = folderServer({ cachedStatus: true });
    const a = await connected(s);

    const sweep = await a.moveAll("Proj", "Trash", FIXTURE_DOOR);

    // Another client files a message into the folder being emptied. This is the whole defect:
    // the server's STATUS for the still-selected mailbox goes on reporting 0.
    s.deliver("Proj");

    const res = await a.deleteFolder("Proj", sweep.fence, FIXTURE_DOOR);
    // The product fact FIRST, asserted about the SERVER and not about the return value: the
    // folder is still there and it still holds the message.
    expect(s.folders.get("Proj")).toEqual(expect.objectContaining({ exists: 1 }));
    expect(s.deletes()).toEqual([]);
    expect(res).toBe("not_empty");
  });

  it("an ordinary empty folder still deletes — one DELETE, after one re-examination", async () => {
    const s = folderServer();
    const a = await connected(s);

    const sweep = await a.moveAll("Proj", "Trash", FIXTURE_DOOR);
    expect(sweep.moved).toBe(2);
    const res = await a.deleteFolder("Proj", sweep.fence, FIXTURE_DOOR);

    expect(res).toBe("deleted");
    expect(s.folders.has("Proj")).toBe(false);
    // The sweep SELECTs to move, then EXAMINEs to fence; the delete EXAMINEs again and only then
    // issues DELETE. Both readings are EXAMINE, so imapflow's CLOSE-before-DELETE (`commands/
    // delete.js`) cannot expunge anything a late arrival left flagged.
    expect(s.wire).toEqual([
      "select:Proj", "move:Proj->Trash:2", "examine:Proj", "examine:Proj", "delete:Proj",
    ]);
    // STATUS is not how emptiness is read any more — see the file's head.
    expect(s.wire.some((w) => w.startsWith("status:"))).toBe(false);
  });

  it("CONDSTORE: EXISTS 0 is not enough — a modseq that moved since the sweep refuses", async () => {
    const s = folderServer({ condstore: true });
    const a = await connected(s);

    const sweep = await a.moveAll("Proj", "Trash", FIXTURE_DOOR);
    expect(typeof sweep.fence?.modseq).toBe("string");
    // A message arrived after the sweep and another client moved it on. The folder reads empty
    // and is NOT the folder the delete was authorized against. (Nothing else can move an
    // emptied folder's modseq: an APPEND, a STORE and an EXPUNGE all need a message first.)
    s.touch("Proj");

    const res = await a.deleteFolder("Proj", sweep.fence, FIXTURE_DOOR);
    expect(res).toBe("changed");
    expect(s.folders.has("Proj")).toBe(true);
    expect(s.deletes()).toEqual([]);
  });

  it("a server with no CONDSTORE fences on EXISTS alone — and still deletes", async () => {
    const s = folderServer();
    const a = await connected(s);
    const sweep = await a.moveAll("Proj", "Trash", FIXTURE_DOOR);
    expect(sweep.fence?.modseq).toBeNull();
    expect(await a.deleteFolder("Proj", sweep.fence, FIXTURE_DOOR)).toBe("deleted");
  });

  it("fails CLOSED: no fence, or a server that will not answer the re-examination", async () => {
    const s = folderServer();
    const a = await connected(s);
    await a.moveAll("Proj", "Trash", FIXTURE_DOOR);
    // A sweep that never got a reading hands back no fence; the DELETE has nothing to be
    // authorized against, and deleting anyway is the expunge this ceremony forbids.
    expect(await a.deleteFolder("Proj", null, FIXTURE_DOOR)).toBe("unverified");
    expect(s.deletes()).toEqual([]);

    const s2 = folderServer({ refuseExamine: true });
    const a2 = await connected(s2);
    const sweep2 = await a2.moveAll("Proj", "Trash", FIXTURE_DOOR);
    expect(sweep2.moved).toBe(2);          // the sweep itself succeeded; only the reading failed
    expect(sweep2.fence).toBeNull();
    expect(await a2.deleteFolder("Proj", sweep2.fence, FIXTURE_DOOR)).toBe("unverified");
    expect(s2.deletes()).toEqual([]);
  });

  it("a folder another client already removed is 'already' — the fence is never consulted", async () => {
    const s = folderServer();
    const a = await connected(s);
    const sweep = await a.moveAll("Proj", "Trash", FIXTURE_DOOR);
    s.folders.delete("Proj");
    expect(await a.deleteFolder("Proj", sweep.fence, FIXTURE_DOOR)).toBe("already");
    expect(s.deletes()).toEqual([]);
  });
});
