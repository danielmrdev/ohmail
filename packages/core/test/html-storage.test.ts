import { describe, it, expect } from "vitest";
import {
  prepareHtmlForStorage,
  stripInlineDataUris,
  STORED_HTML_CAP_BYTES,
  STRIP_DATA_URI_MIN_CHARS,
  STRIPPED_DATA_URI,
  HTML_TRUNCATION_MARKER,
} from "../src/html-storage.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A base64 payload of exactly `n` characters — the shape mailparser and senders both emit. */
const payload = (n: number): string => "A".repeat(n);

describe("stripInlineDataUris", () => {
  it("strips a bloated inline image and keeps every surrounding byte", () => {
    const html = `<p>Dear Miriam</p><img src="data:image/png;base64,${payload(4000)}"><p>Kind regards</p>`;
    const out = stripInlineDataUris(html);
    expect(out).toBe(`<p>Dear Miriam</p><img src="${STRIPPED_DATA_URI}"><p>Kind regards</p>`);
    expect(out).not.toContain(";base64,");
  });

  it("strips EVERY payload, not just the first — production rows carried several", () => {
    const html = `<img src="data:image/jpeg;base64,${payload(1000)}">` +
      `<img src="data:image/gif;base64,${payload(2000)}">`;
    const out = stripInlineDataUris(html);
    expect(out).toBe(`<img src="${STRIPPED_DATA_URI}"><img src="${STRIPPED_DATA_URI}">`);
  });

  it("LEAVES a small data: URI alone — the target is bloat, not every inline icon", () => {
    const small = `<img src="data:image/png;base64,${payload(STRIP_DATA_URI_MIN_CHARS - 1)}">`;
    expect(stripInlineDataUris(small)).toBe(small);
  });

  it("does not eat the words after an UNQUOTED src — the whitespace-class bug, pinned", () => {
    // A payload class admitting `\s` matches straight through the following prose and deletes
    // the sentence. This is the case that proves it does not.
    const html = `<img src=data:image/png;base64,${payload(600)} alt=logo> and then some prose`;
    const out = stripInlineDataUris(html);
    expect(out).toContain(" alt=logo> and then some prose");
    expect(out).toContain(STRIPPED_DATA_URI);
  });

  it("is idempotent — the replacement contains no data: URI to re-match", () => {
    const html = `<img src="data:image/png;base64,${payload(2000)}">`;
    const once = stripInlineDataUris(html);
    expect(stripInlineDataUris(once)).toBe(once);
  });

  it("leaves an ordinary cid: reference untouched", () => {
    const html = `<img src="cid:logo@corp"><p>hello</p>`;
    expect(stripInlineDataUris(html)).toBe(html);
  });
});

describe("prepareHtmlForStorage", () => {
  it("passes null through — no html, and sensitive mail, take this path", () => {
    expect(prepareHtmlForStorage(null)).toBeNull();
  });

  it("returns ordinary html unchanged and allocates no marker", () => {
    const html = "<p>Hey, lunch tomorrow?</p>";
    expect(prepareHtmlForStorage(html)).toBe(html);
  });

  it("BOUNDS a body many times the cap, the shape that filled production", () => {
    // The real maximum measured on the hosted service was far past the cap, in ONE message.
    const monster = `<img src="data:image/png;base64,${payload(19_000_000)}">`;
    const out = prepareHtmlForStorage(monster)!;
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(STORED_HTML_CAP_BYTES);
    // Stripping alone was enough here, so it must NOT have been truncated as well.
    expect(out).toBe(`<img src="${STRIPPED_DATA_URI}">`);
    expect(out).not.toContain(HTML_TRUNCATION_MARKER);
  });

  it("truncates html that is genuinely, textually enormous — and says so", () => {
    const huge = "<p>" + "x".repeat(STORED_HTML_CAP_BYTES * 2) + "</p>";
    const out = prepareHtmlForStorage(huge)!;
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(STORED_HTML_CAP_BYTES);
    expect(out.endsWith(HTML_TRUNCATION_MARKER)).toBe(true);
  });

  it("STRIPS BEFORE TRUNCATING, so an early image does not cost the reader the message", () => {
    // Truncate-first would cut inside the payload and lose the sign-off entirely.
    const html = `<p>Dear Miriam</p><img src="data:image/png;base64,${payload(1_000_000)}">` +
      `<p>Kind regards, Mila</p>`;
    const out = prepareHtmlForStorage(html)!;
    expect(out).toContain("Kind regards, Mila");
    expect(out).not.toContain(HTML_TRUNCATION_MARKER);
  });

  it("counts BYTES, not characters — a char-based cap is a 4x lie on multibyte text", () => {
    // "😀" is 4 UTF-8 bytes and 2 UTF-16 code units. A run of them is twice its storage in
    // `.length` units, so a `.slice(0, 262144)` would happily return a string past the cap.
    const emoji = "😀".repeat(100_000);
    expect(emoji.length).toBeLessThan(STORED_HTML_CAP_BYTES);       // the trap, stated
    expect(Buffer.byteLength(emoji, "utf8")).toBeGreaterThan(STORED_HTML_CAP_BYTES);
    const out = prepareHtmlForStorage(emoji)!;
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(STORED_HTML_CAP_BYTES);
  });

  it("never splits a character — the cut backs off UTF-8 continuation bytes", () => {
    // Sized so the byte budget lands INSIDE a 4-byte sequence rather than on a boundary.
    const out = prepareHtmlForStorage("😀".repeat(200_000))!;
    expect(out).not.toContain("�");                            // no half-decoded character
    const body = out.slice(0, out.length - HTML_TRUNCATION_MARKER.length);
    expect([...body].every((ch) => ch === "😀")).toBe(true);
  });

  it("is idempotent — re-storing a prepared body changes nothing", () => {
    const html = `<p>a</p><img src="data:image/png;base64,${payload(900_000)}">`;
    const once = prepareHtmlForStorage(html)!;
    expect(prepareHtmlForStorage(once)).toBe(once);
  });
});

