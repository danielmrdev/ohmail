import { describe, expect, it } from "vitest";
import { tokensFromSetCookie } from "../src/cloud-signin.js";

/**
 * THE DESKTOP READS BOTH COOKIE SPELLINGS BEFORE THE HOSTED SIDE WRITES THE NEW ONE. The hosted
 * sign-in answers a browser-shaped request with `Set-Cookie`, and this install takes its token pair
 * from those lines by name. A later hosted release writes `__Host-` names and clears the bare ones;
 * a build that read only the bare names would sign in to nothing. This build takes either, the
 * prefixed one winning, and never takes a clear (an empty value) for a token.
 */
describe("the sign-in parser takes the __Host- spelling", () => {
  it("reads a __Host- pair with its access window", () => {
    expect(tokensFromSetCookie([
      "__Host-tf_session=a; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=900",
      "__Host-tf_refresh=r; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=7776000",
    ])).toEqual({ accessToken: "a", refreshToken: "r", expiresIn: 900 });
  });

  it("the prefixed pair wins over the bare one, in either order", () => {
    const pre = ["__Host-tf_session=new-a; Path=/; Max-Age=900", "__Host-tf_refresh=new-r; Path=/"];
    const bare = ["tf_session=old-a; Path=/; Max-Age=900", "tf_refresh=old-r; Path=/auth/refresh"];
    const want = { accessToken: "new-a", refreshToken: "new-r", expiresIn: 900 };
    expect(tokensFromSetCookie([...pre, ...bare])).toEqual(want);
    expect(tokensFromSetCookie([...bare, ...pre])).toEqual(want);
  });

  it("the new names beside clears of the old ones read as the new pair", () => {
    expect(tokensFromSetCookie([
      "__Host-tf_session=a; Path=/; Max-Age=900", "__Host-tf_refresh=r; Path=/",
      "tf_session=; Path=/; Max-Age=0", "tf_refresh=; Path=/auth/refresh; Max-Age=0",
    ])).toEqual({ accessToken: "a", refreshToken: "r", expiresIn: 900 });
  });

  it("control: today's bare names still sign in, and a jar of clears signs in to nothing", () => {
    expect(tokensFromSetCookie(["tf_session=a; Path=/; Max-Age=900", "tf_refresh=r; Path=/auth/refresh"]))
      .toEqual({ accessToken: "a", refreshToken: "r", expiresIn: 900 });
    expect(tokensFromSetCookie(["tf_session=; Max-Age=0", "__Host-tf_refresh=; Max-Age=0"])).toBeNull();
  });
});
