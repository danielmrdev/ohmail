/**
 * A READER'S PILE PRESS WAITS FOR THE ANSWER AND SAYS WHY. A reader does not triage
 * (mail 0083), so the server refuses Later with `organized_elsewhere` — and the phone had already
 * said "Queued in Answer Later · Undo", then "That change could not be saved. Try it again." beside
 * it: a false sentence, and a retry that is refused every time. Over a mailbox the roster says this
 * device only reads, the press is sent first and its sentence follows the answer; any refusal of
 * that kind names the reason, and the holder only where `holderIsLive` reads the roster's row live.
 * Driven through `bootEngine` against the loopback mail server.
 * TO WATCH IT FAIL: drop the `readsOnly` arm of `live.ts#pilePress` (the Queued sentence returns),
 * or make `pileFailed` answer `liveSaveFailed` alone (the reason goes).
 */
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { FOLDER_OF_VIEW } from "@ohmail/client-engine";
import { liveActions, type LiveWorldActions, type ToastOpts } from "../src/state/live";
import { Copy } from "../src/copy";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { CASE_MS } from "./helpers/arrived";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const HOLDER = "ohmail on omarchy";

interface SaidToast extends ToastOpts { say: string }

/** The service's own refusal wire for a reader's triage (`OrganizedElsewhereError`). */
const organizedElsewhere = (name: string | null) => ({
  error: {
    code: "organized_elsewhere",
    message: "another install is organizing this mailbox",
    details: { by: { kind: "local", name, since: "2026-10-13T04:00:00.000Z" } },
  },
});

/** The roster's reader row: the holder, and whether its lease still renews. */
type Roster = { organizedBy: { kind: string | null; name: string | null } | null; organizerState: "held" | "stopped" | null };
const HELD: Roster = { organizedBy: { kind: "local", name: HOLDER }, organizerState: "held" };

async function scene(reader: Roster | null | undefined, extra: (fake: ReturnType<typeof mailServer>) => void = () => undefined) {
  const fake = mailServer();
  fake.addMessage(dto("m1"));
  extra(fake);
  const origin = await listen(fake.server);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: SaidToast[] = [];
  const actions = liveActions({
    engine: boot.engine,
    toast: (m, opts) => toasts.push({ say: sayArg(m), ...(opts ?? {}) }),
    zone: "UTC",
    uuid,
    ...(reader === undefined ? {} : { readsOnly: (mailboxId: string) => (mailboxId === "mb-1" ? reader : null) }),
  });
  const done = (): void => { boot.store.close(); fake.server.close(); };
  return { fake, actions, toasts, done };
}

const said = (toasts: readonly SaidToast[]): string[] => toasts.map((t) => t.say);

