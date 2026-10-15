import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * A VIEW THAT CAN NAME THE MAILBOX IS HANDED THE RESOLVER. `mailboxLabelOf` is optional on every
 * view that takes it, so a shell that never passes it compiles and the view stays silent above
 * one mailbox — the Screener did exactly that for a batch. The set of views is DERIVED: every
 * `*View` the shell renders whose own file declares
 * the prop, so a third view that gains it is asked too.
 */
const APP = resolve(process.cwd(), "apps/webapp/app");
const read = (rel: string): string => readFileSync(resolve(APP, rel), "utf8");

/** Each `<XView …>` in `source`: its tag and what its `mailboxLabelOf` attribute passes, if any. */
function viewsIn(source: string): { tag: string; passes: string | null }[] {
  const sf = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { tag: string; passes: string | null }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (/^[A-Z]\w*View$/.test(tag)) {
        let passes: string | null = null;
        for (const a of node.attributes.properties) {
          if (!ts.isJsxAttribute(a) || a.name.getText(sf) !== "mailboxLabelOf") continue;
          const e = a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
          passes = e ? e.getText(sf) : "";
        }
        out.push({ tag, passes });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const takesTheLabel = (tag: string): boolean => {
  try {
    return /\bmailboxLabelOf\?\s*:/.test(withoutComments(read(`views/${tag}.tsx`)));
  } catch {
    return false;
  }
};

describe("the shell hands the mailbox label to every view that can draw it", () => {
  const rendered = viewsIn(read("shell/AppShell.tsx"));
  const owed = rendered.filter((v) => takesTheLabel(v.tag));

  it("the derived set is the two views that take the prop — never empty", () => {
    expect([...new Set(owed.map((v) => v.tag))].sort()).toEqual(["ReadsView", "ScreenerView"]);
  });

  it("each is passed the shell's one resolver", () => {
    for (const v of owed) expect(v.passes, `<${v.tag}> is rendered without mailboxLabelOf`).toBe("mailboxLabelOf");
  });

  it("…and a render without the attribute is what it refuses", () => {
    const planted = viewsIn("const a = <ScreenerView state={s} />; const b = <ReadsView mailboxLabelOf={mailboxLabelOf} />;");
    expect(planted).toEqual([
      { tag: "ScreenerView", passes: null },
      { tag: "ReadsView", passes: "mailboxLabelOf" },
    ]);
  });
});
