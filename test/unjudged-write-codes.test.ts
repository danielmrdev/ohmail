import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bracketSpan, lineOf, withoutComments, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";
import { UNJUDGED_WRITE_CODES } from "../packages/client-engine/src/adapters/refusal-shape.js";

/* @reads: apps/sidecar/src/cloud-engine.ts apps/sidecar/src/cloud-auth.ts apps/sidecar/src/cloud-proxy.ts */

/**
 * THE DESKTOP ENGINE ANSWERS A WRITE IT COULD NOT SEND WITH A CODE THE WINDOW KEEPS. The engine does
 * not link the client engine, so this census is the type: the codes the signed-out gate, the offline
 * answer and the proxy's answer to a write the account refused with 401 give a relayed write are read
 * out of the source, and each must be a member of `UNJUDGED_WRITE_CODES`. A code outside the set reads
 * as the server's refusal, and the window drops the write. Each site is found exactly once first.
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string): string => readFileSync(join(REPO, path), "utf8");

interface Site { line: number; codes: string[] }

/** The `{…}` body opened at `open`, from the comment-blanked text, bracket-walked with literals blanked. */
function body(src: string, open: number): string {
  const walked = bracketSpan(withoutCommentsAndLiterals(src), open, "{", "}");
  expect(walked.closed, "a block the census reads never closed").toBe(true);
  return withoutComments(src).slice(walked.start, walked.end);
}