describe("a reader's Later is answered, never announced", () => {
  it("refused: one sentence naming why and who organizes, and no Queued toast", async () => {
    const live = await scene(HELD);
    live.fake.answerNext("POST", "/messages/m1/triage", 409, organizedElsewhere(HOLDER));
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(false);
    expect(said(live.toasts)).toEqual([Copy.readerPressRefused(HOLDER)]);
    expect(said(live.toasts), "the phone said Queued before the server answered").not.toContain(Copy.toastQueued);
    live.done();
  }, CASE_MS);

  it("a holder the roster names nothing for: the reader sentence without a name", async () => {
    const live = await scene({ organizedBy: { kind: "local", name: null }, organizerState: "held" });
    live.fake.answerNext("POST", "/messages/m1/triage", 409, organizedElsewhere(HOLDER));
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(false);
    expect(said(live.toasts)).toEqual([Copy.readerPressRefusedUnknown]);
    live.done();
  }, CASE_MS);

  it("a holder whose lease stopped is not named as organizing, whatever the refusal carries", async () => {
    const live = await scene({ organizedBy: { kind: "local", name: HOLDER }, organizerState: "stopped" });
    live.fake.answerNext("POST", "/messages/m1/triage", 409, organizedElsewhere(HOLDER));
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(false);
    expect(said(live.toasts)).toEqual([Copy.readerPressRefusedNobody]);
    live.done();
  }, CASE_MS);

  it("the path beside it: a reader's tag press is answered the same way", async () => {
    const live = await scene(HELD);
    live.fake.answerNext("POST", "/messages/m1/tags", 409, organizedElsewhere(HOLDER));
    expect(await live.actions.tagToggle("m1", { id: "t1", name: "Work", hue: "slate" }, true)).toBe(false);
    expect(said(live.toasts)).toEqual([Copy.readerPressRefused(HOLDER)]);
    live.done();
  }, CASE_MS);

  it("CONTROL: a reader roster the server overrules is told Queued, with Undo, once it landed", async () => {
    const live = await scene(HELD);
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(true);
    expect(said(live.toasts)).toEqual([Copy.toastQueued]);
    expect(live.toasts[0]!.undo, "the answered Later carries no Undo").toBeDefined();
    live.done();
  }, CASE_MS);

  it("CONTROL: an organizer's Later stays optimistic, and a refusal of this kind still says why", async () => {
    const live = await scene(null);
    live.fake.answerNext("POST", "/messages/m1/triage", 409, organizedElsewhere(HOLDER));
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(false);
    expect(said(live.toasts)).toEqual([Copy.toastQueued, Copy.readerPressRefusedUnknown]);
    live.done();
  }, CASE_MS);

  it("a press that only WAITS on a reader is not told Queued: it replays into the same refusal", async () => {
    const live = await scene(HELD);
    live.fake.failNextStatus("POST", "/messages/m1/triage", 500);
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(false);
    expect(said(live.toasts)).toEqual([Copy.readerPressRefused(HOLDER)]);
    live.done();
  }, CASE_MS);

  it("a holder the roster names in no way, still renewing, is not called nobody", async () => {
    const live = await scene({ organizedBy: null, organizerState: "held" });
    live.fake.answerNext("POST", "/messages/m1/triage", 409, organizedElsewhere(null));
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(false);
    expect(said(live.toasts)).toEqual([Copy.readerPressRefusedUnknown]);
    live.done();
  }, CASE_MS);

  it("Done on a booked letter: the read lands, the booking is refused, and the sentence says both", async () => {
    const live = await scene(HELD, (f) => f.addMessage(dto("m2", { triage: { state: "bubbled_up" } })));
    live.fake.answerNext("POST", "/messages/m2/triage", 409, organizedElsewhere(HOLDER));
    expect(await live.actions.resurfaceDone("m2")).toBe(false);
    expect(said(live.toasts)).toEqual([Copy.readerPressReadOnly]);
    live.done();
  }, CASE_MS);

  it("the path beside it: a Screener release on a reader row says the wait, never Released first", async () => {
    const live = await scene(HELD, (f) => {
      f.addRule(ruleDto("r-spam", "sender", "held@fake.test", FOLDER_OF_VIEW.spam));
      f.addMessage({ ...dto("m2", { subject: "Held" }), from: { name: "Held", address: "held@fake.test" }, folder: FOLDER_OF_VIEW.spam });
    });
    live.fake.queueNextForOrganizer("PATCH", "/rules/r-spam", HOLDER);
    live.fake.queueNextForOrganizer("POST", "/messages/m2/move", HOLDER);
    const row = { id: "m2", address: "held@fake.test", held: [{ id: "m2" }] } as Parameters<LiveWorldActions["release"]>[0];
    await live.actions.release(row, "ohbox", "spam");
    expect(said(live.toasts)).toEqual([Copy.pressQueuedForOrganizer(HOLDER)]);
    live.done();
  }, CASE_MS);

  it("CONTROL: any other refusal keeps the could-not-be-saved sentence", async () => {
    const live = await scene(undefined);
    live.fake.failNext("POST", "/messages/m1/triage");
    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(false);
    expect(said(live.toasts)).toEqual([Copy.toastQueued, Copy.liveSaveFailed]);
    live.done();
  }, CASE_MS);
});
