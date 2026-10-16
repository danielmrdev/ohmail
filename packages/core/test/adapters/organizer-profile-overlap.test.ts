import { describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapServer } from "./_metaworld.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import {
  makeProfileDoc, makeProfileIo, profileFingerprint, profileLocatorOf, readOrganizerProfile, tidyOrganizerProfile,
  writeOrganizerProfile,
  type OrganizerProfileDoc, type ProfileLocator,
} from "../../src/adapters/organizer-profile.js";

/**
 * THE OVERLAP, AT THE SEAM THE PROFILE WRITE CAN DESTROY CONFIGURATION THROUGH. The lease lets the
 * outgoing organizer run one more cycle while the new one publishes beside the document it holds.
 * Driven through the production io on the memory server, both writers interleaved: at every read
 * the folder holds at most the new organizer's copy, the held record and one replaced copy; the new
 * organizer never removes the held record, and neither writer's settings vanish unseen.
 */

const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");
const at = (min: number): Date => new Date(Date.UTC(2026, 8, 28, 12, min, 0));

function doc(tag: string, when: Date): OrganizerProfileDoc {
  return makeProfileDoc({ screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [tag], signature: null },
    { updatedAt: when, producer: { kind: "local", version: "test" } });
}
function settingsIn(server: MemoryImapServer): Array<{ installId: string; tag: string }> {
  return server.tree.get(META)!.messages
    .filter((m) => /^X-Ohmail-Profile:[ \t]*1[ \t]*$/im.test(m.raw.split(/\r?\n\r?\n/, 1)[0] ?? ""))
    .map((m) => ({
      installId: /X-Ohmail-Install-Id: (.+)/.exec(m.raw)?.[1]?.trim() ?? "?",
      // The body spells names as JSON escapes; the string literal is decoded the way JSON reads it.
      tag: ((lit) => (lit === undefined ? "?" : JSON.parse(lit) as string))(/"tagNames": \[\s*("(?:[^"\\]|\\.)*")/.exec(m.raw)?.[1]),
    }));
}

describe("the outgoing organizer's last cycle beside the new organizer's publish", () => {
  it("no read ever finds more than own + held + one replaced copy, and the held record is not the new one's to remove", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const io = (installId: string) => makeProfileIo(server, toServerPath, { installId, mailboxId: "overlap" });
    const oldDoc = doc("old-0", at(0));
    await writeOrganizerProfile({ io: io("w-old"), doc: oldDoc, installId: "w-old", now: at(0) });
    const retain: ProfileLocator = profileLocatorOf("w-old", oldDoc)!;

    const seen: number[] = [];
    const look = (): void => { seen.push(settingsIn(server).length); };
    const oldKnows = new Set<string>();
    const oldWrites = async (tag: string, min: number): Promise<void> => {
      const r = await writeOrganizerProfile({
        io: io("w-old"), doc: doc(tag, at(min)), installId: "w-old", now: at(min), replaceable: [...oldKnows],
      });
      // The outgoing organizer's own rule: a foreign document it has now seen may be superseded next.
      if (!r.written && r.reason === "foreign") oldKnows.add(profileFingerprint(r.doc));
      look();
    };
    const oldCopies = (): string[] => settingsIn(server).filter((c) => c.installId === "w-old").map((c) => c.tag).sort();
    const shrunkByNew: string[] = [];
    const newWrites = async (tag: string, min: number): Promise<void> => {
      const before = oldCopies();
      await writeOrganizerProfile({ io: io("w-new"), doc: doc(tag, at(min)), installId: "w-new", now: at(min), retain });
      const after = oldCopies();
      if (before.some((t) => !after.includes(t))) shrunkByNew.push(`${tag}: ${before.join(",")} -> ${after.join(",")}`);
      look();
    };

    await newWrites("new-1", 1);
    expect(settingsIn(server).map((s) => s.installId).sort(), "the new document was not published beside").toEqual(["w-new", "w-old"]);
    await oldWrites("old-1", 2);   // refused: the new organizer's document is unseen to it
    await newWrites("new-2", 3);
    await oldWrites("old-2", 4);   // it has seen the new one now, and supersedes it (last incumbent wins)
    await newWrites("new-3", 5);   // its held record is gone; the newest foreign refuses it, unseen
    await oldWrites("old-3", 6);

    expect(Math.max(...seen), `settings messages after each write: ${seen.join(",")}`).toBeLessThanOrEqual(3);
    expect(Math.min(...seen), "a write left the folder with no settings at all").toBeGreaterThanOrEqual(1);
    expect(shrunkByNew, "a write of the new organizer removed the outgoing organizer's settings").toEqual([]);
  });

  it("CONTROL: with no overlap the new organizer's writes keep exactly its copy and the held record", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const io = (installId: string) => makeProfileIo(server, toServerPath, { installId, mailboxId: "overlap-control" });
    const oldDoc = doc("old-0", at(0));
    await writeOrganizerProfile({ io: io("w-old"), doc: oldDoc, installId: "w-old", now: at(0) });
    const retain = profileLocatorOf("w-old", oldDoc)!;
    for (let i = 1; i <= 4; i++) {
      await writeOrganizerProfile({ io: io("w-new"), doc: doc(`new-${i}`, at(i)), installId: "w-new", now: at(i), retain });
    }
    expect(settingsIn(server).sort((a, b) => a.installId.localeCompare(b.installId)))
      .toEqual([{ installId: "w-new", tag: "new-4" }, { installId: "w-old", tag: "old-0" }]);
  });
});

/* THE OUTGOING ORGANIZER'S OVERLAP TIDY. Its own document is the record the new organizer holds
   as its question; a tidy that removed it as a superseded own copy, beside a current document it
   had never seen, took the other install's settings out of the mailbox with nobody asked. To watch
   it fail: drop the `cSeen` test from `planTidy`'s own arm. */
describe("the outgoing organizer's tidy beside the new organizer's document", () => {
  async function published() {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const io = (installId: string) => makeProfileIo(server, toServerPath, { installId, mailboxId: "overlap-tidy" });
    const oldDoc = doc("old-0", at(0));
    await writeOrganizerProfile({ io: io("w-old"), doc: oldDoc, installId: "w-old", now: at(0) });
    const newDoc = doc("new-1", at(1));
    await writeOrganizerProfile({ io: io("w-new"), doc: newDoc, installId: "w-new", now: at(1), retain: profileLocatorOf("w-old", oldDoc)! });
    return { server, io, newDoc };
  }

  it("keeps its own document while the new organizer's is unseen to it, and the question stays", async () => {
    const { server, io } = await published();
    const t = await tidyOrganizerProfile({ io: io("w-old"), installId: "w-old", now: at(1) });
    const q = await readOrganizerProfile(io("w-new"), { foreignTo: "w-new" });
    expect({
      removed: t.removed, kept: t.planned?.keptOwnBesideUnseen,
      folder: settingsIn(server).map((s) => s.installId).sort(), question: q.state === "found" ? q.installId : q.state,
    }).toEqual({ removed: 0, kept: 1, folder: ["w-new", "w-old"], question: "w-old" });
  });

  it("CONTROL: once it has seen the new organizer's document, its superseded copy goes as before", async () => {
    const { server, io, newDoc } = await published();
    const t = await tidyOrganizerProfile({ io: io("w-old"), installId: "w-old", now: at(1), replaceable: [profileFingerprint(newDoc)] });
    expect({ removed: t.removed, folder: settingsIn(server).map((s) => s.installId) }).toEqual({ removed: 1, folder: ["w-new"] });
  });
});
