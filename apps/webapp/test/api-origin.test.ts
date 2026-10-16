import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWED_API_ORIGINS, resolveApiOrigin, resolveInternalApiOrigin } from "../app/api-origin.js";

/**
 * THE GATE'S FETCH TARGET IS ALLOW-LISTED AT RUNTIME.
 *
 * The middleware's `fetch` carries the visitor's LIVE session token as
 * `Authorization: Bearer`. Where it goes was, until this repair, an unvalidated read of
 * `process.env.TF_API_ORIGIN` under a comment claiming the opposite — that `next.config.mjs`
 * had already settled it at build time because "Next inlines it into the middleware bundle".
 *
 * That claim is measurable, and it was false. After a build with the variable set:
 *
 *   .next/routes-manifest.json   →  "destination":"http://127.0.0.1:PORT/:path*"   (baked in)
 *   .next/server/middleware.js   →  process.env.TF_API_ORIGIN??""                  (still a lookup)
 *
 * So the REWRITE was compiled and constrained; the GATE was runtime and constrained by
 * nothing. Changing the variable in the deployment's dashboard without a redeploy sent
 * every signed-in visitor's bearer token to a host of the setter's choosing, with no diff
 * and no build failure, while the rewrite stayed pinned to the old value.
 *
 * `test/proxy.e2e.test.ts` asserts the manifest/bundle split above against a real build.
 * This file asserts the policy: the runtime list is the compiled list, and everything else
 * fails CLOSED.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const nextConfig = readFileSync(`${HERE}../next.config.mjs`, "utf8");

describe("the runtime allow-list is the compiled allow-list", () => {
  it("both files name the same origins", () => {
    // Two copies exist for one reason: `next.config.mjs` is ESM JavaScript loaded by
    // `next build` and cannot import a TypeScript module. So the copies are held together
    // here, the way `api-rewrite.test.ts` holds REFRESH_PATH to `cookies.ts`.
    const compiled = /export const ALLOWED_API_ORIGINS = \[([^\]]*)\]/.exec(nextConfig)?.[1];
    expect(compiled, "ALLOWED_API_ORIGINS not found in next.config.mjs").toBeDefined();
    const parsed = [...compiled!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(parsed).toEqual([...ALLOWED_API_ORIGINS]);
    expect(parsed).toEqual(["https://api.ohmail.app"]);
  });

  it("MIDDLEWARE VALIDATES rather than reads — the whole finding, in one assertion", () => {
    const middleware = readFileSync(`${HERE}../middleware.ts`, "utf8");
    // BOTH branches of the binding validate. The managed arm is the original allow-list; the
    // self-host arm reads a DIFFERENT variable through its own fail-closed resolver, selected
    // by the COMPILED flavor — so no environment edit can repoint the managed gate (the
    // self-host branch does not exist in that bundle), and no self-host value ever meets the
    // managed allow-list it could not pass.
    expect(middleware).toMatch(
      /const API_ORIGIN = SELF_HOST_BUILD\s*\?\s*resolveInternalApiOrigin\(process\.env\.OHMAIL_INTERNAL_API_ORIGIN\)\s*:\s*resolveApiOrigin\(process\.env\.TF_API_ORIGIN\)/,
    );
    // The selector must be the INLINED flavor, never a runtime variable: a runtime selector
    // would be exactly the dashboard-editable repoint this whole file is about.
    expect(middleware).toMatch(/const SELF_HOST_BUILD = process\.env\.NEXT_PUBLIC_OHMAIL_FLAVOR === "selfhost"/);
    // The shape that shipped, and must never come back: a bare read with no allow-list.
    // Matched as a BINDING, because the prose above it quotes the old expression verbatim
    // — recording what was wrong is the point of that comment.
    expect(middleware).not.toMatch(/const API_ORIGIN\s*=\s*\(process\.env/);
    // …and the claim that made it look safe is gone with it.
    expect(middleware).not.toContain("so there is no runtime lookup and no way for the edge");
  });
});

describe("resolveInternalApiOrigin — the self-host gate's resolver, fail-closed on shape", () => {
  it("accepts the compose's in-network api address, http included", () => {
    // `api` is not loopback and the hop never leaves the compose bridge — demanding TLS here
    // would make every family install carry an internal CA for a wire nobody else can see.
    expect(resolveInternalApiOrigin("http://api:8080")).toBe("http://api:8080");
    expect(resolveInternalApiOrigin("  http://api:8080/  ")).toBe("http://api:8080");
    expect(resolveInternalApiOrigin("https://api.internal.example")).toBe("https://api.internal.example");
  });

  it("REFUSES the shapes that would be mangled or would leak — the same three rules as the managed resolver", () => {
    for (const bad of [
      "http://api:8080/v2",        // a path, concatenated in front of /auth/session
      "http://api:8080?x=1",
      "http://api:8080#f",
      "http://user:pass@api:8080", // credentials on every gate fetch
      "ftp://api:8080",
      "api:8080",                  // not absolute — parses as scheme "api:"
      "not a url",
      "",
      "   ",
    ]) {
      expect(resolveInternalApiOrigin(bad), bad).toBeNull();
    }
    expect(resolveInternalApiOrigin(undefined)).toBeNull();
    expect(resolveInternalApiOrigin(null)).toBeNull();
  });

  it("NEVER THROWS — same contract, same reason: a throw here is a 500 on the front door", () => {
    for (const v of ["://", "https://", "http://[", "x".repeat(5000)]) {
      expect(() => resolveInternalApiOrigin(v), v.slice(0, 20)).not.toThrow();
    }
  });
});

describe("resolveApiOrigin fails CLOSED", () => {
  it("accepts exactly the allow-listed origin", () => {
    expect(resolveApiOrigin("https://api.ohmail.app")).toBe("https://api.ohmail.app");
    expect(resolveApiOrigin("  https://api.ohmail.app  ")).toBe("https://api.ohmail.app");
    expect(resolveApiOrigin("https://api.ohmail.app/")).toBe("https://api.ohmail.app");
  });

  it("REFUSES every host that is not on the list", () => {
    for (const bad of [
      "https://evil.example",
      "https://api.ohmail.app.evil.example", //   suffix trick
      "https://ohmail.app",                  //   the app itself is not the API
      "https://admin.ohmail.app",
      "https://api.mailoh.app",              //   the retired host, deliberately not admitted
    ]) {
      expect(resolveApiOrigin(bad), bad).toBeNull();
    }
  });

  it("REFUSES the shapes that would be silently mangled or would leak", () => {
    const USER = "user", PASS = "pass";
    for (const bad of [
      "http://api.ohmail.app",                       // plaintext: the bearer token in clear
      `https://${USER}:${PASS}@api.ohmail.app`,            // credentials on every proxied request
      "https://api.ohmail.app/v2",                   // a path, concatenated in front of /auth
      "https://api.ohmail.app?x=1",
      "https://api.ohmail.app#f",
      "ftp://api.ohmail.app",
      "api.ohmail.app",                              // not absolute
      "not a url",
      "//api.ohmail.app",
    ]) {
      expect(resolveApiOrigin(bad), bad).toBeNull();
    }
  });

  it("unset is `null` — not armed, which is a different thing from wrong", () => {
    expect(resolveApiOrigin(undefined)).toBeNull();
    expect(resolveApiOrigin(null)).toBeNull();
    expect(resolveApiOrigin("")).toBeNull();
    expect(resolveApiOrigin("   ")).toBeNull();
  });

  it("NEVER THROWS — a throw in middleware is a 500 on the product's front door", () => {
    // `apiOrigin()` in next.config.mjs throws by design: a bad value must stop a BUILD.
    // Here a bad value must stop a REQUEST, and the gate's contract is that every failure
    // answers "marketing". `resolveSurface` already treats null that way.
    for (const v of ["", "://", "https://", " ", "https://[", "x".repeat(5000)]) {
      expect(() => resolveApiOrigin(v), v.slice(0, 20)).not.toThrow();
    }
  });

  it("loopback stays open, and only loopback may be plaintext", () => {
    // `pnpm dev` and `proxy.e2e.test.ts` both run against 127.0.0.1 on a random port.
    expect(resolveApiOrigin("http://127.0.0.1:57423")).toBe("http://127.0.0.1:57423");
    expect(resolveApiOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(resolveApiOrigin("http://[::1]:8080")).toBe("http://[::1]:8080");
    expect(resolveApiOrigin("http://10.0.0.1")).toBeNull();
    expect(resolveApiOrigin("http://169.254.169.254")).toBeNull(); //   cloud metadata
  });
});
