/**
 * dom-serializer 2 (html-to-text's, inside mailparser) imports three escape functions from
 * `entities`; the alias table resolves that one import to the same copy's `lib/escape.js`, so the
 * decode and encode tables nothing here calls leave the artifact. This holds the row to the file it
 * names, proves the narrower module binds the very functions the index re-exports, reads the copy's
 * tables out of both resolutions of the artifact, and serializes a corpus through a probe built
 * under the table against the package as Node loads it, whole.
 */
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import aliases from "../../sidecar/src/phone/aliases.js";
import { REPO, buildPhoneEngine, bundleProbe } from "../scripts/bundle-engine.mjs";

const ROW = "dom-serializer/lib/esm/index.js";
const NAMES = ["encodeXML", "escapeAttribute", "escapeText"];

/** A package's root as `from` resolves it: the directory above its entry holding its manifest. */
function rootOf(from: string, name: string): string {
  let dir = dirname(realpathSync(createRequire(join(from, "noop.js")).resolve(name)));
  while (!existsSync(join(dir, "package.json"))
    || (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name !== name) {
    if (dirname(dir) === dir) throw new Error(`no manifest of ${name} above its entry, from ${from}`);
    dir = dirname(dir);
  }
  return dir;
}
const MAILPARSER = rootOf(join(REPO, "packages", "core"), "mailparser");
const HTML_TO_TEXT = rootOf(MAILPARSER, "html-to-text");
const SERIALIZER = rootOf(HTML_TO_TEXT, "dom-serializer");
const ENTITIES = rootOf(SERIALIZER, "entities");
const PARSER = rootOf(HTML_TO_TEXT, "htmlparser2");
/** Every module of the serializer's copy of entities, as the metafile names inputs. */
const OF_THAT_COPY = (inputs: string[]) =>
  inputs.filter((p) => p.startsWith(`${relative(REPO, ENTITIES)}/`)).sort();

describe("the row", () => {
  it("names the import the serializer's own file writes, and only escape functions cross it", () => {
    const table = aliases.PACKAGE_MODULE_SUBSTITUTES[ROW];
    expect(table).toEqual({ entities: "entities/lib/escape.js" });
    const source = readFileSync(join(SERIALIZER, "lib", "esm", "index.js"), "utf8");
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"entities"/g)];
    expect(imports).toHaveLength(1);
    expect(imports[0][1].split(",").map((s) => s.trim()).filter(Boolean).sort()).toEqual(NAMES);
    expect(source).not.toMatch(/from\s*"entities\//);
  });

  it("the narrower module binds the very functions the package index exports", async () => {
    const index = await import(pathToFileURL(join(ENTITIES, "lib", "esm", "index.js")).href);
    const escape = await import(pathToFileURL(join(ENTITIES, "lib", "esm", "escape.js")).href);
    for (const name of NAMES) {
      expect(typeof index[name], name).toBe("function");
      expect(escape[name], name).toBe(index[name]);
    }
  });
});

describe("the artifact", () => {
  for (const workspaceSources of [false, true]) {
    it(`carries only escape.js of the serializer's entities (${workspaceSources ? "published" : "built"} resolution)`, async () => {
      const { inputs } = await buildPhoneEngine({ write: false, workspaceSources });
      expect(inputs.some((p: string) => p.startsWith(`${relative(REPO, SERIALIZER)}/`))).toBe(true);
      expect(OF_THAT_COPY(inputs)).toEqual([`${relative(REPO, ENTITIES)}/lib/esm/escape.js`]);
    }, 120_000);
  }
});

type Serialize = (html: string, options: Record<string, unknown>) => string;

describe("on a bundle built under the same table", () => {
  let dir = "";
  let probeInputs: string[] = [];
  let phone: Serialize;
  let node: Serialize;
  beforeAll(async () => {
    const entry = (p: string) => JSON.stringify(join(p, "lib", "esm", "index.js"));
    const probe = await bundleProbe(
      `import { render } from ${entry(SERIALIZER)};\n`
      + `import { parseDocument } from ${JSON.stringify(join(PARSER, "dist", "esm", "index.js"))};\n`
      + "export const serialize = (html: string, o: Record<string, unknown>) =>\n"
      + "  render(parseDocument(html, { xmlMode: o.xmlMode === true }), o);\n",
    );
    dir = probe.dir;
    probeInputs = Object.keys((probe.metafile as { inputs: Record<string, unknown> }).inputs);
    phone = (createRequire(import.meta.url)(probe.bundlePath) as { serialize: Serialize }).serialize;
    // The same two packages as Node loads them: the whole of entities behind the serializer.
    const req = createRequire(join(HTML_TO_TEXT, "noop.js"));
    const { render } = req("dom-serializer") as { render: (n: unknown, o: unknown) => string };
    const { parseDocument } = req("htmlparser2") as { parseDocument: (h: string, o: unknown) => unknown };
    node = (html, o) => render(parseDocument(html, { xmlMode: o.xmlMode === true }), o);
  }, 120_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the probe carries the narrower module and none of that copy's tables", () => {
    expect(OF_THAT_COPY(probeInputs)).toEqual([`${relative(REPO, ENTITIES)}/lib/esm/escape.js`]);
  });

  it("serializes every document and option exactly as the whole package does", () => {
    let sweep = "";
    for (let c = 1; c < 0xffff; c += 7) if (c < 0xd800 || c > 0xdfff) sweep += String.fromCharCode(c);
    const corpus = [
      `<p class="a&quot;b" title='x "y" &amp; z'>Tom &amp; Jerry &lt;3 &gt; &nbsp;&copy; &#x27; &#39; &unknown; café \u{1F600}</p>`,
      `<a href="https://example.test/?a=1&b=2&amp;c=3" data-x="&lt;&gt;">link</a><br><img alt="ÿĀ">`,
      "<svg viewBox=\"0 0 1 1\"><foreignObject><div>x</div></foreignObject><clipPath/></svg><math><mi>x</mi></math>",
      "<script>if (a < b && c > d) {}</script><style>a > b { content: \"&amp;\" }</style><!-- c & d --><textarea>&lt;</textarea>",
      `<?xml version="1.0"?><root a="1 &amp; 2"><![CDATA[x < y]]><e/>café</root>`,
      `<div title="${sweep.replace(/"/g, "")}">${sweep.replace(/</g, "")}</div>`,
    ];
    const options: Record<string, unknown>[] = [
      {}, { decodeEntities: false }, { encodeEntities: "utf8" }, { encodeEntities: true }, { encodeEntities: false },
      { xmlMode: true }, { xmlMode: true, decodeEntities: false }, { xmlMode: true, encodeEntities: "utf8" },
      { emptyAttrs: true, selfClosingTags: true },
    ];
    let compared = 0;
    for (const html of corpus) {
      for (const o of options) {
        expect(phone(html, o), `${JSON.stringify(o)} ${html.slice(0, 40)}`).toBe(node(html, o));
        compared++;
      }
    }
    expect(compared).toBe(corpus.length * options.length);
    // The corpus reaches the escaping at all: the whole package's answer differs from its input.
    expect(node(corpus[0], {})).toContain("&amp;");
    expect(node(corpus[0], {})).toMatch(/&#x[0-9a-f]+;|&eacute;|&copy;/i);
  });
});
