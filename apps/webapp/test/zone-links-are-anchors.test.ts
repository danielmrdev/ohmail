import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isZonePath } from "../routes.mjs";

/**
 * A LINK INTO THE LANDING ZONE IS A PLAIN `<a>`. `next/link` prefetches its target, and a prefetch
 * from a signed-in page tells the separate website deployment that a session is open (`Next-Url`);
 * a soft navigation into another Next app is not one either. So no `next/link` in the app may name
 * a zone path: every one but `/` (the product itself for a session, and `?demo=1` is the demo), and
 * `/` with a landing anchor (`/#pricing`; `#/…` is the app's own route). The website's own groups
 * link among themselves and are not read.
 */

const APP = fileURLToPath(new URL("../app", import.meta.url));
const WEBSITE_GROUPS = new Set(["(marketing)", "(marketing-de)"]);

/** Does this href leave the product for the zone? */
function crossesIntoZone(href: string): boolean {
  const path = href.split(/[?#]/)[0] || "/";
  if (path !== "/") return isZonePath(path);
  const hash = href.indexOf("#");
  return hash >= 0 && !href.slice(hash).startsWith("#/");
}

interface Finding { file: string; line: number; href: string | null }

/** Every `next/link` element's href in one source, `null` where the href is not a literal. */
function nextLinkHrefs(file: string, text: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === "next/link") {
      const name = st.importClause?.name?.text;
      if (name) names.add(name);
    }
  }
  const out: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && names.has(node.tagName.getText(sf))) {
      const attr = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "href");
      const init = attr && ts.isJsxAttribute(attr) ? attr.initializer : undefined;
      let href: string | null = null;
      if (init && ts.isStringLiteral(init)) href = init.text;
      else if (init && ts.isJsxExpression(init) && init.expression
        && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) href = init.expression.text;
      out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, href });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function appSources(dir = APP): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = `${dir}/${name}`;
    if (statSync(abs).isDirectory()) return WEBSITE_GROUPS.has(name) ? [] : appSources(abs);
    return /\.tsx?$/.test(name) ? [abs] : [];
  });
}

describe("no next/link in the app crosses into the landing zone", () => {
  it("every next/link href is readable and none names a zone path", () => {
    const files = appSources();
    const links = files.flatMap((f) => nextLinkHrefs(f.slice(APP.length + 1), readFileSync(f, "utf8")));
    expect(links.length, "the census found no next/link at all").toBeGreaterThan(10);
    const where = (l: Finding) => `${l.file}:${l.line} ${l.href ?? "<not a literal>"}`;
    expect(links.filter((l) => l.href === null).map(where), "an href this census cannot read").toEqual([]);
    expect(links.filter((l) => crossesIntoZone(l.href!)).map(where), "use a plain <a> for a zone path").toEqual([]);
  });

  it("CONTROL: a planted next/link to a zone path is found, by any local name, and the product's own are not", () => {
    const planted = [
      'import Go from "next/link";',
      'export const A = () => <><Go href="/privacy">x</Go><Go className="b" onClick={() => 1} href={"/%70rivacy"} /></>;',
      'export const B = () => <><Go href="/#pricing">p</Go><Go href="/#/first-run">f</Go><Go href="/?demo=1">d</Go></>;',
      'export const C = () => <><Go href="/login">l</Go><Go href={`/landing/a.webp`}>i</Go><Go href={path}>n</Go></>;',
    ].join("\n");
    const found = nextLinkHrefs("planted.tsx", planted);
    expect(found.map((l) => l.href)).toEqual(
      ["/privacy", "/%70rivacy", "/#pricing", "/#/first-run", "/?demo=1", "/login", "/landing/a.webp", null]);
    expect(found.filter((l) => l.href !== null && crossesIntoZone(l.href)).map((l) => l.href))
      .toEqual(["/privacy", "/%70rivacy", "/#pricing", "/landing/a.webp"]);
  });
});