/**
 * The phone's runtime, as the device measured it: Hermes builds `subarray`'s result without
 * species, so the view is a plain Uint8Array and its `toString` joins the bytes as decimals. The
 * device turned a body's bytes of html into several times as many that way, and the CHECK refused the row.
 */
function withRuntime<T>(patch: Partial<Record<"subarray" | "toString", unknown>>, run: () => T): T {
  const proto = Buffer.prototype as unknown as Record<string, unknown>;
  const saved = { subarray: proto.subarray, toString: proto.toString };
  Object.assign(proto, patch);
  try { return run(); } finally { Object.assign(proto, saved); }
}
const plainSubarray = function (this: Buffer, start?: number, end?: number): Uint8Array {
  return Object.setPrototypeOf(Uint8Array.prototype.subarray.call(this, start, end), Uint8Array.prototype) as Uint8Array;
};

describe("the cut on a runtime whose subarray answers a plain Uint8Array", () => {
  it("CONTROL: on that runtime a subarray's toString is the decimal join the device stored", () => {
    const view = withRuntime({ subarray: plainSubarray }, () => Buffer.from("<p>").subarray(0, 3).toString());
    expect(view).toBe("60,112,62");
  });

  it("still cuts one byte over the cap to text under the cap, at the boundary the device refused", () => {
    const html = "<p>" + "a".repeat(STORED_HTML_CAP_BYTES - 2);   // one byte over the cap
    expect(Buffer.byteLength(html, "utf8")).toBe(STORED_HTML_CAP_BYTES + 1);
    const out = withRuntime({ subarray: plainSubarray }, () => prepareHtmlForStorage(html))!;
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(STORED_HTML_CAP_BYTES);
    expect(out.startsWith("<p>aaaa")).toBe(true);
    expect(out.endsWith(HTML_TRUNCATION_MARKER)).toBe(true);
  });

  it("stores NO html when a runtime's cut still comes out over the cap, so the text part shows", () => {
    const html = "<p>" + "a".repeat(STORED_HTML_CAP_BYTES);
    // A range decode that ignores its range: the cut is the whole body plus the marker.
    const realToString = Buffer.prototype.toString;
    const wholeToString = function (this: Buffer, encoding?: BufferEncoding): string {
      return realToString.call(this, encoding);
    };
    expect(withRuntime({ toString: wholeToString }, () => prepareHtmlForStorage(html))).toBeNull();
    expect(prepareHtmlForStorage(html)).not.toBeNull();
  });
});

describe("the cap is pinned to the database constraint", () => {
  /**
   * The reconciliation point. A migration freezes the moment it is applied, so the SQL and this
   * module cannot be kept identical by construction — this test is what keeps them equal. If it
   * fails, the CHECK constraint and the code that is supposed to satisfy it have diverged, and
   * the consequence is a poison-message loop that quarantines a mailbox.
   */
  it("STORED_HTML_CAP_BYTES equals the literal in mail 0022's CHECK constraint", () => {
    const sql = readFileSync(
      join(HERE, "..", "..", "db-mail", "drizzle", "0022_message_body_html_cap.sql"),
      "utf8",
    );
    const m = /octet_length\("html"\)\s*<=\s*(\d+)/.exec(sql);
    expect(m, "0022 no longer contains a recognisable html cap CHECK").not.toBeNull();
    expect(Number(m![1])).toBe(STORED_HTML_CAP_BYTES);
  });
});
