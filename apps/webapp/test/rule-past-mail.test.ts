/* @reads: apps/webapp/app/shell/shell-verbs.ts */
/**
 * THE COUNT A RULES-PAGE CHANGE STATES — `rulePastMail` over mirror rows.
 *
 * It must count only mail the router names THIS rule for (a higher rule's mail is not claimed),
 * only mail the pass could move (organized, not set aside, not already there), and answer null
 * for a rule the mirror cannot evaluate.
 */
import { describe, expect, it } from "vitest";
import type { EngineMessage, Folder, RuleDTO } from "@ohmail/client-engine";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rulePastMail, ruleRetarget } from "../app/shell/rule-past-mail";

const rule = (over: Partial<RuleDTO> = {}): RuleDTO => ({
  id: "r-1", kind: "sender", match: "knock@door.test", destination: "ohmail/Screened", priority: 0,
  provenance: "promoted", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-09-12T10:00:00.000Z", updatedAt: "2026-09-12T10:00:00.000Z", ...over,
});

const msg = (id: string, over: Partial<EngineMessage> = {}): EngineMessage => ({
  id, from: { name: "K", address: "knock@door.test" }, to: [], cc: [], subject: "hello", snippet: "",
  date: "2026-09-12T08:00:00.000Z", folder: "ohmail/Screened", flags: [], ...over,
} as unknown as EngineMessage);

describe("rulePastMail", () => {
  const screened = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];

  it("counts the rule's five screened messages for a change to the Ohbox", () => {
    expect(rulePastMail(rule(), [rule()], screened, "INBOX")).toBe(5);
    expect(rulePastMail(rule(), [rule()], screened, null)).toBe(5);
  });

  it("leaves out mail already at the new place, set aside, or outside the organized folders", () => {
    const rows = [
      ...screened,
      msg("there", { folder: "INBOX" }),
      msg("aside", { triage: { state: "parked" } } as unknown as Partial<EngineMessage>),
      msg("own", { folder: "Clients/2026" as Folder }),
    ];
    expect(rulePastMail(rule(), [rule()], rows, "INBOX")).toBe(5);
    // Before a place is chosen, mail already in the Ohbox still matches the rule.
    expect(rulePastMail(rule(), [rule()], rows, null)).toBe(6);
  });

  it("does not claim mail a higher rule decides", () => {
    const own = rule({ id: "r-2", kind: "sender", destination: "ohmail/Receipts", subjectContains: "invoice", priority: 5 });
    const domain = rule({ id: "r-1", kind: "domain", match: "door.test" });
    const rows = [...screened, msg("inv", { subject: "invoice 7", folder: "ohmail/Receipts" })];
    expect(rulePastMail(domain, [domain, own], rows, "INBOX")).toBe(5);
  });

  it("a Change's wire always carries the past-mail answer, and the shell sends that wire", () => {
    expect(ruleRetarget("r-1", "INBOX", true)).toEqual({ kind: "rule_update", ruleId: "r-1", destination: "INBOX", applyRetro: true });
    expect(ruleRetarget("r-1", "INBOX", false)).toMatchObject({ applyRetro: false });
    const verbs = readFileSync(fileURLToPath(new URL("../app/shell/shell-verbs.ts", import.meta.url)), "utf8");
    expect(verbs).toContain("engine.mutate(ruleRetarget(ruleId, destination, applyRetro))");
  });

  it("answers null where the mirror cannot evaluate the rule", () => {
    expect(rulePastMail(rule({ bodyContains: "invoice" }), [rule()], screened, "INBOX")).toBeNull();
    expect(rulePastMail(rule({ kind: "header", match: "list-id:x" }), [rule()], screened, "INBOX")).toBeNull();
  });
});
