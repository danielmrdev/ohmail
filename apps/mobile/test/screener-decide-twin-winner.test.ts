import { describe, expect, it } from "vitest";
import { consentIndex, decidedDestination, rulesList } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveMessage, liveScreener, presentedOf, type WorldView } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/**
 * THE PHONE'S DECIDE BESIDE AN OUTRANKING TWIN (SCREENER-DECIDE-PROMOTES-BESIDE-AN-OUTRANKING-TWIN),
 * on the real wire. Mail waits at the gate and a deny rule for the sender was written meanwhile,
 * so the row presents in Screened. Admitting the sender, from the sheet or from the Screener's
 * own row, must leave no twin screening them: while the decide is in flight and after it lands.
 */
const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};
const ADDR = "sender@fake.test";
const view: WorldView = { now: new Date("2026-08-19T10:00:00Z"), zone: "UTC" };

async function scene(rules: Array<[string, string]>) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  for (const [id, dest] of rules) fake.addRule(ruleDto(id, "sender", ADDR, dest));
  fake.addMessage(dto("m1", { subject: "Held", folder: "ohmail/Screener" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const actions = liveActions({ engine: boot.engine, toast: (m) => void sayArg(m), uuid: deps.uuid, zone: "UTC" });
  const presented = () => liveMessage(boot.engine, "m1", { now: view.now, zone: "UTC" })!.presentedFolder;
  const decided = () => decidedDestination(consentIndex(rulesList(boot.engine.read())), ADDR);
  const close = () => { boot.store.close(); fake.server.close(); };
  return { fake, boot, actions, presented, decided, close };
}

describe("admitting a held sender beside a deny twin", () => {
  it("before any press the deny decides and the held row presents in Screened", async () => {
    const s = await scene([["r-deny", "ohmail/Screened"]]);
    expect(s.decided()).toBe("ohmail/Screened");
    expect(s.presented()).toBe("ohmail/Screened");
    s.close();
  });

  it("from the sheet: in flight the row presents in the Ohbox, and after it lands no twin screens them", async () => {
    const s = await scene([["r-allow", "INBOX"], ["r-deny", "ohmail/Screened"]]);
    const answer = s.fake.holdNext("POST", "/screener/");
    const pressed = s.actions.screenSender("m1", "ohbox", "sender");
    await new Promise((r) => { setTimeout(r, 20); });
    expect(s.presented(), "the overlay presented the admitted mail where the deny files it").toBe("INBOX");
    answer();
    expect(await pressed).toBe(true);
    await s.boot.engine.syncOnce();
    expect(s.fake.rule("r-deny")?.destination).toBe("INBOX");
    expect(s.decided()).toBe("INBOX");
    expect(s.presented()).toBe("INBOX");
    s.close();
  });

  it("from the Screener's own row: the same decide, the same answer", async () => {
    const s = await scene([["r-deny", "ohmail/Screened"]]);
    const shelf = liveScreener(presentedOf(s.boot.engine.read(), view.now), view);
    const row = [...shelf.waiting, ...shelf.screened].find((r) => r.address === ADDR);
    expect(row, "the held sender is on no shelf").toBeTruthy();
    const answer = s.fake.holdNext("POST", "/screener/");
    const pressed = s.actions.decide(row!, "ohbox", false, "sender");
    await new Promise((r) => { setTimeout(r, 20); });
    expect(s.presented()).toBe("INBOX");
    answer();
    expect(await pressed).toBe(true);
    await s.boot.engine.syncOnce();
    expect(s.decided()).toBe("INBOX");
    s.close();
  });

  it("the ordinary decide is unchanged: no rule stands, one rule is promoted and the row goes to the Ohbox", async () => {
    const s = await scene([]);
    expect(await s.actions.screenSender("m1", "ohbox", "sender")).toBe(true);
    await s.boot.engine.syncOnce();
    expect(s.decided()).toBe("INBOX");
    expect(s.presented()).toBe("INBOX");
    expect(s.fake.seen.filter((r) => r.method === "PATCH")).toEqual([]);
    s.close();
  });
});
