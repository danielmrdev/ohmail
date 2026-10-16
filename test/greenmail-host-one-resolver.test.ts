import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { code, DERIVES_IMAP_HOST, HOST_OWNERS, OPENS_IMAP, isGreenmailEdge } from "../scripts/lib/imap-host-own.mjs";

/**
 * ONE PLACE DECIDES WHICH IMAP SERVER A TEST REACHES — `greenmailConfig()`. A file that spells the
 * host or port out again dials the shared GreenMail while the box selector, seeing none of its
 * marker identifiers, can report the file needs no lock: an unlocked run against the fixture every
 * lane shares. This is `pg-url-one-resolver.test.ts`'s sibling for the mail box, and the rule is
 * the same pair — a file that OPENS a client may not DERIVE its own host; one that names a port
 * and opens nothing is fixture data and is admitted.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
/* This census's own fixtures are DATA ABOUT the rule, not a subject of it: the control below spells
   a literal port on purpose, and a census that reddened on its own control could never hold one. */
const SELF = relative(REPO, fileURLToPath(import.meta.url)).replace(/\\/g, "/");
const OPENS: RegExp = OPENS_IMAP;
const DERIVES: RegExp[] = DERIVES_IMAP_HOST;
const strip: (src: string) => string = code;
const owners: ReadonlySet<string> = HOST_OWNERS;
const edge: (spec: string) => boolean = isGreenmailEdge;

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:test|spec)\.tsx?$|^_.*\.tsx?$/.test(e)) out.push(relative(REPO, p));
    }
  };
  walk(join(REPO, "test"));
  for (const group of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(REPO, group))) walk(join(REPO, group, pkg, "test"));
  }
  return out.sort();
}

const FILES = testFiles().map((f) => ({ f, src: strip(readFileSync(join(REPO, f), "utf8")) }));

describe("which IMAP server a test reaches", () => {
  it("has a suite to measure at all", () => {
    expect(FILES.length).toBeGreaterThan(1000);
  });

  it("lets no client-opening test file derive its own GreenMail host or port", () => {
    const offenders = FILES
      .filter(({ f, src }) => f !== SELF && !owners.has(f) && OPENS.test(src) && DERIVES.some((re) => re.test(src)))
      .map(({ f }) => f);
    expect(offenders,
      "these open an IMAP or SMTP client AND spell out the box's host or port: take the config from "
      + "greenmailConfig() in packages/core/test/adapters/_imapenv.ts instead").toEqual([]);
  });

  /* A rule over an empty population measures nothing, so the population is counted — and counted
   * through the RESOLVER, which is the shape the rule is asking every file to have. */
  it("judges a real population — the files that do open a client", () => {
    const opening = FILES.filter(({ src }) => OPENS.test(src));
    expect(opening.length).toBeGreaterThan(3);
    const throughHelper = opening.filter(({ src }) => /\bgreenmailConfig\b/.test(src));
    expect(throughHelper.length).toBeGreaterThan(2);
  });

  it("admits a file that names a port and opens no client", () => {
    const dataOnly = FILES
      .filter(({ f, src }) => f !== SELF && !owners.has(f) && DERIVES.some((re) => re.test(src)) && !OPENS.test(src));
    expect(dataOnly.length).toBeGreaterThanOrEqual(0);
    for (const { f, src } of dataOnly) expect(OPENS.test(src), `${f} opens a client after all`).toBe(false);
  });

  it("keeps the host and port in ONE resolver", () => {
    const resolver = "packages/core/test/adapters/_imapenv.ts";
    expect(owners.has(resolver)).toBe(true);
    const src = strip(readFileSync(join(REPO, resolver), "utf8"));
    /* The checkout's own GreenMail FIRST (`.lane-greenmail.env`), then the environment: the helper
       hands both to the one function that decides, and spells neither port itself. */
    expect(/greenmailEndpoint\(\s*process\.env\s*,\s*readLaneGreenmail\(/.test(src)).toBe(true);
    expect(/process\.env\.IMAP_PORT/.test(src), "the helper decides the port a second time").toBe(false);
    const lib = strip(readFileSync(join(REPO, "scripts/lib/lane-greenmail-env.mjs"), "utf8"));
    for (const v of ["IMAP_HOST", "IMAP_PORT", "SMTP_HOST", "SMTP_PORT"]) {
      expect(new RegExp(`\\benv\\.${v}\\b`).test(lib), `the resolver reads ${v}`).toBe(true);
    }
    /* And reading that variable is a USE of the resolver, never a second one: 20 of the 22 files
       this rule first named do exactly that from a package that cannot import the helper. */
    expect(DERIVES.some((re) => re.test("const h = process.env.IMAP_HOST ?? \"127.0.0.1\";"))).toBe(false);
    /* Everyone else reaches it by the EDGE, and the edge is what the box selector reads. */
    expect(edge("./_imapenv.js")).toBe(true);
    expect(edge("../adapters/_imapenv")).toBe(true);
    expect(edge("./_workerenv.js")).toBe(false);
    expect(edge("imapflow")).toBe(false);
  });

  /* THE POSITIVE CONTROL, both halves in one case so neither can drift from the other: the shape
   * the rule refuses, and the shape it must keep admitting. */
  it("positive control: deriving the port beside an open is refused, taking it from the resolver is not", () => {
    const bad = strip('import { ImapFlow } from "imapflow";\n'
      + 'const c = new ImapFlow({ host: "127.0.0.1", port: 3143 });\n');
    expect(OPENS.test(bad) && DERIVES.some((re) => re.test(bad))).toBe(true);
    const good = strip('import { greenmailConfig } from "./_imapenv.js";\n'
      + 'const c = new ImapFlow(greenmailConfig());\n');
    expect(OPENS.test(good)).toBe(true);
    expect(DERIVES.some((re) => re.test(good))).toBe(false);
    /* And a port in PROSE cannot select a file, which is what stripping comments is for. */
    const prose = strip("// the box answers on 127.0.0.1:3143\nexport const x = 1;\n");
    expect(DERIVES.some((re) => re.test(prose))).toBe(false);
  });
});
