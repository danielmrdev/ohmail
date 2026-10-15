import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_CSP,
  SHARED_CSP_DIRECTIVES,
  STATIC_SECURITY_HEADERS,
  newNonce,
  nonceCsp,
} from "../app/security-headers.js";

/**
 * THE ORIGIN SHIPS A POLICY.
 *
 * `packages/services/src/auth/origins.ts` states that the "the landing is never an auth
 * origin" is gone and that NOTHING at the origin layer can replace it. What can still be
 * enforced is what the browser enforces on this origin's documents — and until this repair
 * `ohmail.app` sent no CSP, no `X-Frame-Options`, no `Referrer-Policy` and no `nosniff`,
 * while a sibling app on another origin (holding strictly less) sent four headers on every path.
 *
 * `proxy.e2e.test.ts` measures the headers on a real `next start`. This file pins the
 * POLICY: what the directives are, that the two copies of them agree, and the properties
 * that are the reason for having it at all.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const nextConfig = readFileSync(`${HERE}../next.config.mjs`, "utf8");

/** Pull a `const NAME = [ … ].join("; ")`-style directive array out of the config source. */
function configList(name: string): string[] {
  const body = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\]`).exec(nextConfig)?.[1];
  expect(body, `${name} not found in next.config.mjs`).toBeDefined();
  return [...body!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the two copies of the policy cannot drift", () => {
  it("SHARED_CSP is identical in next.config.mjs and app/security-headers.ts", () => {
    // Two copies exist because `next.config.mjs` cannot import TypeScript, and middleware
    // cannot import `next.config.mjs` without dragging `next-intl/plugin` into the edge
    // bundle. So they are held together here.
    expect(configList("SHARED_CSP")).toEqual([...SHARED_CSP_DIRECTIVES]);
  });

  it("the baseline policy is the shared directives plus one script-src", () => {
    expect(BASELINE_CSP).toBe([...SHARED_CSP_DIRECTIVES, "script-src 'self' 'unsafe-inline'"].join("; "));
    expect(nextConfig).toContain(`const BASELINE_CSP = [...SHARED_CSP, "script-src 'self' 'unsafe-inline'"].join("; ")`);
  });

  it("the three non-CSP headers match admin's intent", () => {
    const keys = STATIC_SECURITY_HEADERS.map(([k]) => k);
    expect(keys).toEqual(["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"]);
    for (const [key, value] of STATIC_SECURITY_HEADERS) {
      expect(nextConfig, `${key} missing from next.config.mjs`).toContain(`{ key: "${key}", value: "${value}" }`);
    }
  });
});

describe("the directives that are the point", () => {
  const directives = new Map(
    SHARED_CSP_DIRECTIVES.map((d) => {
      const [name, ...rest] = d.split(" ");
      return [name!, rest.join(" ")] as const;
    }),
  );

  it("connect-src is 'self' — injected script cannot SEND what it can read", () => {
    // The direct answer to the loss origins.ts documents. Under one origin a script on the
    // marketing surface can read the non-HttpOnly `tf_csrf` and issue same-origin
    // authenticated requests; this is what stops the result leaving the origin.
    expect(directives.get("connect-src")).toBe("'self'");
  });

  it("frame-ancestors is 'none' — clickjacking stops being an accident", () => {
    // It was previously blocked only as a SIDE EFFECT of SameSite=Strict: a framed request
    // carries no cookie, so the gate renders marketing and there is nothing to steal.
    // Relaxing the cookie to Lax for any reason would have silently undone that.
    expect(directives.get("frame-ancestors")).toBe("'none'");
  });

  it("the classic exfiltration and injection channels are closed", () => {
    expect(directives.get("form-action")).toBe("'self'");
    expect(directives.get("base-uri")).toBe("'self'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("default-src")).toBe("'self'");
  });

  it("no directive admits an off-origin host — the runtime twin of no-third-party.test.ts", () => {
    for (const directive of SHARED_CSP_DIRECTIVES) {
      expect(directive, directive).not.toMatch(/https?:\/\//);
      expect(directive, directive).not.toMatch(/\*/);
    }
  });
});

describe("the strict policy, and the honest limit of the baseline one", () => {
  it("a nonce policy DROPS unsafe-inline for scripts", () => {
    const csp = nonceCsp("AbCd1234");
    expect(csp).toContain("script-src 'self' 'nonce-AbCd1234'");
    expect(csp).not.toContain("'unsafe-inline' 'nonce-");
    // Belt: every non-script directive is carried over unchanged.
    for (const d of SHARED_CSP_DIRECTIVES) expect(csp).toContain(d);
  });

  it("the baseline KEEPS unsafe-inline for scripts, and that is stated not hidden", () => {
    // Not an oversight. The App Router inlines its RSC payload as `<script>self.__next_f…`
    // with content that differs per page and per build, so it cannot be hashed from a
    // config file — which leaves a nonce, and a nonce is per-request, so a document
    // carrying one cannot be a static prerender. Anonymous `/` IS a static prerender, on
    // purpose (middleware.ts: keeping it CDN-cacheable is most of why the gate refuses to
    // fetch without a cookie), and a CDN would cache one nonce and serve it to everyone.
    expect(BASELINE_CSP).toContain("script-src 'self' 'unsafe-inline'");
    const src = readFileSync(`${HERE}../app/security-headers.ts`, "utf8");
    expect(src).toContain("THE ONE DIRECTIVE THAT IS NOT STRICT");
  });

  it("each nonce is fresh, and long enough to be one", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(n).toMatch(/^[A-Za-z0-9+/]{20,}={0,2}$/);
  });
});

describe("the demo route is the real client, framable and otherwise baseline", () => {
  const demoCsp = configList("DEMO_CSP");

  it("runs the shipped bundle — it does NOT seal the way a static document could", () => {
    // The demo is now the real mail client in demo mode (`app/(product)/demo/page.tsx`), not
    // a hand-written HTML file, so it needs the baseline bundle policy to run at all: `'self'`
    // scripts for the /_next chunks, `'self'` connect for whatever the framework does (the
    // FixturesAdapter itself makes no request, so 'self' is a ceiling nothing reaches, not a
    // grant). A sealed `default-src 'none'; connect-src 'none'` would render a blank frame.
    expect(demoCsp).toContain("default-src 'self'");
    expect(demoCsp).toContain("connect-src 'self'");
    expect(demoCsp).toContain("script-src 'self' 'unsafe-inline'");
    expect(demoCsp.join("; ")).not.toMatch(/https?:\/\//);
  });

  it("is the baseline in every directive EXCEPT framing", () => {
    // The one relaxation off the baseline, and the reason it is safe: this surface holds no
    // session and no action to clickjack, while the live app at `/` keeps 'none'.
    const swapped = SHARED_CSP_DIRECTIVES.map((d) =>
      d === "frame-ancestors 'none'" ? "frame-ancestors 'self'" : d,
    );
    expect(demoCsp).toEqual([...swapped, "script-src 'self' 'unsafe-inline'"]);
    expect(demoCsp).not.toContain("frame-ancestors 'none'");
  });

  it("is framable by THIS origin and no other", () => {
    expect(demoCsp).toContain("frame-ancestors 'self'");
    expect(nextConfig).toContain(`{ key: "X-Frame-Options", value: "SAMEORIGIN" }`);
  });

  it("the blanket rule EXCLUDES /demo rather than being overridden by it", () => {
    // Two CSP headers are not "last one wins" — a browser enforces both, so the effective
    // policy is their intersection. A blanket `frame-ancestors 'none'` plus a `/demo`
    // override of `'self'` would intersect to `'none'` and render the landing's centrepiece
    // as a blank frame, so the blanket rule EXCLUDES /demo by negative lookahead.
    expect(nextConfig).toContain(`source: "/((?!demo).*)"`);
    expect(nextConfig).toContain(`source: "/demo"`);
    expect(nextConfig.indexOf(`source: "/demo"`)).toBeLessThan(nextConfig.indexOf(`"/((?!demo).*)"`));
  });
});

describe("one policy per route group, with and without the website's measurement id", () => {
  /** The CSPs the header rules give `path`, through Next's own matcher. */
  async function cspsAt(gaId: string | null, path: string, zone: string | null = null): Promise<string[]> {
    const { headerRules } = await import("../next.config.mjs");
    const { getPathMatch } = await import("next/dist/shared/lib/router/utils/path-match");
    return (headerRules(gaId, zone) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>)
      .filter((r) => getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(path) !== false)
      .flatMap((r) => r.headers.filter((h) => h.key === "Content-Security-Policy").map((h) => h.value));
  }
  const GROUPS = {
    marketing: ["/", "/de", "/privacy", "/imprint", "/subprocessors"],
    product: ["/mailbox", "/resume", "/login", "/join", "/setup", "/link-desktop", "/approve", "/subscribed"],
    other: ["/no-such-page", "/api/session", "/_next/static/x.js", "/version"],
  };

  it("no id: every group is the baseline, exactly as before", async () => {
    for (const p of Object.values(GROUPS).flat()) expect(await cspsAt(null, p), p).toEqual([BASELINE_CSP]);
  });

  it("with an id: marketing gains Google's sources and nothing else", async () => {
    for (const p of GROUPS.marketing) {
      const [csp, ...rest] = await cspsAt("G-9SPZX4FS1X", p);
      expect(rest, p).toEqual([]);
      expect(csp, p).toContain("script-src 'self' 'unsafe-inline' https://www.googletagmanager.com");
      expect(csp!.replace(/ https:\/\/[^ ;]+/g, ""), p).toBe(BASELINE_CSP);
    }
  });

  it("with an id: product routes, the 404 and every asset keep the exact baseline", async () => {
    for (const p of [...GROUPS.product, ...GROUPS.other]) {
      expect(await cspsAt("G-9SPZX4FS1X", p), p).toEqual([BASELINE_CSP]);
    }
  });

  it("with an id: the demo keeps its own policy, alone and without Google", async () => {
    expect(await cspsAt("G-9SPZX4FS1X", "/demo")).toEqual(await cspsAt(null, "/demo"));
    expect((await cspsAt("G-9SPZX4FS1X", "/demo"))[0]).not.toMatch(/google/);
  });

  it("armed landing zone: the website sends its own policy, so ours leaves its paths and Google leaves us", async () => {
    // Two policies intersect, so the zone's paths carry none from here; the build refuses an id beside
    // a zone, and the rules name no Google host even when handed one.
    const zone = "https://site.ohmail.app";
    for (const p of GROUPS.marketing) expect(await cspsAt(null, p, zone), p).toEqual([]);
    for (const p of [...GROUPS.product, ...GROUPS.other]) expect(await cspsAt(null, p, zone), p).toEqual([BASELINE_CSP]);
    expect(await cspsAt(null, "/demo", zone)).toEqual(await cspsAt(null, "/demo"));
    for (const p of Object.values(GROUPS).flat()) {
      for (const csp of await cspsAt("G-9SPZX4FS1X", p, zone)) expect(csp, p).not.toMatch(/google/);
    }
  });
});
