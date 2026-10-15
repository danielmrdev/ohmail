/**
 * A crafted address header must not hold the PHONE's engine either. The phone parses with the
 * address parser its bundle carries, chosen by the bundler's alias table, not the workspace's, so
 * the control and the five shapes of `packages/core/test/mime-address-dos.test.ts` (GHSA-v53p,
 * GHSA-prgh) go through a probe built with the artifact's own plugin and aliases. Each parses under
 * 2 s and keeps its recipient. Watched red with the parser's alias pointed at nodemailer 9.1.0's
 * (the 3.9.18 shape: 18 s and more). With the alias removed a parse never settles, so each one is
 * raced against a deadline that names it rather than leaving the case to its timeout.
 */
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPO, bundleProbe } from "../scripts/bundle-engine.mjs";

const require_ = createRequire(import.meta.url);
const K = 1024;
const BOUND_MS = 2000;
const SETTLE_MS = 30_000;
/** The parse, or a rejection naming it when it does not settle. */
const settled = <T>(p: Promise<T>): Promise<T> => Promise.race([p, new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error(`the phone's parse did not settle within ${SETTLE_MS} ms`)), SETTLE_MS).unref();
})]);
const shapes = {
  v53p: (n: number) => (" >" + ">[x][x]".repeat(Math.ceil(n / 7))).slice(0, n),
  prgh: (n: number) => ("a" + "@b(c)".repeat(Math.ceil(n / 5))).slice(0, n),
};
const msg = (headers: string[]) => Buffer.from([
  ...headers, "Subject: dos", "Date: Wed, 30 Sep 2026 12:00:00 +0000", "Message-ID: <dos@phone.test>",
  "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "hi", "",
].join("\r\n"));
const CASES: Array<[string, Buffer]> = [
  ["v53p, one From header of 256 KiB", msg([`From: ${shapes.v53p(256 * K)}`, "To: bob@example.org"])],
  ["prgh, one From header of 256 KiB", msg([`From: ${shapes.prgh(256 * K)}`, "To: bob@example.org"])],
  ["prgh, one From header of 640 KiB", msg([`From: ${shapes.prgh(640 * K)}`, "To: bob@example.org"])],
  ["v53p, 15 From headers of 64 KiB (a head near 1 MiB)",
    msg([...Array.from({ length: 15 }, () => `From: ${shapes.v53p(64 * K)}`), "To: bob@example.org"])],
  ["prgh, 15 From headers of 64 KiB (a head near 1 MiB)",
    msg([...Array.from({ length: 15 }, () => `From: ${shapes.prgh(64 * K)}`), "To: bob@example.org"])],
];

type Parsed = { from: { address: string }; to: ReadonlyArray<{ address: string }> };
let dir = "";
let phone: { parse: (b64: string) => Promise<Parsed> };
beforeAll(async () => {
  const mime = JSON.stringify(join(REPO, "packages", "core", "src", "mime.ts"));
  const probe = await bundleProbe(
    `import { normalizeMime } from ${mime};\n`
    + "export const parse = (b64: string) => normalizeMime(Buffer.from(b64, \"base64\"));\n",
  );
  dir = probe.dir;
  // The one native require on this path is the crypto module; Node's answers it.
  const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    return request === "react-native-quick-crypto" ? require_("node:crypto") : original.call(this, request, parent, isMain);
  };
  try {
    phone = require_(probe.bundlePath) as typeof phone;
  } finally { Module._load = original; }
}, 120_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("a crafted address header parses in bounded time on the phone", () => {
  it("the control message parses and names its sender", { timeout: SETTLE_MS + 5_000 }, async () => {
    const parsed = await settled(phone.parse(msg(["From: Alice <alice@example.com>", "To: bob@example.org"]).toString("base64")));
    expect(parsed.from.address).toBe("alice@example.com");
  });

  for (const [label, raw] of CASES) {
    it(`${label}: parsed in under ${BOUND_MS} ms`, async () => {
      const b64 = raw.toString("base64");
      const t0 = performance.now();
      const parsed = await settled(phone.parse(b64));
      const ms = Math.round(performance.now() - t0);
      expect(ms, `${label} took ${ms} ms`).toBeLessThan(BOUND_MS);
      expect(parsed.to.map((a) => a.address)).toEqual(["bob@example.org"]);
    }, 300_000);
  }
});
