import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { bracketSpan, lineOf, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";

/**
 * EVERY NODEMAILER TRANSPORT AND COMPOSER REFUSES A PATH OR A URL AS MESSAGE CONTENT. nodemailer
 * 8.0.11 is allowed past GHSA-p6gq-j5cr-w38f (a message's `raw` reads a file or a URL in spite of the
 * switches) because our send paths hand it bytes only; this census makes that the code's property
 * rather than a review's. Each `createTransport(` and `new MailComposer(` in product source must set
 * `disableFileAccess: true` and `disableUrlAccess: true` at the top level of an object literal, or call
 * a same-file function whose every returned object literal does. Anything else, a site it cannot
 * resolve included, is refused.
 * Skipped: tests, and `scripts/`, whose QA seeding sends its own literal messages.
 */
const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const PRODUCT = /^(?:apps|packages)\/[^/]+\/src\//;
const KEYS = ["disableFileAccess", "disableUrlAccess"];

/** The keys set to `true` at depth 1 of the object literal opening at `open`. */
function topLevelTrue(code: string, open: number): Set<string> {
  const { start, end } = bracketSpan(code, open, "{", "}");
  const found = new Set<string>();
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    const ch = code[i]!;
    if ("{[(".includes(ch)) depth += 1;
    else if ("}])".includes(ch)) depth -= 1;
    else if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*:\s*true\b/.exec(code.slice(i, i + 64));
      if (m && !/[\w$]/.test(code[i - 1] ?? "")) { found.add(m[1]!); i += m[0].length - 1; }
    }
  }
  return found;
}

export interface TransportSite { at: string; verdict: "ok" | "refused"; why: string }

/** Every `createTransport(` and `new MailComposer(` in one file's source, judged. */
export function transportSites(file: string, src: string): TransportSite[] {
  const code = withoutCommentsAndLiterals(src);
  const out: TransportSite[] = [];
  for (const m of code.matchAll(/\bcreateTransport\s*\(|\bnew\s+MailComposer\s*\(/g)) {
    const at = `${file}:${lineOf(src, m.index!)}`;
    const args = bracketSpan(code, m.index! + m[0].length - 1);
    const arg = code.slice(args.start, args.end).trim();
    const firstBrace = code.indexOf("{", args.start);
    let literals: number[] = [];
    let via = "an object literal";
    if (arg.startsWith("{")) literals = [firstBrace];
    else {
      const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(arg);
      const fn = call && new RegExp(`\\bfunction\\s+${call[1]}\\s*\\(`).exec(code);
      if (!fn) { out.push({ at, verdict: "refused", why: `cannot resolve the options (${arg.slice(0, 40)})` }); continue; }
      via = `${call![1]}()`;
      const params = bracketSpan(code, fn.index + fn[0].length - 1);
      const bodyOpen = code.indexOf("{", params.end);
      const body = bracketSpan(code, bodyOpen, "{", "}");
      for (const r of code.slice(body.start, body.end).matchAll(/\breturn\s*\{/g)) literals.push(body.start + r.index! + r[0].length - 1);
      if (literals.length === 0) { out.push({ at, verdict: "refused", why: `${via} returns no object literal` }); continue; }
    }
    const missing = literals.flatMap((o) => KEYS.filter((k) => !topLevelTrue(code, o).has(k)));
    out.push(missing.length === 0
      ? { at, verdict: "ok", why: `${via} sets both` }
      : { at, verdict: "refused", why: `${via} leaves ${[...new Set(missing)].join(" and ")} unset` });
  }
  return out;
}

describe("every nodemailer transport and composer refuses a path or a URL as message content", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0").filter((f) => f !== "" && CODE.test(f) && PRODUCT.test(f) && !/\.test\.|\.spec\./.test(f));
  const sites = files.flatMap((f) => transportSites(f, readFileSync(f, "utf8")));

  it("reads the product source and finds both transports and the Sent copy's composer", () => {
    expect(files.length).toBeGreaterThan(900);
    const at = sites.map((s) => s.at.replace(/:\d+$/, ""));
    expect(at.filter((f) => f === "packages/core/src/adapters/imap.ts")).toHaveLength(2);
    expect(at).toContain("packages/services/src/mail/smtp-mailer.ts");
  });

  it("refuses no site", () => {
    expect(sites.filter((s) => s.verdict !== "ok")).toEqual([]);
  });

  it("refuses a missing key, an unresolved options value and a nested key; admits both forms", () => {
    const judge = (src: string) => transportSites("planted.ts", src).map((s) => s.verdict);
    expect(judge("createTransport({ host, disableFileAccess: true });")).toEqual(["refused"]);
    expect(judge("createTransport(cfg);")).toEqual(["refused"]);
    expect(judge("createTransport({ tls: { disableFileAccess: true, disableUrlAccess: true } });")).toEqual(["refused"]);
    expect(judge("function o() { return { a: 1 }; }\ncreateTransport(o());")).toEqual(["refused"]);
    expect(judge("createTransport({ host, disableFileAccess: true, disableUrlAccess: true });")).toEqual(["ok"]);
    expect(judge("function o(c) { return { host: c.h, disableFileAccess: true, disableUrlAccess: true }; }\ncreateTransport(o(c));")).toEqual(["ok"]);
    expect(judge("new MailComposer(mail).compile();")).toEqual(["refused"]);
    expect(judge("new MailComposer({ ...mail, disableFileAccess: true, disableUrlAccess: true });")).toEqual(["ok"]);
    expect(judge("// createTransport({})\nconst s = \"createTransport(x)\";")).toEqual([]);
  });
});
