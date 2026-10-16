import { describe, expect, it } from "vitest";
import { normalizeMime } from "../src/mime.js";

/**
 * One crafted address header must not hold the event loop: the worker parses every account's mail
 * in one process. The shapes are GHSA-v53p-9fqp-m79j (a whitespace-free run with no usable `@`) and
 * GHSA-prgh-xp8r-p3m5 (atoms joined by comments). Under mailparser 3.9.18 (nodemailer 9.1.0) v53p
 * took 20.9 s at 256 KiB and 19.9 s as 15 x 64 KiB headers, prgh 6.2 s at 640 KiB; 3.9.32 parses
 * each in milliseconds. The timeout is wide so a regression reports its time instead of timing out.
 */
const K = 1024;
const BOUND_MS = 2000;
const shapes = {
  v53p: (n: number) => (" >" + ">[x][x]".repeat(Math.ceil(n / 7))).slice(0, n),
  prgh: (n: number) => ("a" + "@b(c)".repeat(Math.ceil(n / 5))).slice(0, n),
};
const msg = (headers: string[]) => Buffer.from([
  ...headers, "Subject: dos", "Date: Wed, 30 Sep 2026 12:00:00 +0000", "Message-ID: <dos@hotfix.test>",
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

describe("a crafted address header parses in bounded time", () => {
  it("the control message parses and names its sender", async () => {
    const parsed = await normalizeMime(msg(["From: Alice <alice@example.com>", "To: bob@example.org"]));
    expect(parsed.from.address).toBe("alice@example.com");
  });

  for (const [label, raw] of CASES) {
    it(`${label}: parsed in under ${BOUND_MS} ms`, async () => {
      const t0 = performance.now();
      const parsed = await normalizeMime(raw);
      const ms = Math.round(performance.now() - t0);
      expect(ms, `${label} took ${ms} ms`).toBeLessThan(BOUND_MS);
      expect(parsed.to.map((a) => a.address)).toEqual(["bob@example.org"]);
    }, 300_000);
  }
});
