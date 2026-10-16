import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

/** Node's own modules, which are not packages and are never anybody's dependency. */
const BUILTINS = new Set(builtinModules);

/**
 * import-closure.mjs — EVERY MODULE A PUBLISHED FILE IMPORTS MUST ITSELF BE PUBLISHED. The census reads the
 * shipped bundle and cannot see a TYPE-ONLY import (TypeScript erases those before esbuild records an
 * input); the dangling-reference gate reads prose citations; the deny-list refuses payload paths but says
 * nothing about what files reach for. So a published module could `import type { schema } from
 * "@trafficflow/db/cloud"` and every gate pass while the mirror shipped source that does not compile and
 * names a private module in an import. This reads the imports, about RESOLVABILITY not a blocklist: a
 * specifier is a violation when the file it names is not in the published set (catching the private half, a
 * forgotten file, a never-meant-to-ship package). Both `import` and `import type` count — the type import
 * vanishes at runtime but `tsc` in the mirror must resolve it and the specifier is readable in the text. */

/**
 * `@scope/name` → `{ dir, exports }` for each workspace package, read from the workspace itself.
 *
 * `exports` is carried because a package's SUBPATH IS NOT ITS FILENAME. `@trafficflow/db/mail`
 * resolves through the manifest to `./dist/schema-mail.js`, i.e. `src/schema-mail.ts` — guessing
 * `src/mail` finds nothing and the gate reports a published module as unpublishable. The manifest
 * is the only thing that knows the mapping, so it is read rather than inferred.
 */
export function workspacePackages(root) {
  const map = new Map();
  for (const area of ["packages", "apps"]) {
    const base = path.join(root, area);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const manifest = path.join(base, name, "package.json");
      if (!fs.existsSync(manifest)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (pkg.name) map.set(pkg.name, { dir: `${area}/${name}`, exports: pkg.exports ?? null });
      } catch { /* an unreadable manifest is not this gate's business */ }
    }
  }
  return map;
}

/** The target of an `exports` entry, which may be a string or a conditions object. */
function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    for (const key of ["import", "default", "require", "types"]) {
      const t = exportTarget(entry[key]);
      if (t) return t;
    }
  }
  return null;
}

/**
 * Every module specifier in `src`, from `import`, `export … from`, `import type` and `require`. Two things
 * the obvious pattern gets wrong, both measured. The first shape
 * (`(?:^|\n)\s*(?:import|export)\s[\s\S]*?from…`) reported the published `db` barrel importing the Cloud
 * schema from a file that does not import it: `[\s\S]*?` crosses statement boundaries (a `from`-less
 * `export const` ran on into a doc comment discussing a removed import), and `\s` matches newlines so the
 * anchor drifted. So the gap between keyword and `from` is described POSITIVELY (identifiers, `*`, commas,
 * braces, whitespace, comments), unable to cross `=`/`;`/`:`/quote. Dynamic `await import(<a quoted specifier>)` is matched
 * too (a variable/template specifier is unmatchable — a stated limit). It is a SCAN, not a regex: the
 * positive-clause regex hung the publish gate at full CPU (overlapping lazy alternatives over doc comments — `http-adapter.ts` did not finish in an hour), so comments are skipped DETERMINISTICALLY (a block comment ends at its first terminator, a line comment at its newline) and the walk stops at the first char a clause cannot contain. */

/** What an import/export clause may contain outside a comment: names, punctuation, whitespace. */
const CLAUSE_CHAR = /[A-Za-z0-9_$*,{}\s]/;

/** The index after any run of ECMAScript whitespace at `i`.
 *
 * Horizontal-only (` `/`\t`) was too narrow: a `require(` or `import(` whose specifier sits on
 * the NEXT line — `require(\n  "expo/metro-config"\n)`, legal JavaScript and ordinary formatting
 * in a config file — has a newline between the paren and the string, so the horizontal scanner
 * saw no quote there and returned nothing. The dependency then vanished from the generated
 * manifest with no refusal. This skips at the STRUCTURAL boundaries of a call (after the keyword,
 * after `(`, before `)`), where any whitespace is legal and none of it ends the statement. */
const skipBlanks = (src, i) => {
  while (src[i] === " " || src[i] === "\t" || src[i] === "\n" || src[i] === "\r"
    || src[i] === "\f" || src[i] === "\v") i += 1;
  return i;
};

/**
 * `["']([^"']+)["']` at `i` → the specifier and the index after it, or `null`.
 *
 * The content class excludes both quote characters, so the first quote after the opener is
 * necessarily the closer — there is nothing to search for and nothing to back off from.
 */
