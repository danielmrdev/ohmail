/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  `base64url` ON THE POLYFILL THE PHONE ACTUALLY CARRIES — against Node's own answers
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The engine seals a mailbox credential and writes it as `base64url`. A phone has no `buffer`
 * builtin, so it runs the `buffer` package, which predates that encoding — the launch failed with
 * `TypeError: Unknown encoding: base64url` after a successful load and a successful migration.
 *
 * Every expectation here is NODE'S OWN ANSWER for the same input rather than a string this file
 * decided was right. A hand-written vector is a second implementation of the encoding, and if it
 * is wrong in the same way the code is, both agree and nothing is measured.
 *
 * ── AND THE CONTROL SAYS THE VECTORS DISCRIMINATE ─────────────────────────────────────────
 *
 * The raw polyfill is exercised on the same inputs and has to DISAGREE, or these cases would pass
 * over a build with no wrapper at all. What it actually gets wrong was measured rather than assumed
 * — see `shims/buffer.js`, where the assumption on record turned out to be false — and the sharpest
 * of the five is `byteLength`, which answers the string's own length instead of the decoded byte
 * count and does NOT throw. A caller sizing an allocation from it gets the wrong number silently.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);

const shim = require_("../src/engine/shims/buffer.js") as {
  Buffer: BufferConstructor;
  toUrlAlphabet(value: string): string;
};
const Wrapped = shim.Buffer;

/**
 * A PRISTINE COPY OF THE POLYFILL, for the control.
 *
 * The shim patches the polyfill's class IN PLACE — deliberately, so the global and the module
 * cannot be two different classes — which means that by the time this file runs, the instance in
 * the module cache is the patched one. Dropping it from the cache and requiring it again builds a
 * fresh, unpatched class, which is the only way to ask "what would this do without the wrapper?"
 * inside one process.
 */
function pristinePolyfill(): BufferConstructor {
  const path = require_.resolve("buffer/");
  delete require_.cache[path];
  const fresh = (require_(path) as { Buffer: BufferConstructor }).Buffer;
  delete require_.cache[path];
  return fresh;
}

/** The bytes an encoder is most likely to get wrong: the two alphabet swaps and the high end. */
const EDGE = [0x00, 0x3e, 0x3f, 0xfb, 0xfe, 0xff];

/** Deterministic, so a failure is reproducible; `+`/`/` appear in a base64 of these lengths. */
function vectors(): Buffer[] {
  const out = [Buffer.from(EDGE)];
  let seed = 0x2f6e2b1;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >>> 8) & 0xff;
  };
  for (let i = 0; i < 32; i += 1) {
    // Lengths 1..24 so every padding remainder (0, 2, 3) is covered many times over.
    out.push(Buffer.from(Array.from({ length: (i % 24) + 1 }, next)));
  }
  return out;
}

const VECTORS = vectors();

describe("the wrapped Buffer answers `base64url` exactly as Node does", () => {
  it("encodes every vector to the same string", () => {
    for (const buf of VECTORS) {
      const wrapped = Wrapped.from(Array.from(buf)).toString("base64url");
      expect(wrapped, `${buf.length} bytes`).toBe(buf.toString("base64url"));
    }
  });

  it("decodes every vector back to the same bytes", () => {
    for (const buf of VECTORS) {
      const text = buf.toString("base64url");
      expect(Array.from(Wrapped.from(text, "base64url")), text).toEqual(Array.from(buf));
    }
  });

  it("measures every vector's length as Node measures it", () => {
    for (const buf of VECTORS) {
      const text = buf.toString("base64url");
      expect(Wrapped.byteLength(text, "base64url"), text).toBe(Buffer.byteLength(text, "base64url"));
    }
  });

  it("knows the name, and writes through it", () => {
    expect(Wrapped.isEncoding("base64url")).toBe(true);
    // Case-insensitively, as Node treats every encoding name.
    expect(Wrapped.isEncoding("BASE64URL")).toBe(true);
    for (const buf of VECTORS) {
      const target = Wrapped.alloc(buf.length);
      const written = target.write(buf.toString("base64url"), 0, buf.length, "base64url");
      expect(written, `${buf.length} bytes`).toBe(buf.length);
      expect(Array.from(target)).toEqual(Array.from(buf));
    }
  });

  it("normalizes the name at `from` — nothing below it ever sees `base64url`", () => {
    /**
     * THE CASE THAT TELLS TWO GREEN THINGS APART.
     *
     * Removing `from`'s own `base64url` arm leaves every other case here green, and the reason is
     * a second mechanism covering for the one under test: `isEncoding` answers `true` for the
     * name, so the polyfill's `fromString` proceeds instead of refusing, and `byteLength` and
     * `write` carry the decode between them. Traced against the raw package — `from` throws
     * `Unknown encoding: base64url`, and with only those three patched it returns the right bytes.
     *
     * So the arm is not measured by output, and a stronger assertion about output would not
     * measure it either. What it does is normalize the name ONCE at the entry point, and that IS
     * observable: with the arm, the members below are called with `base64`; without it, they are
     * handed `base64url` and each has to recognise it. This records what `write` was called with.
     */
    const seen: unknown[][] = [];
    const patched = Wrapped.prototype.write;
    Wrapped.prototype.write = function spy(this: Buffer, ...args: unknown[]): number {
      seen.push(args);
      return (patched as unknown as (...a: unknown[]) => number).apply(this, args);
    } as unknown as typeof patched;
    try {
      const buf = VECTORS[0]!;
      const decoded = Wrapped.from(buf.toString("base64url"), "base64url");
      // The output is still right — this case adds a claim, it does not replace one.
      expect(Buffer.from(decoded).equals(buf)).toBe(true);
    } finally {
      Wrapped.prototype.write = patched;
    }
    // `fromString` writes through the prototype, so the call is there to inspect either way.
    expect(seen.length, "the polyfill wrote the bytes through `write`").toBeGreaterThan(0);
    const leaked = seen.flat().filter((a) => typeof a === "string" && a.toLowerCase() === "base64url");
    expect(leaked, "`base64url` reached a member below `from`").toEqual([]);
  });

  it("leaves every other encoding to the polyfill, untouched", () => {
    // The positive control for the delegation. A wrapper that intercepted more than it meant to
    // would break utf8 and hex, which is most of what mail parsing does.
    const buf = Buffer.from("Grüße, ohmail — ✉", "utf8");
    expect(Wrapped.from("Grüße, ohmail — ✉", "utf8").toString("hex")).toBe(buf.toString("hex"));
    expect(Wrapped.from(buf.toString("hex"), "hex").toString("utf8")).toBe(buf.toString("utf8"));
    expect(Wrapped.from(buf.toString("base64"), "base64").toString("utf8")).toBe(buf.toString("utf8"));
    expect(Wrapped.byteLength("Grüße", "utf8")).toBe(Buffer.byteLength("Grüße", "utf8"));
    expect(Wrapped.isEncoding("utf8")).toBe(true);
    expect(Wrapped.isEncoding("not-an-encoding")).toBe(false);
  });
});

