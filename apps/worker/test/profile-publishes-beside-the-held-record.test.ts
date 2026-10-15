import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, latestProfileFoundMarker, mailboxes, recordProfileImportResolution, tags, type Tx } from "@trafficflow/db";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  formatProfileMessage, makeProfileDoc, profileFingerprint, type OrganizerProfileDoc, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { OrganizerProfileSync } from "../src/profile.js";

/**
 * A NEW ORGANIZER PUBLISHES ITS OWN SETTINGS BESIDE THE ONE IT ASKS ABOUT. Taking over a mailbox
 * whose settings another install left, the organizer holds that document for the person's answer
 * and writes its own beside it; the question stays open across that write (routing and the hold
 * both), a decline keeps both, and an answer lets the new document replace the old. Before, nothing
 * of the new organizer's reached the mailbox until the person answered.
 */

class Folder implements ProfileIo {
  messages: RawProfileMessage[] = [];
  private uid = 1;
  async ensureMetaFolder(): Promise<void> {}
  async listProfileMessages(): Promise<RawProfileMessage[]> { return this.messages.map((m) => ({ ...m, generation: 1 })); }
  async appendProfile(raw: string): Promise<void> { this.messages.push({ ref: this.uid++, raw, generation: 1 }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> { this.messages = this.messages.filter((m) => !refs.includes(m.ref)); }
  writers(): string[] { return this.messages.map((m) => /X-Ohmail-Install-Id: (.+)/.exec(m.raw)?.[1]?.trim() ?? "?").sort(); }
}

const THEIRS = makeProfileDoc({
  screener: [{ address: "friend@elsewhere.example" }], rules: [], notifyRules: [], awayResponder: null,
  tagNames: ["theirs"], signature: null,
}, { updatedAt: new Date("2026-09-10T08:00:00.000Z"), producer: { kind: "local", version: "0.25.1" } });
const THEIRS_RAW = formatProfileMessage(THEIRS, { installId: "w-old" });

async function rig(o: { planted: boolean; theirs?: OrganizerProfileDoc }) {
  const theirs = o.theirs ?? THEIRS;
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "beside" });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@x.test` })
    .returning({ id: mailboxes.id });
  const folder = new Folder();
  if (o.planted) await folder.appendProfile(formatProfileMessage(theirs, { installId: "w-old" }));
  const clock = { at: new Date("2026-09-28T12:00:00.000Z") };
  /** One attachment's sync; a second call is the same install after a restart. */
  const attach = (): OrganizerProfileSync => new OrganizerProfileSync({
    db, accountId, mailboxId: mb!.id, adapter: { profileIo: () => folder } as unknown as MailboxAdapter,
    self: { installId: "w-new", kind: "local" }, producerVersion: "test", flushIntervalMs: 0,
    now: () => clock.at,
  });
  const sync = attach();
  const later = (ms: number): void => { clock.at = new Date(clock.at.getTime() + ms); };
  const decide = (name: string) => db.insert(tags).values({ accountId, name });
  const answer = (decision: "declined" | "replaced") => recordProfileImportResolution(db, {
    accountId, mailboxId: mb!.id, decision, fingerprint: profileFingerprint(theirs),
  });
  return { db, sync, folder, decide, answer, later, attach, accountId, mailboxId: mb!.id };
}

describe("the takeover's own settings reach the mailbox beside the held document", () => {
  it("the first tick holds theirs, writes ours beside it, and the question stays open", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(r.folder.writers()).toEqual(["w-new", "w-old"]);
    expect(r.folder.messages.find((m) => m.raw.includes("w-old"))?.raw, "the held document changed").toBe(THEIRS_RAW);
    expect({ hold: r.sync.importDecisionOpen(), routing: (await r.sync.importHoldNow())?.kind ?? "closed" })
      .toEqual({ hold: true, routing: "document" });

    // The next ticks find the held record by its locator: the hold stands, nothing is pruned.
    await r.decide("more");
    await r.sync.onOrganize();
    await r.sync.onOrganize();
    expect(r.folder.writers()).toEqual(["w-new", "w-old"]);
    expect(r.sync.importDecisionOpen()).toBe(true);
  });

  it("a document that lands after the seed is held and ours is written beside it in the same tick", async () => {
    const r = await rig({ planted: false });
    await r.sync.onOrganize(); // seed: nothing there, an empty store writes nothing
    await r.folder.appendProfile(THEIRS_RAW);
    await r.decide("mine");
    await r.sync.onOrganize();
    expect({ writers: r.folder.writers(), hold: r.sync.importDecisionOpen() })
      .toEqual({ writers: ["w-new", "w-old"], hold: true });
  });

  it("\"Not now\" keeps both; a replace lets ours stand alone", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    await r.answer("declined");
    for (let i = 0; i < 3; i++) await r.sync.onOrganize();
    expect(r.folder.writers(), "a decline pruned the other install's settings").toEqual(["w-new", "w-old"]);
    await r.answer("replaced");
    // Released, the old document is ordinary residue: the tidy removes it on its own spacing.
    for (let i = 0; i < 3; i++) { r.later(31_000); await r.sync.onOrganize(); }
    expect(r.sync.importDecisionOpen()).toBe(false);
    expect(r.folder.writers()).toEqual(["w-new"]);
  });

  /* THE RELEASE OWES A TIDY AT ONCE. Answered, the other install's document is residue beside
     ours; without the release asking for a tidy it waited out the tidy's spacing (30 s) in the
     mailbox. The clock does not move here, so only the release can be what removes it. To watch
     it fail: drop the `tidyOwed` line from `commitNextHold`. */
  it("an answer's release lets the next tick remove the other install's document, with no wait", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(r.folder.writers(), "premise: published beside the held document").toEqual(["w-new", "w-old"]);
    await r.answer("replaced");
    await r.sync.onOrganize(); // the release
    await r.sync.onOrganize(); // the tidy it owes
    expect({ hold: r.sync.importDecisionOpen(), writers: r.folder.writers() }).toEqual({ hold: false, writers: ["w-new"] });
  });

  /* AN ANSWERED DOCUMENT GOES WHATEVER ITS AGE. Written a minute before ours, the other install's
     document is too fresh for the tidy's ten-minute rule, and a replace wrote nothing new of ours:
     the answer is the only thing that can remove it. To watch it fail: drop `released` from the
     tidy call in `onOrganize`. */
  it("a replace removes the other install's document written a minute before ours", async () => {
    const fresh = makeProfileDoc({
      screener: [{ address: "friend@elsewhere.example" }], rules: [], notifyRules: [], awayResponder: null,
      tagNames: ["fresh"], signature: null,
    },
      { updatedAt: new Date("2026-09-28T11:59:00.000Z"), producer: { kind: "local", version: "0.25.1" } });
    const r = await rig({ planted: true, theirs: fresh });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(r.folder.writers(), "premise: published beside the held document").toEqual(["w-new", "w-old"]);
    await r.answer("replaced");
    for (let i = 0; i < 3; i++) { r.later(31_000); await r.sync.onOrganize(); }
    expect({ hold: r.sync.importDecisionOpen(), writers: r.folder.writers() }).toEqual({ hold: false, writers: ["w-new"] });
  });

  /* THE RESTART SHAPE. Our own document is the folder's newest now, and the held one sits beside
     it: the seed and the preflight re-arm the question from the durable marker, which names it,
     rather than reading our own document as the answer and lapsing it. To watch it fail: drop
     `markerQuestion` from the preflight and the seed in `profile.ts`. */
  it("a restart while the question stands re-arms it, keeps the held document and keeps the question open", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    expect(r.folder.writers(), "premise: published beside the held document").toEqual(["w-new", "w-old"]);
    const again = r.attach();
    await again.armHoldFromFolder();
    for (let i = 0; i < 3; i++) { r.later(31_000); await again.onOrganize(); }
    const marker = await latestProfileFoundMarker(r.db, r.accountId, r.mailboxId);
    expect({
      hold: again.importDecisionOpen(),
      routing: (await again.importHoldNow())?.kind ?? "closed",
      writers: r.folder.writers(),
      held: r.folder.messages.find((m) => m.raw.includes("w-old"))?.raw === THEIRS_RAW,
      marker: marker === null ? null : [marker.state, marker.heldForImport],
    }).toEqual({ hold: true, routing: "document", writers: ["w-new", "w-old"], held: true, marker: ["found", true] });
  });

  it("the held document removed by hand lapses the question on the next tick", async () => {
    const r = await rig({ planted: true });
    await r.decide("mine");
    await r.sync.onOrganize();
    r.folder.messages = r.folder.messages.filter((m) => !m.raw.includes("w-old"));
    await r.sync.onOrganize();
    expect({ hold: r.sync.importDecisionOpen(), writers: r.folder.writers() }).toEqual({ hold: false, writers: ["w-new"] });
  });
});