function quotedSpecifier(src, i) {
  const q = src[i];
  if (q !== '"' && q !== "'") return null;
  let j = i + 1;
  while (j < src.length && src[j] !== '"' && src[j] !== "'") j += 1;
  if (j >= src.length || j === i + 1) return null; /* unterminated, or empty — `+` wants one char */
  return { spec: src.slice(i + 1, j), end: j + 1 };
}

/**
 * `(?:import|export)\s <clause> from[ \t]*["']…["']` beginning at `i`, or `null`.
 *
 * `from` is tried BEFORE each unit is consumed, which is what the lazy repetition did and what
 * makes `export { from } from "./x.js"` bind to the second one: the first `from` is offered, fails
 * for want of a quote after it, and is then eaten as ordinary clause text.
 */
function fromClause(src, i) {
  let k = i + 6; /* both keywords are six characters long */
  if (!/\s/.test(src[k] ?? "")) return null;
  k += 1;
  while (k < src.length) {
    if (src.startsWith("from", k)) {
      const s = quotedSpecifier(src, skipBlanks(src, k + 4));
      if (s) return s;
    }
    const c = src[k];
    if (c === "/" && src[k + 1] === "*") {
      const close = src.indexOf("*/", k + 2);
      if (close === -1) return null;
      k = close + 2;
      continue;
    }
    if (c === "/" && src[k + 1] === "/") {
      const nl = src.indexOf("\n", k + 2);
      if (nl === -1) return null;
      k = nl; /* `[^\n]*` stops AT the newline, which the clause then consumes as whitespace */
      continue;
    }
    if (!CLAUSE_CHAR.test(c)) return null; /* `;`, `=`, `:`, `(`, a quote — the statement ended */
    k += 1;
  }
  return null;
}

/** `import[ \t]*["']…["']` — a side-effect import. */
const bareImport = (src, i) => quotedSpecifier(src, skipBlanks(src, i + 6));

/** `import[ \t]*\([ \t]*["']…["']` — a dynamic import, wherever in the file it appears. */
function dynamicImport(src, i) {
  const k = skipBlanks(src, i + 6);
  if (src[k] !== "(") return null;
  return quotedSpecifier(src, skipBlanks(src, k + 1));
}

/** `require[ \t]*\([ \t]*["']…["'][ \t]*\)`. */
function requireCall(src, i) {
  const k = skipBlanks(src, i + 7);
  if (src[k] !== "(") return null;
  const s = quotedSpecifier(src, skipBlanks(src, k + 1));
  if (!s) return null;
  const close = skipBlanks(src, s.end);
  return src[close] === ")" ? { spec: s.spec, end: close + 1 } : null;
}

export function specifiersIn(src) {
  const out = [];
  /* `(?:^|\n)[ \t]*` for the two anchored forms: true while everything since the last newline is
   * horizontal whitespace. Tracked as the scan advances rather than searched for backwards. */
  let atStatementStart = true;
  const advance = (from, to) => {
    for (let j = from; j < to; j += 1) {
      atStatementStart = src[j] === "\n" || (atStatementStart && (src[j] === " " || src[j] === "\t"));
    }
  };

  let i = 0;
  while (i < src.length) {
    /* The alternatives in the order the pattern listed them, so the same text matches the same way. */
    let m = null;
    if (src.startsWith("import", i)) {
      if (atStatementStart) m = fromClause(src, i) ?? bareImport(src, i);
      m ??= dynamicImport(src, i);
    } else if (atStatementStart && src.startsWith("export", i)) {
      m = fromClause(src, i);
    } else if (src.startsWith("require", i)) {
      m = requireCall(src, i);
    }
    if (m) {
      out.push(m.spec);
      advance(i, m.end);
      i = m.end;
      continue;
    }
    advance(i, i + 1);
    i += 1;
  }
  return out;
}

/**
 * ONE resolution rule, `(importingFile, specifier) → repo-relative source file | null`. Exported because
 * two callers need the same answer and must not each have their own: the gate below (is a target published?)
 * and the payload's source-closure expansion (what to publish). Two spellings of "which file does this
 * specifier name" would disagree exactly where it is expensive — the expansion omitting a file the gate then
 * refuses, the refusal pointing at nothing decided. `null` means "not an own-workspace module" (a
 * third-party package, or a specifier no static scan can follow), both outside this file's remit.
 */
