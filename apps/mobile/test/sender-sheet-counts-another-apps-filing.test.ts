/**
 * A MESSAGE ANOTHER MAIL APP FILED IS NOT AT THE RULE'S PLACE — the phone's half of that change
 * After the rule's pass moved what ohmail had filed, the one message another app moved into a
 * folder of the person's own stays there (the wire: INBOX 5, Fixture 1). The sheet asks the
 * server why about every row the lists show away from the rule's place; that one must be among
 * them, and its line names the folder and the reason.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, presentedOf, presentedOptions, type ScreeningPosture } from "../src/state/live";
import { resetLocaleRegisterForTests } from "../src/i18n/locale";
import { stayedRows } from "../src/ui/sender-stayed-lines";
import { ownFolderPlace } from "../src/state/sender-stayed";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };
const FROM = { name: "Shop", address: "news@shop.test" };
const DONE = { requestedAt: "2026-09-30T08:00:00Z", doneAt: "2026-09-30T08:05:00Z" };
const at = (day: number) => new Date(Date.UTC(2026, 8, day, 8, 0)).toISOString();
const mid = (n: number) => `22222222-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const inbox = [1, 2, 3, 4, 5].map(mid);
const fix = mid(6);

afterEach(() => { resetLocaleRegisterForTests(); });

async function scene(withFixture: boolean, putAway = false) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule({ ...ruleDto("r1", "sender", FROM.address, "INBOX"), provenance: "manual", retro: DONE });
  inbox.forEach((id, i) => fake.addMessage(dto(id, { from: FROM, folder: "INBOX", date: at(28 - i), unread: false })));
  if (withFixture) {
    fake.addMessage(dto(fix, { from: FROM, folder: "Fixture", date: at(20), unread: false }));
    fake.setStayed(fix, "filed-elsewhere");
  }
  if (putAway) {
    // A Trash and a Junk copy: put away by the person, so no line names them.
    for (const [id, folder] of [[mid(7), "Trash"], [mid(8), "INBOX/Junk"]] as const) {
      fake.addMessage(dto(id, { from: FROM, folder, date: at(19), unread: false }));
      fake.setStayed(id, "filed-elsewhere");
    }
  }
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const actions = liveActions({ engine: boot.engine, uuid: deps.uuid, zone: "UTC", toast: (m) => void sayArg(m) });
  const close = () => { boot.store.close(); fake.server.close(); };
  return { ...boot, fake, actions, close };
}

describe("the phone's sheet asks about the message another mail app filed", () => {
  it("the Fixture row is asked, and its line names the folder and the reason", async () => {
    const s = await scene(true);
    const ask = s.actions.screeningStayed(inbox[0]!, "sender");
    expect(ask?.ruled).toBe("ohbox");
    expect(ask?.elsewhere.map((e) => e.id)).toEqual([fix]);
    const why = ask ? await s.actions.stayedWhy(ask.elsewhere.map((e) => e.id)) : null;
    expect(stayedRows(ask, why).map((r) => r.text)).toEqual(["1 stays in Fixture: filed in another mail app."]);
    s.close();
  });

  it("Trash and Junk copies are not asked about, beside the Fixture one", async () => {
    const s = await scene(true, true);
    const ask = s.actions.screeningStayed(inbox[0]!, "sender");
    expect(ask?.elsewhere.map((e) => e.id)).toEqual([fix]);
    const why = ask ? await s.actions.stayedWhy(ask.elsewhere.map((e) => e.id)) : null;
    expect(stayedRows(ask, why).map((r) => r.text)).toEqual(["1 stays in Fixture: filed in another mail app."]);
    s.close();
  });

  it("Trash and Junk alone ask nothing", async () => {
    const s = await scene(false, true);
    expect(s.actions.screeningStayed(inbox[0]!, "sender")).toBeNull();
    s.close();
  });

  it("positive control: a sender ohmail filed all of asks nothing", async () => {
    const s = await scene(false);
    expect(s.actions.screeningStayed(inbox[0]!, "sender")).toBeNull();
    s.close();
  });
});

/**
 * H1 and L6 on the phone: the press sentence names one place with its own
 * rows and several places as several (`liveVerdictStillSpread`), and two folders with one leaf
 * are named by their parent on the sheet's lines.
 */