/** The signed-out gate in front of the relay: the `if (!authed)` block the proxy's capture follows. */
function gateSites(src: string): Site[] {
  const blanked = withoutCommentsAndLiterals(src);
  const out: Site[] = [];
  for (const m of blanked.matchAll(/\bif\s*\(\s*!authed\s*\)\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const walked = bracketSpan(blanked, open, "{", "}");
    if (!/^\s*const\s*\{\s*proxy\b/.test(blanked.slice(walked.end + 1))) continue;
    const codes = [...body(src, open).matchAll(/\bcode\s*:\s*"([^"]*)"/g)].map((c) => c[1]!);
    out.push({ line: lineOf(src, m.index), codes });
  }
  return out;
}

/** `offlineResponse`'s body, its `code:` resolved through a same-file string constant. */
function offlineSites(src: string): Site[] {
  const blanked = withoutCommentsAndLiterals(src);
  const comments = withoutComments(src);
  const out: Site[] = [];
  for (const m of blanked.matchAll(/\bfunction\s+offlineResponse\s*\([^)]*\)\s*:\s*Response\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const codes = [...body(src, open).matchAll(/\bcode\s*:\s*(?:"([^"]*)"|([A-Za-z_$][\w$]*))/g)].map((c) => {
      if (c[1] !== undefined) return c[1];
      const constant = new RegExp(`\\bconst\\s+${c[2]}\\s*=\\s*"([^"]*)"`).exec(comments);
      return constant?.[1] ?? `<unresolved ${c[2]}>`;
    });
    out.push({ line: lineOf(src, m.index), codes });
  }
  return out;
}

/**
 * The proxy's answer to a relayed write the account answered 401: its session ended there. One call
 * may narrow the condition (the routes whose 401 is the account's answer pass through untouched).
 */
function relay401Sites(src: string): Site[] {
  const blanked = withoutCommentsAndLiterals(src);
  const out: Site[] = [];
  for (const m of blanked.matchAll(/\bif\s*\(\s*mutation\s*&&\s*res\.status\s*===\s*401(?:\s*&&\s*[A-Za-z_$][\w$]*\([^()]*\))?\s*\)\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const codes = [...body(src, open).matchAll(/\bcode\s*:\s*"([^"]*)"/g)].map((c) => c[1]!);
    out.push({ line: lineOf(src, m.index), codes });
  }
  return out;
}

const foreign = (sites: Site[]): string[] =>
  sites.flatMap((s) => s.codes.filter((c) => !UNJUDGED_WRITE_CODES.has(c as never)).map((c) => `${s.line}: ${c}`));

describe("the desktop engine's three answers to a write it could not send are in the closed set", () => {
  it("the signed-out gate in front of the relay", () => {
    const sites = gateSites(read("apps/sidecar/src/cloud-engine.ts"));
    expect(sites, "the gate was not found once: the census reads nothing").toHaveLength(1);
    expect(sites[0]!.codes.length, "the gate answers no code the census can read").toBeGreaterThan(0);
    expect(foreign(sites), "cloud-engine.ts answers a write with a code the window reads as a refusal").toEqual([]);
  });

  it("the proxy's answer to a write the account refused with 401", () => {
    const sites = relay401Sites(read("apps/sidecar/src/cloud-proxy.ts"));
    expect(sites, "the 401 answer was not found once: the census reads nothing").toHaveLength(1);
    expect(sites[0]!.codes.length, "the 401 answer gives no code the census can read").toBeGreaterThan(0);
    expect(foreign(sites), "cloud-proxy.ts answers a 401'd write with a code the window reads as a refusal").toEqual([]);
  });

  it("the offline answer", () => {
    const sites = offlineSites(read("apps/sidecar/src/cloud-auth.ts"));
    expect(sites, "offlineResponse was not found once: the census reads nothing").toHaveLength(1);
    expect(sites[0]!.codes.length).toBeGreaterThan(0);
    expect(foreign(sites), "cloud-auth.ts answers offline with a code the window reads as a refusal").toEqual([]);
  });
});

describe("the census reads the codes, not their absence (planted)", () => {
  const GATE = (code: string, tail = "const { proxy, mirror } = authed;") =>
    `async function h() {\n  if (!authed) {\n    // code: "not_signed_in" in a comment is not an answer\n` +
    `    return new Response(JSON.stringify({ error: { code: "${code}" } }), { status: 409 });\n  }\n  ${tail}\n}\n`;

  it("PLANTED: a gate answering another code is refused by its line", () => {
    expect(foreign(gateSites(GATE("signed_out")))).toEqual(["2: signed_out"]);
    expect(foreign(gateSites(GATE("not_signed_in"))), "control: the member is admitted").toEqual([]);
  });

  it("PLANTED: an `if (!authed)` that guards something else is not the gate, and a missing gate is zero sites", () => {
    expect(gateSites(GATE("signed_out", "return json(await renew());"))).toEqual([]);
    expect(gateSites("const x = 1;\n")).toEqual([]);
  });

  it("PLANTED: a 401 answer giving the account's own code is refused by its line", () => {
    const relay = (code: string) =>
      `async function f() {\n  if (mutation && res.status === 401) {\n    return new Response(JSON.stringify({ error: { code: "${code}" } }), { status: 409 });\n  }\n}\n`;
    expect(foreign(relay401Sites(relay("unauthorized")))).toEqual(["2: unauthorized"]);
    expect(foreign(relay401Sites(relay("not_signed_in"))), "control: the member is admitted").toEqual([]);
    expect(relay401Sites("if (res.status === 401) { return res; }\n"), "a pass-through is no site").toEqual([]);
    const narrowed = (code: string) =>
      `async function f() {\n  if (mutation && res.status === 401 && mayRenewFor(url.pathname)) {\n    return new Response(JSON.stringify({ error: { code: "${code}" } }), { status: 409 });\n  }\n}\n`;
    expect(foreign(relay401Sites(narrowed("unauthorized"))), "a narrowed site is still read").toEqual(["2: unauthorized"]);
    expect(foreign(relay401Sites(narrowed("not_signed_in")))).toEqual([]);
    expect(relay401Sites("if (mutation && res.status === 401 && false) { return res; }\n"), "a dead site is no site").toEqual([]);
  });

  it("PLANTED: the offline answer's constant is resolved, and an unknown one is refused", () => {
    const offline = (decl: string) =>
      `${decl}\nexport function offlineResponse(): Response {\n  return json({ error: { code: OFFLINE, retryable: true } }, 503);\n}\n`;
    expect(foreign(offlineSites(offline(`export const OFFLINE = "offline_read_only";`)))).toEqual([]);
    expect(foreign(offlineSites(offline(`export const OFFLINE = "offline";`)))).toEqual(["2: offline"]);
    expect(foreign(offlineSites(offline("")))).toEqual(["2: <unresolved OFFLINE>"]);
  });
});