export function moduleResolver(root, fallbackRoot) {
  /* `fallbackRoot` is a SECOND tree to resolve in, for one caller: the publisher replaying history, whose
   * `root` is a materialized copy of ONE COMMIT'S PAYLOAD, not a whole repository. Two things are missing
   * and each broke a gate: the workspace manifests (without which every `@ohmail/*` specifier resolves to
   * nothing and is judged an undeclared third-party) and every file outside the payload roots, including the
   * private module an aliased stub is published in place of (`apps/webapp/app/api-client.ts`, imported by
   * seven published files and extracted by no payload root). So the commit's own tree is asked FIRST and
   * wins where it answers (making a file deleted since HEAD resolve at the commit that imported it), and the
   * working tree answers for the layout the commit's payload does not carry. Membership is a separate question. */
  const pkgs = new Map([
    ...(fallbackRoot ? workspacePackages(fallbackRoot) : []),
    ...workspacePackages(root),
  ]);

  /**
   * A source FILE that exists, trying the `.js`→`.ts` rewrite TypeScript's ESM output requires.
   *
   * `isFile` rather than `existsSync`, and the difference is not pedantry: `packages/services/src/`
   * holds both `mail.ts` and a `mail/` DIRECTORY. An `existsSync` on the extensionless candidate
   * matches the directory, which can never be a member of the published set, so twenty-nine imports
   * of the published `mail.ts` were reported as unresolvable against a target that is not a module
   * at all. A directory is never what a specifier names here — only `<dir>/index.ts` is — so the
   * bare candidate has to insist on a file.
   */
  const asSource = (p) => {
    const candidates = [
      p.replace(/\.js$/, ".ts"),
      p.replace(/\.js$/, ".tsx"),
      p,
      /* Extensionless, which is how the React tree imports its own modules (`../views/OhboxView`)
       * and how a bundler resolves them. All four suffixes, or the gate reports a file that is
       * published as though it were missing — a false refusal is as bad as a false pass here. */
      `${p}.ts`,
      `${p}.tsx`,
      `${p}/index.ts`,
      `${p}/index.tsx`,
    ];
    const isFileIn = (base, c) => {
      const abs = path.join(base, c);
      return fs.existsSync(abs) && fs.statSync(abs).isFile();
    };
    return candidates.find((c) => isFileIn(root, c))
      ?? (fallbackRoot ? candidates.find((c) => isFileIn(fallbackRoot, c)) ?? null : null);
  };

  return (rel, spec) => {
    /* Relative: resolve against this file's directory. */
    if (spec.startsWith(".")) {
      return asSource(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
    /* A workspace package: resolve the subpath to a source file. A bare package name means its
     * entry barrel. Anything outside the workspace is a third-party dependency. */
    const owner = [...pkgs.keys()]
      .filter((name) => spec === name || spec.startsWith(`${name}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!owner) return null;
    const sub = spec === owner ? "index" : spec.slice(owner.length + 1);
    const { dir, exports } = pkgs.get(owner);
    /* THE MANIFEST FIRST, the naive guess second. An `exports` map may point a subpath at a file
     * with a different name (`./mail` → `./dist/schema-mail.js`), and only the manifest knows.
     * `dist/x.js` is mapped back to `src/x.ts` the same way the engine closure does it: the
     * licence is about source, and the `.js` is a build product that is not in the tree. */
    const declared = exportTarget(exports?.[spec === owner ? "." : `./${sub}`]);
    const fromExports = declared
      ? asSource(`${dir}/${declared.replace(/^\.\//, "").replace("dist/", "src/")}`)
      : null;
    return fromExports ?? asSource(`${dir}/src/${sub}`) ?? asSource(`${dir}/${sub}`);
  };
}

/** The own-workspace source files `text`'s module specifiers name, resolved against `root`. */
export function ownWorkspaceTargets(root, rel, text) {
  const resolve = moduleResolver(root);
  const out = new Set();
  for (const spec of specifiersIn(text)) {
    const target = resolve(rel, spec);
    if (target) out.add(target);          // `null` is third-party, or unfollowable by a static scan
  }
  return [...out];
}

/**
 * Which of `text`'s own-workspace imports an OLDER tree lacks — is this copy LAYDOWN-SAFE? The
 * publisher lays a NEWER copy of a published file over an older commit (SWEPT over the leak,
 * COLLAPSED over the window it predates), sound only while the copy compiles in the tree it lands
 * in. A copy that has since GAINED an import does not: {@link unresolvedImports} then refuses the
 * old commit for a target the tip publishes, which reads as a payload-selection defect and is not.
 * `exists` is the older tree's membership test; resolution is {@link moduleResolver}'s, so this and
 * the gate agree on which file a specifier names. `supplied` is what a COLLAPSED window lays into
 * that tree — git alone refused a target the publish creates a step earlier, blind to the window.
 */
export function laydownViolations({ root, rel, text, exists, supplied }) {
  const resolve = moduleResolver(root);
  /* Frozen and inline: an absent `supplied` must not be a set a later caller can fill in. */
  const laid = supplied ?? Object.freeze(new Set());
  const out = [];
  for (const spec of specifiersIn(text)) {
    const target = resolve(rel, spec);
    if (target && !exists(target) && !laid.has(target)) out.push({ specifier: spec, target });
  }
  return out;
}

/**
 * Which published files import something the published set does not contain.
 * @param {object} o
 * @param {string} o.root       monorepo root
 * @param {(string|{rel:string,src:string})[]} o.files  the published set. An entry may be a repo-relative
 *   path, or a `{rel, src}` pair when the file PUBLISHED at `rel` is copied from a different source (the
 *   aliased stubs) — reading `rel` for those would read the monorepo's own file at that path, the private
 *   module the stub replaces.
 * @param {(rel:string)=>boolean} [o.isPublished] membership test (defaults to the set above)
 * @returns {{ file: string, specifier: string, resolved: string|null }[]} */
export function unresolvedImports({ root, fallbackRoot, files, isPublished, generated }) {
  const entries = files.map((f) => (typeof f === "string" ? { rel: f, src: f } : f));
  const published = new Set(entries.map((e) => e.rel));
  const inSet = isPublished ?? ((rel) => published.has(rel));
  const resolve = moduleResolver(root, fallbackRoot);
  const violations = [];

  /**
   * BUILD PRODUCTS: satisfied by their GENERATOR being published, never by being listed. A published file
   * may import a module the mirror BUILDS rather than carries (the phone app requires its pre-bundled mail
   * engine that way): the module is genuinely absent and must stay absent (the output of corresponding
   * source, not corresponding source), so the gate's plain question answers "missing" for a correct state.
   * Not an exemption: what satisfies the import is the PRODUCER being in the published set, checked every
   * run — publish the importer and drop the generator's row and it is a refusal again. The lookup is on the
   * NOMINAL target computed without asking the filesystem, because the artifact exists only in a
   * developer's tree and resolving first would make the arm fire only on the machine that just built it.
   */
  const producerOf = new Map((generated ?? []).map((g) => [g.path, g.generator]));
  const nominal = (rel, spec) => (spec.startsWith(".")
    ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
    : spec);
  const builtHere = (rel, spec, resolved) => {
    for (const key of [resolved, nominal(rel, spec)]) {
      if (key && producerOf.has(key)) return inSet(producerOf.get(key));
    }
    return false;
  };

  for (const { rel, src: from } of entries) {
    if (!/\.(ts|tsx|mjs|js)$/.test(rel)) continue;
    let src;
    try {
      src = fs.readFileSync(path.isAbsolute(from) ? from : path.join(root, from), "utf8");
    } catch {
      continue;
    }
    for (const spec of specifiersIn(src)) {
      /* `null` is a third-party package, and {@link undeclaredDependencies} is what makes it
       * somebody's business — this loop is about files, that one is about the published manifest.
       * A relative specifier that resolves to nothing is a different matter and IS reported: the
       * file it names is missing from the tree entirely. */
      const resolved = resolve(rel, spec);
      if (!resolved && !spec.startsWith(".")) continue;
      if (!resolved || !inSet(resolved)) {
        if (builtHere(rel, spec, resolved)) continue;
        violations.push({ file: rel, specifier: spec, resolved });
      }
    }
  }
  return violations;
}

/** The specifier {@link undeclaredDependencies} reports when the manifest does not parse. */
export const UNREADABLE_MANIFEST = "(unreadable manifest)";

/**
 * JSONC as tsc reads it — comments and trailing commas — made JSON in ONE left-to-right pass that
 * knows a string, so a `//` or `/*` inside one (a URL in `paths`) stays text. An unterminated block
 * comment is kept as written, so the parse after it refuses rather than reading a truncated file.
 */
export function jsoncToJson(text) {
  let out = "";
  let comma = -1;   // where in `out` a comma waits for a value; dropped if a `}` or `]` comes first
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1; comma = -1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) { out += text.slice(i); break; }
      out += " "; i = end + 2;
    } else {
      if (c === "}" || c === "]") { if (comma !== -1) out = `${out.slice(0, comma)} ${out.slice(comma + 1)}`; comma = -1; }
      else if (c === ",") comma = out.length;
      else if (!/\s/.test(c)) comma = -1;
      out += c; i++;
    }
  }
  return out;
}

/**
 * Which THIRD-PARTY packages the payload imports without the published manifest declaring them. The other
 * half of the same question, and it was missing: {@link unresolvedImports} asks whether a specifier names a
 * FILE the mirror contains, which does not arise for `dompurify` or `@tiptap/react` (npm packages, skipped
 * as "the manifest's business"). Nobody was the manifest's business — the measured cost was a public repo
 * whose CI could run neither `tsc --noEmit` nor `vite build` (four packages imported by published sources,
 * declared nowhere) while the README said to clone and build. So every bare specifier reachable from the
 * payload must be satisfied by the published manifest — OR by the published tsconfig mapping it into
 * `./node_modules/<pkg>` whose package the manifest declares (`next-intl` is pointed at `use-intl`, which is
 * declared). Node builtins are not packages; workspace packages are skipped (the loop above resolves them). @param o `{ root, files, manifest, tsconfig? }` → `{ file, specifier, pkg }[]` */
export function undeclaredDependencies({ root, fallbackRoot, files, manifest, tsconfig }) {
  const entries = files.map((f) => (typeof f === "string" ? { rel: f, src: f } : f));
  /* Both trees, for the reason written on {@link moduleResolver}: a materialized commit carries
   * the manifests of the payload's own workspaces and none of the others, and a workspace package
   * that resolves to nothing here is reported as an undeclared npm dependency. */
  const pkgs = new Map([
    ...(fallbackRoot ? workspacePackages(fallbackRoot) : []),
    ...workspacePackages(root),
  ]);

  /* A manifest is JSON and is parsed as JSON; only the tsconfig is JSONC. A regex strip applied to
   * both took the `//` in a manifest note ("see //deps") for a comment and the walk refused there. */
  const readJson = (rel, toJson = (t) => t) => {
    const where = fallbackRoot && !fs.existsSync(path.join(root, rel)) ? fallbackRoot : root;
    try {
      return JSON.parse(toJson(fs.readFileSync(path.join(where, rel), "utf8")));
    } catch { return null; }
  };

  const pkgJson = readJson(manifest);
  /* A manifest this cannot read is a refusal, not a pass: returning [] here would be the exact
   * shape this gate exists to stop — a check that reports clean because it looked at nothing. */
  if (!pkgJson) return [{ file: manifest, specifier: UNREADABLE_MANIFEST, pkg: manifest }];
  const declared = new Set([
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.devDependencies ?? {}),
  ]);

  /* specifier -> the package its tsconfig `paths` target points into, when that target is this
   * manifest's own node_modules. `["./node_modules/@types/react"]` means the declaration that
   * satisfies `react` is `@types/react`. */
  const aliased = new Map();
  const tsPaths = (tsconfig ? readJson(tsconfig, jsoncToJson)?.compilerOptions?.paths : null) ?? {};
  for (const [spec, targets] of Object.entries(tsPaths)) {
    for (const t of Array.isArray(targets) ? targets : [targets]) {
      const m = /^\.\/node_modules\/(.+)$/.exec(String(t));
      if (!m) continue;
      const seg = m[1].split("/");
      aliased.set(spec, seg[0].startsWith("@") ? `${seg[0]}/${seg[1]}` : seg[0]);
    }
  }

  /** `@scope/name/sub` -> `@scope/name`; `pkg/sub` -> `pkg`. */
  const packageOf = (spec) => {
    const seg = spec.split("/");
    return spec.startsWith("@") ? `${seg[0]}/${seg[1] ?? ""}` : seg[0];
  };

  const seen = new Set();
  const violations = [];
  for (const { rel, src: from } of entries) {
    if (!/\.(ts|tsx|mjs|js)$/.test(rel)) continue;
    let src;
    try {
      src = fs.readFileSync(path.isAbsolute(from) ? from : path.join(root, from), "utf8");
    } catch { continue; }
    for (const spec of specifiersIn(src)) {
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (spec.startsWith("node:") || BUILTINS.has(spec)) continue;
      if ([...pkgs.keys()].some((n) => spec === n || spec.startsWith(`${n}/`))) continue;

      const viaExact = aliased.get(spec);
      const viaPackage = aliased.get(packageOf(spec));
      const pkg = viaExact ?? viaPackage ?? packageOf(spec);
      if (declared.has(pkg)) continue;

      const key = `${rel} ${spec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ file: rel, specifier: spec, pkg });
    }
  }
  return violations;
}
