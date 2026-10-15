/**
 * MAIL ALREADY IN THE INBOX WHEN THE PHONE CONNECTS STAYS IN THE OHBOX, AND THE PHONE OFFERS TO
 * SCREEN ITS SENDERS, AS THE WEB DOES. The rig corpus's shape: the account wrote to Mara before
 * the connect, and her letter and a stranger's wait in the Inbox with nobody's decision behind
 * them. The offer is the store's `GET /screener/unscreened`; the press is the web's `POST`, and
 * it holds both senders at the gate. The real engine and wire, the phone's own derivations.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveActions, liveOhbox, liveScreener, liveUnscreened, presentedOf, type WorldView,
} from "../src/state/live";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };

const OWNER = { name: "Owner", address: "owner@fake.test" };
const MARA = { name: "Mara Lindqvist", address: "mara@rig-corpus.test" };
const STRANGER = { name: "Nobody Known", address: "nobody@stranger.test" };

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage({
    ...dto("sent-mara", { subject: "Keys", folder: "Sent", from: OWNER, unread: false, date: "2026-08-19T07:00:00Z" }),
    to: [MARA],
  });
  fake.addMessage(dto("plain", { subject: "Plain note", from: MARA, date: "2026-08-19T07:10:00Z" }));
  fake.addMessage(dto("first", { subject: "First contact", from: STRANGER, date: "2026-08-19T07:15:00Z" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  const actions = liveActions({ engine: boot.engine, uuid: deps.uuid, zone: "UTC", toast: (m) => { said.push(sayArg(m)); } });
  /* The world's cadence after a drain: the queue from the store, and the offer beside it. */
  const cadence = async () => {
    await boot.engine.syncOnce();
    await boot.engine.refreshScreenerWaiting();
    await boot.engine.refreshUnscreened();
  };
  const pres = () => presentedOf(boot.engine.read(), view.now);
  const ohboxIds = () => {
    const box = liveOhbox(pres(), view);
    return [...box.resurfaced, ...box.fresh, ...box.seen].map((m) => m.id);
  };
  const waiting = () => liveScreener(pres(), view).waiting.map((r) => r.address).sort();
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, engine: boot.engine, actions, said, cadence, ohboxIds, waiting, close };
}

afterEach(() => { resetLocaleRegisterForTests(); });

describe("the Ohbox offers to screen senders already in the Inbox", () => {
  it("names both senders, and its press holds them in the Screener", async () => {
    const s = await scene();
    try {
      await s.cadence();
      expect(s.ohboxIds(), "the mail in the Inbox at the connect left the Ohbox").toEqual(expect.arrayContaining(["first", "plain"]));
      expect(s.waiting(), "a sender nobody decided about is already held").toEqual([]);
      expect(liveUnscreened(s.engine.read()), "the phone offers nothing over the store's answer").toEqual({
        total: 2, senders: [MARA.address, STRANGER.address],
      });

      expect(await s.actions.screenUnscreened()).toBe(true);
      expect(s.fake.seen.filter((r) => r.method === "POST").map((r) => r.url)).toEqual(["/screener/unscreened"]);
      expect(s.said).toEqual(["Screened 2. Your organizer moves them on the next pass."]);
      expect(liveUnscreened(s.engine.read()), "the offer outlived its press").toBeNull();

      await s.cadence();
      expect(s.waiting(), "the press held nobody").toEqual([MARA.address, STRANGER.address].sort());
      expect(s.ohboxIds(), "held mail stayed in the Ohbox").not.toEqual(expect.arrayContaining(["first"]));
      expect(s.ohboxIds(), "held mail stayed in the Ohbox").not.toEqual(expect.arrayContaining(["plain"]));
    } finally { s.close(); }
  });

  it("says a refused press in the web's words and keeps the offer", async () => {
    setActiveLocale("de");
    const s = await scene();
    try {
      await s.cadence();
      s.fake.failNext("POST", "/screener/unscreened");
      expect(await s.actions.screenUnscreened()).toBe(false);
      expect(s.said).toEqual(["Screenen nicht möglich. Versuch es noch einmal."]);
      expect(liveUnscreened(s.engine.read())?.total).toBe(2);
      expect(s.ohboxIds()).toEqual(expect.arrayContaining(["first", "plain"]));
    } finally { s.close(); }
  });
});