describe("the raw polyfill disagrees — so the vectors above discriminate", () => {
  const Raw = pristinePolyfill();

  it("refuses the name outright on three of the five members", () => {
    const text = Buffer.from(EDGE).toString("base64url");
    const thrown = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        return (err as Error).message;
      }
      return "__nothing was thrown__";
    };
    expect(thrown(() => Raw.from(text, "base64url" as BufferEncoding)))
      .toMatch(/Unknown encoding: base64url/);
    expect(thrown(() => Raw.from(EDGE).toString("base64url" as BufferEncoding)))
      .toMatch(/Unknown encoding: base64url/);
    expect(thrown(() => Raw.alloc(6).write(text, 0, 6, "base64url" as BufferEncoding)))
      .toMatch(/Unknown encoding: base64url/);
    expect(Raw.isEncoding("base64url")).toBe(false);
  });

  it("and answers a WRONG NUMBER for the fifth, without refusing", () => {
    /* The dangerous one. `byteLength` falls through to the default branch and reports the string's
       own length, so a caller sizing an allocation from it gets a buffer of the wrong size and
       nothing anywhere reports a problem. */
    const text = Buffer.from(EDGE).toString("base64url");
    expect(text).toHaveLength(8);
    expect(Buffer.byteLength(text, "base64url")).toBe(6);
    expect(Raw.byteLength(text, "base64url" as BufferEncoding)).toBe(8);
    // And the wrapper is the thing that fixes it.
    expect(Wrapped.byteLength(text, "base64url")).toBe(6);
  });
});

/**
 * THE ENCODE-SIDE TRANSLATION, ON ITS OWN TERMS — and there is no decode-side twin any more.
 *
 * `toString("base64url")` has to translate: the polyfill emits the standard alphabet and padding,
 * and nothing downstream will do it. DECODING does not, and the removed half is worth naming
 * because its own comment argued the opposite. It claimed the polyfill's acceptance of `-` and `_`
 * was "undocumented" leniency that a version bump might withdraw. It is a documented feature:
 * `base64-js/index.js:17-20` sets `revLookup['-'] = 62` and `revLookup['_'] = 63` under the comment
 * *"Support decoding URL-safe base64 strings, as Node.js does."* Measured across remainders 0, 2
 * and 3, padded and unpadded, on vectors carrying both characters: `from` and `byteLength` agree
 * with Node with the string handed over untouched.
 */
describe("the alphabet translation, on its own terms", () => {
  it("translates §4 to §5 and drops the padding", () => {
    expect(shim.toUrlAlphabet("+++/")).toBe("---_");
    expect(shim.toUrlAlphabet("AA==")).toBe("AA");
    expect(shim.toUrlAlphabet("AAA=")).toBe("AAA");
    expect(shim.toUrlAlphabet("AAAA")).toBe("AAAA");
  });

  it("agrees with Node's own encoder on every vector — the only claim left to make", () => {
    // The §4→§5 direction, checked against the platform rather than against a re-implementation of
    // it. The §5→§4 twin is gone: the polyfill's decoders read the URL-safe alphabet themselves
    // (`base64-js/index.js:17-20`), so translating before them was a second implementation of a
    // rule the dependency already documents, and the cases above measure the members end to end.
    for (const buf of VECTORS) {
      expect(shim.toUrlAlphabet(buf.toString("base64"))).toBe(buf.toString("base64url"));
    }
  });
});
