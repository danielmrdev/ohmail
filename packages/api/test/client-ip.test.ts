import { describe, it, expect } from "vitest";
import { clientIp, serviceContext } from "../src/context.js";
import { makeDeps, req } from "./helpers.js";

/**
 * the client IP must come from a header the CLIENT CANNOT CHOOSE.
 *
 * `clientIp` used to return the FIRST hop of `X-Forwarded-For`. That is a caller-controlled
 * value: `-H 'X-Forwarded-For: 1.2.3.4'` and every proxy appends to the RIGHT of it, so the
 * leftmost entry is whatever the caller wrote. Any per-IP throttle built on it — the one the review says
 * `POST /auth/register` needs before open registration — is bypassable by rotating one header,
 * and the audit trail an abuse report is read from is fiction.
 *
 * These cases are written from the attacker's side: each one is a header set a client can
 * actually send.
 */
const ip = (headers: Record<string, string>): string => clientIp(req("GET", "/x", { headers }));

describe("clientIp (trusted-hop only)", () => {
  it("prefers x-vercel-forwarded-for, which the platform overwrites on every request", () => {
    expect(ip({ "x-vercel-forwarded-for": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("IGNORES a spoofed first hop of x-forwarded-for when the trusted header is present", () => {
    // The whole attack, in one request: the client prepends its own value and Vercel appends the
    // truth. Trusting the first hop reads the lie.
    expect(ip({
      "x-forwarded-for": "1.2.3.4, 203.0.113.7",
      "x-vercel-forwarded-for": "203.0.113.7",
    })).toBe("203.0.113.7");
  });

  it("a client-supplied x-forwarded-for alone resolves to the LAST hop, never the first", () => {
    // No platform header (another host, or a local run). The last entry is the only one the
    // client cannot prepend to, because the nearest trusted proxy appends it.
    expect(ip({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.7" })).toBe("203.0.113.7");
  });

  it("a single-entry x-forwarded-for is still usable (the ordinary one-proxy case)", () => {
    expect(ip({ "x-forwarded-for": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("does NOT trust x-real-ip — it is an ordinary header any client can send", () => {
    // It used to be on the trusted list, under the comment "the platform headers a client
    // cannot set". That is true of `x-vercel-*`, which the edge overwrites, and false of
    // `x-real-ip`, which has no platform reservation at all: only a proxy that sets it makes
    // it meaningful, and any deployment without one hands every caller a
    // `curl -H 'x-real-ip: …'` switch for minting a fresh rate-limit bucket per request.
    //
    // On Vercel the bug was unreachable because the first entry always won — which is exactly
    // the shape of thing that survives review and then ships the day the host changes.
    expect(ip({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))
      .toBe("5.6.7.8");
    // With nothing else to go on it is ignored entirely rather than believed.
    expect(ip({ "x-real-ip": "203.0.113.9" })).toBe("");
  });

  it("a spoofed x-vercel-forwarded-for cannot be distinguished — which is why only the PLATFORM sets it", () => {
    // Documenting the trust boundary rather than pretending to enforce it in-process: Vercel
    // replaces `x-vercel-*` on ingress, so a client-sent value never survives. Behind any other
    // proxy this header must be stripped at the edge — the test states the requirement.
    expect(ip({ "x-vercel-forwarded-for": "1.2.3.4" })).toBe("1.2.3.4");
  });

  it("no forwarding headers at all → empty string, never a fabricated address", () => {
    expect(ip({})).toBe("");
    expect(ip({ "x-forwarded-for": "  ,  " })).toBe("");
  });

  it("whitespace and empty hops are discarded, not returned as an address", () => {
    expect(ip({ "x-forwarded-for": "1.2.3.4, , 203.0.113.7 " })).toBe("203.0.113.7");
  });

  it("serviceContext threads the trusted value — the lockout/audit key is not spoofable", async () => {
    const { deps } = await makeDeps();
    const ctx = serviceContext(deps, req("GET", "/x", {
      headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.7", "x-vercel-forwarded-for": "203.0.113.7" },
    }));
    expect(ctx.ip).toBe("203.0.113.7");
  });
});
