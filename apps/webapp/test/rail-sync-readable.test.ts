import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ── THE RAIL'S SYNC SENTENCE IS READABLE, NOT ELLIPSIZED ────────────────────────────────
 *
 * Walked on a live install at 1440×900: the rail's sync line — the ONLY copy of the sentence at
 * desktop width (`sync-notice-one-copy.test.ts` pins that) — rendered as
 * "Filing 1 message on your m…", with the detail line ellipsized too and no title attribute,
 * no expansion, no way to read the rest. A status whose words cannot be read is a status
 * that only says "something", which trains people to ignore the one that matters.
 *
 * The rail form's own header comment argued the opposite of what its CSS did: "the
 * alternative — ellipsising it — is hiding the one part of the sentence that MOVES". The
 * repair makes the CSS agree with the comment: both halves of the sentence WRAP inside the
 * rail column instead of clipping on one line. A wrapped rail line costs vertical space in a
 * column that has it; a clipped one costs the sentence.
 *
 * Asserted against the stylesheet, the way `sync-notice-one-copy.test.ts` is and for the
 * same reason: jsdom applies no author styles, so a mounted SyncBar cannot testify about
 * ellipsis. The declarations are the decision, so the declarations are what is under test.
 * Both assertions were watched red against the pre-fix stylesheet (nowrap + ellipsis on
 * both selectors) — the fix landed after this file.
 */

const CSS_PATH = fileURLToPath(new URL("../app/app.css", import.meta.url));
const CSS = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of one rule, by exact selector, wherever it sits in the sheet. */
function ruleOf(selector: string): string {
  const re = new RegExp(
    `(^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`,
  );
  const m = re.exec(CSS);
  return m ? m[2]! : "";
}
const decl = (rule: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(rule);
  return m ? m[1]!.trim() : null;
};

describe("the rail sync line wraps instead of clipping", () => {
  it("the rules under test exist — otherwise everything below is vacuous", () => {
    expect(ruleOf(".rail-sync .rs-line b"), "the rail title rule is gone from app.css").not.toBe("");
    expect(ruleOf(".rail-sync .rs-num"), "the rail detail rule is gone from app.css").not.toBe("");
  });

  it("the title half — the state's own sentence — carries no nowrap and no ellipsis", () => {
    const rule = ruleOf(".rail-sync .rs-line b");
    expect(decl(rule, "white-space"), '"Filing 1 message on your m…" — the title clips again')
      .not.toBe("nowrap");
    expect(decl(rule, "text-overflow"), "the title is ellipsized in the one place it renders at desktop")
      .not.toBe("ellipsis");
  });

  it("the detail half — the address and the part that moves — wraps too", () => {
    const rule = ruleOf(".rail-sync .rs-num");
    expect(decl(rule, "white-space"), "the volatile half clips — the part of the sentence that moves")
      .not.toBe("nowrap");
    expect(decl(rule, "text-overflow"), "the detail is ellipsized with no expansion anywhere")
      .not.toBe("ellipsis");
  });

  it("long tokens (an address) can still break — wrapping must not become sideways overflow", () => {
    // A mailbox address is one unbreakable token; without a break rule it would widen the
    // 224px rail column instead of wrapping inside it.
    for (const sel of [".rail-sync .rs-line b", ".rail-sync .rs-num"]) {
      expect(decl(ruleOf(sel), "overflow-wrap"), `${sel}: an address overflows the rail sideways`)
        .toBe("anywhere");
    }
  });
});