async function folders(extra: Array<[string, string]>, date?: string, windowed = false) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule({ ...ruleDto("r1", "sender", FROM.address, "INBOX"), provenance: "manual", retro: DONE });
  inbox.forEach((id, i) => fake.addMessage(dto(id, { from: FROM, folder: "INBOX", date: at(28 - i), unread: false })));
  extra.forEach(([id, folder], i) => {
    fake.addMessage(dto(id, { from: FROM, folder, date: date ?? at(20 - i), unread: false }));
    fake.setStayed(id, "filed-elsewhere");
  });
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  // `windowed`: the account answered a 60-day window, so the lists put an old letter in History.
  const NOW = new Date("2026-10-02T21:00:00Z");
  const POSTURE: ScreeningPosture = { state: "answered", answer: { dormancyDays: 60, baselineAt: null, scope: "window" } };
  const actions = liveActions({
    engine: boot.engine, uuid: deps.uuid, zone: "UTC", toast: (m) => void said.push(sayArg(m)),
    ...(windowed ? {
      now: () => NOW,
      presented: () => presentedOf(boot.engine.read(), NOW, false, POSTURE),
      presentedOptions: () => presentedOptions(NOW, false, POSTURE),
    } : {}),
  });
  return { actions, said, close: () => { boot.store.close(); fake.server.close(); } };
}

describe("the phone names one place with its rows and several as several", () => {
  it("one in Projects and one in Receipts-2019: the sentence says several places", async () => {
    const s = await folders([[mid(10), "Projects"], [mid(11), "Receipts-2019"]]);
    expect(await s.actions.screenSender(inbox[0]!, "ohbox", "sender", false)).toBe(true);
    expect(s.said.at(-1)).toBe("5 are in Ohbox · 2 are still in several places.");
    s.close();
  });

  it("an old letter the lists put in History: the sentence says History, as the sheet does", async () => {
    const s = await folders([[mid(10), "Fixture"]], "2024-01-05T08:00:00.000Z", true);
    const ask = s.actions.screeningStayed(inbox[0]!, "sender");
    const why = ask ? await s.actions.stayedWhy(ask.elsewhere.map((e) => e.id)) : null;
    expect(stayedRows(ask, why).map((r) => r.text)).toEqual(["1 stays in History: filed in another mail app."]);
    expect(await s.actions.screenSender(inbox[0]!, "ohbox", "sender", false)).toBe(true);
    expect(s.said.at(-1)).toBe("5 are in Ohbox · 1 is still in History.");
    s.close();
  });

  it("two in Projects: the sentence names Projects with those two", async () => {
    const s = await folders([[mid(10), "Projects"], [mid(11), "Projects"]]);
    expect(await s.actions.screenSender(inbox[0]!, "ohbox", "sender", false)).toBe(true);
    expect(s.said.at(-1)).toBe("5 are in Ohbox · 2 are still in Projects.");
    s.close();
  });

  it("one path in two mailboxes is named with each mailbox's label, never its address", () => {
    const ask = { ruled: "ohbox" as const, elsewhere: [
      { id: "a", place: ownFolderPlace("mb-1", "Fixture") }, { id: "b", place: ownFolderPlace("mb-2", "Fixture") },
    ] };
    const why = new Map<string, "filed-elsewhere">([["a", "filed-elsewhere"], ["b", "filed-elsewhere"]]);
    const labels: Record<string, string | null> = { "mb-1": "Work", "mb-2": null };
    expect(stayedRows(ask, why, (id) => labels[id] ?? null).map((r) => r.text)).toEqual([
      "1 stays in Fixture (Work): filed in another mail app.", "1 stays in Fixture: filed in another mail app.",
    ]);
    expect(stayedRows({ ...ask, elsewhere: ask.elsewhere.slice(0, 1) }, why, (id) => labels[id] ?? null).map((r) => r.text))
      .toEqual(["1 stays in Fixture: filed in another mail app."]);
  });

  it("Work/Fixture and Home/Fixture are named by their parent on the sheet's lines", async () => {
    const s = await folders([[mid(10), "Work/Fixture"], [mid(11), "Home/Fixture"]]);
    const ask = s.actions.screeningStayed(inbox[0]!, "sender");
    const why = ask ? await s.actions.stayedWhy(ask.elsewhere.map((e) => e.id)) : null;
    expect(stayedRows(ask, why).map((r) => r.text)).toEqual([
      "1 stays in Work/Fixture: filed in another mail app.", "1 stays in Home/Fixture: filed in another mail app.",
    ]);
    s.close();
  });
});

