/**
 * `subarray` ON THE PHONE ANSWERS A BUFFER. Hermes builds a TypedArray method's result without
 * species, so the polyfill's inherited `subarray` came back a plain Uint8Array whose `toString`
 * joins the bytes as decimals: the device read `subToString "97,98"` and stored a body cut that way
 * at 3.5 times the cap. The no-species runtime is modelled by pointing the class's species at
 * Uint8Array, which is what the device's own reading showed (`subProtoU8: true`).
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const Wrapped = (require_("../src/engine/shims/buffer.js") as { Buffer: BufferConstructor }).Buffer;

function pristinePolyfill(): BufferConstructor {
  const path = require_.resolve("buffer/");
  delete require_.cache[path];
  const fresh = (require_(path) as { Buffer: BufferConstructor }).Buffer;
  delete require_.cache[path];
  return fresh;
}

function withoutSpecies<T>(B: BufferConstructor, run: () => T): T {
  Object.defineProperty(B, Symbol.species, { get: () => Uint8Array, configurable: true });
  try { return run(); } finally { delete (B as unknown as Record<symbol, unknown>)[Symbol.species]; }
}

const TEXT = "Grüße, 😀 — a header block\r\n\r\nand a body";

describe("the phone's Buffer on a runtime without species", () => {
  it("CONTROL: the raw polyfill's subarray is a plain Uint8Array there, and decodes as decimals", () => {
    const Raw = pristinePolyfill();
    const view = withoutSpecies(Raw, () => Raw.from("ab").subarray(0, 2));
    expect(Object.getPrototypeOf(view)).toBe(Uint8Array.prototype);
    expect(view.toString()).toBe("97,98");
  });

  it("the shim's subarray is a Buffer and decodes as Node's does, at every cut", () => {
    withoutSpecies(Wrapped, () => {
      const bytes = Wrapped.from(TEXT, "utf8");
      const node = Buffer.from(TEXT, "utf8");
      for (const end of [0, 1, 5, 9, bytes.length]) {
        const view = bytes.subarray(0, end);
        expect(Wrapped.isBuffer(view)).toBe(true);
        expect(view.toString("latin1")).toBe(node.subarray(0, end).toString("latin1"));
      }
    });
  });

  it("the view still shares the bytes: a write through it reaches the parent", () => {
    withoutSpecies(Wrapped, () => {
      const parent = Wrapped.from("abcd");
      parent.subarray(1, 3)[0] = 0x5a;
      expect(parent.toString()).toBe("aZcd");
    });
  });
});
