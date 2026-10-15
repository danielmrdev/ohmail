/**
 * ═══ A ROW WITH NO SUBJECT DRAWS NO BLANK LINE ═════════════════════════════════════════════
 *
 * A message with no subject drew an empty line between the sender and the preview, on every
 * posture. The subject line stands only when it carries the subject or an amount, and the row's
 * spoken name skips the empty subject too (it said "Lukas Meier. . 02:24.").
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { rowSubjectLine } from "../src/ui/row-subject";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";

describe("the subject line", () => {
  it("stands for a subject or an amount, never for nothing", () => {
    expect(rowSubjectLine("Lunch?", undefined)).toBe(true);
    expect(rowSubjectLine("", "CHF 12.00")).toBe(true);
    expect(rowSubjectLine("", undefined)).toBe(false);
    expect(rowSubjectLine("   ", "")).toBe(false);
    expect(rowSubjectLine(null, null)).toBe(false);
  });
  it("the row asks before drawing the line, and the line still carries the amount", () => {
    const row = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/MailRow.tsx", import.meta.url)), "utf8"));
    const at = row.indexOf("{rowSubjectLine(m.subject, m.amount) ? (");
    expect(at, "the row draws the subject line unconditionally").toBeGreaterThan(-1);
    const line = row.slice(at, row.indexOf(") : null}", at));
    expect(line).toContain("{m.subject}");
    expect(line).toContain("{m.amount}");
  });
});

describe("the row's spoken name", () => {
  it("skips an empty subject instead of speaking an empty sentence, in both languages", () => {
    expect(EN.mailRowAria("Lukas Meier", "", "02:24", true)).toBe("Lukas Meier. 02:24. Unread.");
    expect(EN.mailRowAria("Lukas Meier", "Dinner", "02:24", false)).toBe("Lukas Meier. Dinner. 02:24.");
    expect(DE.mailRowAria("Lukas Meier", "  ", "02:24", true)).toBe("Lukas Meier. 02:24. Ungelesen.");
  });
});
