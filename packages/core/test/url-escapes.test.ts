import { describe, it, expect } from "vitest";
import { decodeUnreservedEscapes } from "../src/url-escapes.js";
import { isBeaconUrl } from "../src/privacy/tracker-blocker.js";

/**
 * a percent-encoded beacon path is a beacon. The decoder turns only the
 * unreserved escapes back into their characters (RFC 3986 §2.3) — the ones that name the same url —
 * and leaves every reserved one, so the url a rule tests is still the url a server fetches.
 */
describe("decodeUnreservedEscapes", () => {
  it("decodes ALPHA, DIGIT and -._~, in either hex case", () => {
    expect(decodeUnreservedEscapes("/%6fpen")).toBe("/open");
    expect(decodeUnreservedEscapes("/%6Fp%65N%30%2d%2E%5f%7E")).toBe("/opeN0-._~");
  });

  it("leaves every reserved or unsafe escape as it was", () => {
    for (const e of ["%2F", "%2f", "%3F", "%23", "%25", "%20", "%26", "%3D", "%00", "%C3%A9"]) {
      expect(decodeUnreservedEscapes(`/a${e}b`), e).toBe(`/a${e}b`);
    }
  });

  it("does not decode twice: %256f is a percent sign and 6f", () => {
    expect(decodeUnreservedEscapes("/%256fpen")).toBe("/%256fpen");
  });

  it("the beacon rule reads the decoded url, and a reserved escape keeps its meaning", () => {
    expect(isBeaconUrl("https://t.example/%6fpen?u=1")).toBe(true);
    expect(isBeaconUrl("https://t.example/p%69xel.gif")).toBe(true);
    expect(isBeaconUrl("https://t.example/img.jpg?%72ecipient=r-1")).toBe(true);
    expect(isBeaconUrl("https://t.example/wf%2Fopen?u=1")).toBe(false);
  });
});
