/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE CONSENT DOOR'S MEMO LEAVES BY ONE DOOR — every admit clears it
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `refuseIfOrganizedElsewhere` remembers who it last refused a press to, per mailbox, and
 * `runtimes()` reports that holder where the gate has no reason of its own — which is what lets a
 * phone say "Organized by <machine>" the moment a press is refused instead of leaving the
 * free-mailbox sentence and a live Start verb standing over a mailbox somebody else has.
 *
 * The memo is a statement about NOW, so every path that ADMITS a press has to end it. Two do. The
 * hazard is the third: a new admit path is one line, it merges cleanly beside the others, and the
 * state it leaves — a holder named over a mailbox this install has just been admitted to organize,
 * with `organizing` forced false beside it — renders as its own healthy state on the screen the
 * memo exists to fix. A clean merge is exactly how it arrives.
 *
 * So the rule is structural rather than per-case: inside this function, every `return null` that
 * can see a `mailboxId` is preceded by `refusedHolders.delete(mailboxId)` in its own block. The
 * two guards above `const mailboxId` are exempt because there is no mailbox to forget yet — an
 * exemption keyed on the id's own declaration, not on a line number or a phrase.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mobile.ts");
const FN = "const refuseIfOrganizedElsewhere = async (\n    req: Request, press: OrganizePress | null,\n  ): Promise<Response | null> => {";

/** The function's body, by brace depth from its own opening line. A regex over the file would
 *  take `return null` from every other function in a module thousands of lines long. */
function bodyOf(source: string): string {
  const start = source.indexOf(FN);
  if (start < 0) throw new Error("refuseIfOrganizedElsewhere is not in mobile.ts under that spelling");
  let depth = 0;
  for (let i = start + FN.length - 1; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("refuseIfOrganizedElsewhere never closes");
}

/**
 * Every admit that is NOT preceded by the delete, as `line — text`.
 *
 * "Preceded" means IN THE SAME BLOCK, and the nesting is why this is a scan rather than a
 * `lastIndexOf("{")`. The first draft took the nearest opening brace above the return, which for a
 * bare `if (…) return null;` is the brace of a SIBLING block that has already closed — and the
 * sibling above the real insertion point is the admit that does clear the memo. So the draft read
 * its neighbour's delete as this path's own and admitted the exact line it exists to refuse
 * (measured: the control below found 0 where it must find 1). This walks back to the brace that
 * OPENS the return's own block, then keeps only what is at that block's own depth, so a nested
 * block's contents can never stand in for this one's.
 */
function admitsWithoutForgetting(body: string): string[] {
  const idAt = body.indexOf("const mailboxId =");
  if (idAt < 0) throw new Error("the mailbox id is no longer declared under that spelling");
  /** The `{` that opens the block the offset sits in — balanced pairs above it are skipped. */
  const opensBlock = (at: number): number => {
    let depth = 0;
    for (let i = at - 1; i >= 0; i -= 1) {
      if (body[i] === "}") depth += 1;
      else if (body[i] === "{") {
        if (depth === 0) return i;
        depth -= 1;
      }
    }
    return 0;
  };
  /** Only the text at this block's OWN depth: nested blocks are dropped whole. */
  const ownScope = (from: number, to: number): string => {
    let depth = 0;
    let kept = "";
    for (let i = from + 1; i < to; i += 1) {
      const ch = body[i]!;
      if (ch === "{") { depth += 1; continue; }
      if (ch === "}") { depth = Math.max(0, depth - 1); continue; }
      if (depth === 0) kept += ch;
    }
    return kept;
  };
  const out: string[] = [];
  const lines = body.split("\n");
  let offset = 0;
  for (const [i, line] of lines.entries()) {
    const at = offset;
    offset += line.length + 1;
    if (!/\breturn null;/.test(line)) continue;
    /* THE TWO GUARDS ABOVE THE ID. There is no mailbox to forget before it is decoded, and the
       exemption is keyed on that declaration rather than on a count or a phrase. */
    if (at < idAt) continue;
    if (!ownScope(opensBlock(at), at).includes("refusedHolders.delete(mailboxId)")) {
      out.push(`${String(i + 1)} — ${line.trim()}`);
    }
  }
  return out;
}

describe("apps/sidecar — the consent door's memo leaves by one door", () => {
  it("clears the memo at every admit that has a mailbox to forget", () => {
    const body = bodyOf(readFileSync(SRC, "utf8"));
    /* THE PREMISE, ASSERTED: a census that found no admits at all would pass for a function that
       had stopped admitting anything, which is the way this kind of check dies silently. */
    expect((body.match(/\breturn null;/g) ?? []).length,
      "the door no longer admits a press on any path — this census has no subject")
      .toBeGreaterThan(2);
    expect((body.match(/refusedHolders\.delete\(mailboxId\)/g) ?? []).length,
      "no admit path ends the memo, so the census would pass by having nothing to compare")
      .toBeGreaterThan(0);
    expect(admitsWithoutForgetting(body),
      "an admit path leaves the last refusal's holder standing: the panel then names a machine "
      + "that does not hold the mailbox, over one this install has just been admitted to organize")
      .toEqual([]);
  });

  /**
   * THE POSITIVE CONTROL, AND IT IS THE SHAPE THAT ACTUALLY ARRIVES.
   *
   * Not a mutation of the file — the line below is the one a second lane adds to this very
   * function to let a phone through to its OWN renewed claim. It merges cleanly beside the two
   * admits that do clear the memo, and on its own it is right. The census has to refuse it.
   */
  it("refuses a new admit path written the way one is actually written", () => {
    const body = bodyOf(readFileSync(SRC, "utf8"));
    /* ROW X'S OWN INSERTION POINT — the comment its line lands above, inside the LOOKED path,
       one statement below the admit that does clear the memo. That adjacency is the whole hazard:
       the delete the new path would be credited with belongs to its neighbour. */
    const anchor = "      /* A HOLDER THE ROW HAD NOT CAUGHT UP WITH.";
    expect(body, "the anchor the control inserts before has moved").toContain(anchor);
    const withNewPath = body.replace(
      anchor,
      "      if (looked.holder.installId === deps.installId) return null;\n" + anchor,
    );
    expect(admitsWithoutForgetting(withNewPath),
      "a new admit path that forgets nothing was admitted by this census")
      .toHaveLength(1);
    /* AND THE SAME PATH WRITTEN WITH THE DELETE IS ADMITTED — a refusal rule that refused both
       forms would just be an ordinary ban on the line. */
    const repaired = body.replace(
      anchor,
      "      if (looked.holder.installId === deps.installId) {\n"
      + "        refusedHolders.delete(mailboxId);\n"
      + "        return null;\n"
      + "      }\n" + anchor,
    );
    expect(admitsWithoutForgetting(repaired),
      "the census refuses the repaired form too, so it bans the path rather than the omission")
      .toEqual([]);
  });
});
