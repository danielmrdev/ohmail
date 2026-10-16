import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY SURFACE THAT DRAWS A BODY SUBSCRIBES TO ONE — the web's rule (`derived-stamp-census`), on
 * the phone. The world's lists key on the derived stamp, which ignores bodies, so a surface drawing
 * `body` or `bodyState` must redraw on the body stamp itself (`useBodyStamp`, `useBodies`,
 * `useMessageBody`) or it shows a body that has since landed as still loading. And no list row
 * reads a body: `MailRow` previews the snippet.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = /\buse(BodyStamp|Bodies|MessageBody)\(/;
/** The surfaces that render a message's text, each holding one of the hooks. */
const DRAWERS = ["app/message/[id].tsx", "src/ui/MessageReader.tsx", "app/(tabs)/reads.tsx", "src/ui/SenderDetail.tsx"];
/** Rendered under a drawer, which holds the subscription for it. */
const UNDER_A_DRAWER = new Set(["src/ui/MailBodyFrame.tsx"]);

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((f) => {
    const rel = path.join(dir, f);
    return statSync(path.join(ROOT, rel)).isDirectory() ? files(rel) : rel.endsWith(".tsx") ? [rel] : [];
  });
}
const code = (rel: string) => withoutComments(readFileSync(path.join(ROOT, rel), "utf8"));
/** A mail body drawn in JSX: `{m.body}` / `{h.body}`, or a branch on `bodyState`. */
const DRAWS_BODY = /\{\s*[a-z]\w*\.body\s*\}|\.bodyState\b/;

describe("a body is drawn under its own stamp", () => {
  it("every surface that draws a body holds a body hook", () => {
    const drawing = [...files("app"), ...files("src/ui")].filter((f) => DRAWS_BODY.test(code(f)));
    expect(drawing.length, "the census found no body-drawing surface").toBeGreaterThanOrEqual(4);
    for (const f of drawing) {
      if (UNDER_A_DRAWER.has(f)) continue;
      expect(DRAWERS, `${f} draws a body and is not a known drawer`).toContain(f);
      expect(code(f), `${f} draws a body without subscribing to it`).toMatch(HOOKS);
    }
  });

  it("a list row previews the snippet and never reads a body", () => {
    expect(code("src/ui/MailRow.tsx")).not.toMatch(/\bm\.body\b/);
  });

  it("the census reads a drawer without its hook as the refusal it is", () => {
    const rogue = code("src/ui/MessageReader.tsx").replace(/useBodyStamp\(\);?/g, "");
    expect(DRAWS_BODY.test(rogue)).toBe(true);
    expect(rogue).not.toMatch(HOOKS);
  });
});
