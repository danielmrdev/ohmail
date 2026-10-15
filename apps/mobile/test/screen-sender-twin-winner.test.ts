import { describe, expect, it } from "vitest";
import { consentIndex, decidedDestination, rulesList } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveMessage, type LiveWorldActions } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/**
 * THE PHONE'S SCREENING SHEET OVER A SENDER'S RULE TWINS — the web sheet's probe on the real wire
 * (SENDER-SHEET-ALREADY-OVER-AN-OUTRANKING-TWIN). An allow into the Ohbox and a deny into Screened
 * for one address: the deny wins under `compareRules`, so the row presents in Screened. Pressing
 * Ohbox must leave no twin screening them; the verdict is the rule the mirror reads afterwards and
 * the place the row presents, never the wire alone.
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

async function scene(rules: Array<[string, string]>, others: Array<[string, string, string]> = []) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  for (const [id, dest] of rules) fake.addRule(ruleDto(id, "sender", ADDR, dest));
  for (const [id, match, dest] of others) fake.addRule(ruleDto(id, "sender", match, dest));
  fake.addMessage(dto("m1", { subject: "Welcome", folder: "INBOX" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m) => void sayArg(m), uuid: deps.uuid, zone: "UTC",
  });
  const presented = () => liveMessage(boot.engine, "m1", { now: new Date("2026-08-19T10:00:00Z"), zone: "UTC" })!.presentedFolder;
  const decided = () => decidedDestination(consentIndex(rulesList(boot.engine.read())), ADDR);
  const patches = (id: string) => fake.seen.filter((r) => r.method === "PATCH" && r.url === `/rules/${id}`)
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);
  const posts = () => fake.seen.filter((r) => r.method === "POST" && r.url === "/rules")
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);
  const close = () => { boot.store.close(); fake.server.close(); };
  return { actions, presented, decided, patches, posts, close };
}

describe("the phone's sheet over an allow twin and an outranking deny twin", () => {
  it("before any press the deny twin decides and the row presents in Screened", async () => {
    const s = await scene([["r-allow", "INBOX"], ["r-deny", "ohmail/Screened"]]);
    expect(s.decided()).toBe("ohmail/Screened");
    expect(s.presented()).toBe("ohmail/Screened");
    s.close();
  });

  it("pressing Ohbox retargets the deny twin, and the sender's mail files into the Ohbox", async () => {
    const s = await scene([["r-allow", "INBOX"], ["r-deny", "ohmail/Screened"]]);
    expect(await s.actions.screenSender("m1", "ohbox", "sender")).toBe(true);
    expect(s.patches("r-deny")).toEqual([{ destination: "INBOX", applyRetro: true }]);
    expect(s.decided()).toBe("INBOX");
    expect(s.presented()).toBe("INBOX");
    s.close();
  });

  it("with the past-mail switch off the deny twin is still retargeted, and the allow twin is left alone", async () => {
    const s = await scene([["r-allow", "INBOX"], ["r-deny", "ohmail/Screened"]]);
    expect(await s.actions.screenSender("m1", "ohbox", "sender", false)).toBe(true);
    expect(s.patches("r-deny")).toEqual([{ destination: "INBOX", applyRetro: false }]);
    expect(s.patches("r-allow")).toEqual([]);
    expect(s.decided()).toBe("INBOX");
    s.close();
  });

  it("Screen out over the same pair is one PATCH over the deny, which retires the allow twin", async () => {
    const s = await scene([["r-allow", "INBOX"], ["r-deny", "ohmail/Screened"]]);
    expect(await s.actions.screenSender("m1", "screened", "sender")).toBe(true);
    // The route converges the key onto the PATCHed row: a second PATCH would name a row it deleted.
    expect(s.patches("r-deny")).toEqual([{ destination: "ohmail/Screened", applyRetro: true }]);
    expect(s.patches("r-allow")).toEqual([]);
    expect(s.decided()).toBe("ohmail/Screened");
    s.close();
  });

  it("another address's rule is no twin — only this sender's rules are written", async () => {
    const s = await scene([["r-deny", "ohmail/Screened"]], [["r-other", "other@fake.test", "ohmail/Screened"]]);
    expect(await s.actions.screenSender("m1", "ohbox", "sender")).toBe(true);
    expect(s.patches("r-deny")).toHaveLength(1);
    expect(s.patches("r-other")).toEqual([]);
    s.close();
  });

  it("an address rule spelled like the domain is no twin of a domain press — the kind decides", async () => {
    const s = await scene([], [["r-odd", "fake.test", "ohmail/Screened"]]);
    expect(await s.actions.screenSender("m1", "ohbox", "domain")).toBe(true);
    expect(s.patches("r-odd")).toEqual([]);
    const posts = s.posts();
    expect(posts).toEqual([expect.objectContaining({ kind: "domain", match: "fake.test", destination: "INBOX" })]);
    s.close();
  });

  it("the ordinary one-rule case is unchanged: a rule already there is re-armed, nothing else", async () => {
    const s = await scene([["r-allow", "INBOX"]]);
    expect(await s.actions.screenSender("m1", "ohbox", "sender")).toBe(true);
    expect(s.patches("r-allow")).toEqual([{ destination: "INBOX", applyRetro: true }]);
    expect(s.decided()).toBe("INBOX");
    s.close();
  });
});
