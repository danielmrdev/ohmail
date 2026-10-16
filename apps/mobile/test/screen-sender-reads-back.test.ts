import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveMessage, type LiveWorldActions } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/**
 * THE PHONE'S SCREENING PRESS, READ BACK FROM THE LIST, on the real wire.
 * The reported shape — a bare rule into the Ohbox and a newer subject rule into News — pressed to
 * the Ohbox: the other mail is shown in the Ohbox and the sentence names the subject rule's row.
 * A higher-priority domain rule into News: the address rule the press writes carries its priority.
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
const TERM = "[Weekly-Digest]";
const NOW = new Date("2026-08-19T10:00:00Z");

async function scene(rules: ReturnType<typeof ruleDto>[]) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  for (const r of rules) fake.addRule(r);
  fake.addMessage(dto("m1", { subject: "Order fulfilled", folder: "INBOX" }));
  fake.addMessage(dto("m2", { subject: `${TERM} week 38`, folder: "INBOX" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m) => void said.push(sayArg(m)), uuid: deps.uuid, zone: "UTC",
  });
  const presented = (id: string) => liveMessage(boot.engine, id, { now: NOW, zone: "UTC" })!.presentedFolder;
  const posts = () => fake.seen.filter((r) => r.method === "POST" && r.url === "/rules")
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);
  const close = () => { boot.store.close(); fake.server.close(); };
  return { actions, presented, posts, said, close };
}

describe("the phone's press into the Ohbox is read back from the list", () => {
  it.each(["ohmail/Reads", "ohmail/News"])("the reported shape, News spelled %s", async (news) => {
    const s = await scene([
      ruleDto("r-bare", "sender", ADDR, "INBOX"),
      { ...ruleDto("r-split", "sender", ADDR, news), subjectContains: TERM, createdAt: "2026-08-19T08:00:00Z" },
      ruleDto("r-domain", "domain", "fake.test", "INBOX"),
    ]);
    expect(await s.actions.screenSender("m1", "ohbox", "sender")).toBe(true);
    // INVERTED by ARCH-R902: m2 was never filed, so it is in the Ohbox with m1 and
    // nothing stays elsewhere; this named the subject rule while it presented m2 in News.
    expect(s.presented("m1")).toBe("INBOX");
    expect(s.presented("m2")).toBe("INBOX");
    expect(s.said.at(-1)).not.toContain("stays in");
    expect(s.said.at(-1)).not.toContain(`»${TERM}«`);
    s.close();
  });

  it("a higher-priority domain rule into News: the press's rule carries its priority", async () => {
    const s = await scene([{ ...ruleDto("r-dom", "domain", "fake.test", "ohmail/News"), priority: 5 }]);
    // INVERTED by ARCH-R902: the domain rule never moved m1, so it is in the Ohbox before the press.
    expect(s.presented("m1")).toBe("INBOX");
    expect(await s.actions.screenSender("m1", "ohbox", "sender")).toBe(true);
    expect(s.posts()).toMatchObject([{ kind: "sender", match: ADDR, destination: "INBOX", priority: 5 }]);
    expect(s.presented("m1")).toBe("INBOX");
    expect(s.said.at(-1)).not.toContain("stay");
    s.close();
  });

  it("a domain press over a subject rule for everyone at the domain: the sentence names the domain's rule", async () => {
    const s = await scene([{ ...ruleDto("r-wide", "domain", "fake.test", "ohmail/News"), subjectContains: TERM }]);
    expect(await s.actions.screenSender("m1", "ohbox", "domain")).toBe(true);
    // INVERTED by ARCH-R902: m2 never filed is in the Ohbox, so no rule is named as keeping it.
    expect(s.presented("m2")).toBe("INBOX");
    expect(s.said.at(-1)).not.toContain(`»${TERM}«`);
    s.close();
  });
});
