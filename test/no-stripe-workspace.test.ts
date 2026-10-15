import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs helper, no declarations by design.
import { specifiersIn } from "../scripts/lib/import-closure.mjs";

/**
 * THE BILLING PLANE IS A SEPARATE PROGRAM, AND THE DENY-LIST STOPPED BEING THE PROOF.
 *
 * While the server was private, "no Stripe in the open product" was enforced by publication:
 * the billing service lived in a denied directory, so whatever it imported never left. The
 * billing machinery then moved OUT of this repository into a separate service reached over a
 * documented HTTP API (the services package's plane client is the open client
 * of it), and the whole server joined the published payload — at which point the deny-list
 * says nothing about the boundary any more. What keeps the plane a separate program now has to
 * be STRUCTURAL: no workspace package declares the Stripe SDK, and no library source imports
 * it. The day either stops being true, the open product links the payment vendor again and the
 * plane split has silently un-happened — with the licence consequences that split exists to
 * avoid, because whatever links these AGPL packages and serves customers must be offerable to
 * those customers.
 *
 * Two halves, because they fail differently:
 *   · a MANIFEST declaration is how the dependency arrives ("just add the SDK for a type");
 *   · a SOURCE import is how it gets used even with the manifest half green (a stray
 *     type-only import of the SDK resolves through hoisting in a pnpm workspace).
 *
 * The checker is a pure function over (name, manifest) / (path, source) pairs, and the suite
 * runs it against PLANTED fixtures as well as the real tree — a detector nobody has watched
 * fail is not evidence, and this repository has shipped one that printed a violation and then
 * reported success.
 *
 * If the operator console ever genuinely needs the SDK, exempt it BY NAME here with
 * the argument written next to it. Nothing else may be exempted: the plane is the place Stripe
 * lives, and the plane is not in this repository.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..");

/** `stripe` itself and the `@stripe/*` scope — the SDK and the vendor's client libraries. */
const isStripePackage = (name: string): boolean => name === "stripe" || name.startsWith("@stripe/");

/** The Stripe packages a manifest declares, across every dependency field npm installs from. */
function stripeDeclarations(manifest: { [k: string]: unknown }): string[] {
  const out: string[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = manifest[field];
    if (deps && typeof deps === "object") {
      for (const name of Object.keys(deps)) if (isStripePackage(name)) out.push(`${field}.${name}`);
    }
  }
  return out;
}

/** The Stripe specifiers a source imports, `import type` and dynamic forms included. */
function stripeImportsIn(src: string): string[] {
  return (specifiersIn(src) as string[]).filter(isStripePackage);
}

function workspaceManifests(): { rel: string; json: { [k: string]: unknown } }[] {
  const out: { rel: string; json: { [k: string]: unknown } }[] = [];
  // The ROOT manifest too: a hoisted workspace devDependency installs for every package, so
  // one line there hands the SDK to the whole tree without any packages/* manifest changing.
  out.push({ rel: "package.json", json: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) });
  for (const area of ["packages", "apps"]) {
    const base = join(ROOT, area);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const rel = `${area}/${name}/package.json`;
      if (!existsSync(join(ROOT, rel))) continue;
      out.push({ rel, json: JSON.parse(readFileSync(join(ROOT, rel), "utf8")) });
    }
  }
  return out;
}

/**
 * Every library AND composition-root source — each `packages/<pkg>/src` and each `apps/<app>/src`.
 * The apps are where a stray import would actually link the vendor into a served program (the
 * exact composition AGPL §13 runs along), so scanning the packages alone proved the parts and
 * not the products.
 */
function librarySources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if ([".ts", ".tsx", ".mjs", ".js"].includes(extname(name))) out.push(rel);
    }
  };
  for (const area of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, area))) {
      const src = `${area}/${pkg}/src`;
      if (existsSync(join(ROOT, src))) walk(src);
    }
  }
  return out;
}

describe("no workspace package links Stripe — the billing plane is a separate program", () => {
  it("no packages/* or apps/* manifest declares the SDK", () => {
    const manifests = workspaceManifests();
    // The walker found the workspace, not an empty directory.
    expect(manifests.length).toBeGreaterThan(10);
    const violations = manifests
      .flatMap(({ rel, json }) => stripeDeclarations(json).map((d) => `${rel}: ${d}`));
    expect(violations, "a workspace manifest declares the payment vendor's SDK — that belongs " +
      "to the billing plane, which is a separate service, not a package of this repository")
      .toEqual([]);
  });

  it("no library source imports it", () => {
    const sources = librarySources();
    expect(sources.length).toBeGreaterThan(200);
    const violations: string[] = [];
    for (const rel of sources) {
      const hits = stripeImportsIn(readFileSync(join(ROOT, rel), "utf8"));
      if (hits.length) violations.push(`${rel} → ${hits.join(", ")}`);
    }
    expect(violations, "a shared library imports the Stripe SDK — the plane boundary is broken")
      .toEqual([]);
  });

  /**
   * THE POSITIVE CONTROLS — planted fixtures, so a green above means "looked and found
   * nothing", never "stopped looking". The manifest fixture is the exact shape a real
   * regression takes: one line in `dependencies`.
   */
  it("flags a planted manifest declaration", () => {
    expect(stripeDeclarations({ dependencies: { stripe: "^14.0.0" } }))
      .toEqual(["dependencies.stripe"]);
    expect(stripeDeclarations({ devDependencies: { "@stripe/stripe-js": "^4.0.0" } }))
      .toEqual(["devDependencies.@stripe/stripe-js"]);
    // …and only the vendor's packages, not lookalikes: a name merely containing the word is
    // not the SDK, and a rule that flagged it would be a rule somebody weakens.
    expect(stripeDeclarations({ dependencies: { "stripe-mock-server": "1.0.0", hono: "^4" } }))
      .toEqual([]);
  });

  it("flags a planted source import, type-only and dynamic forms included", () => {
    // Each planted import is joined when the case runs, so an import scanner reading this file finds no package.
    const sdk = JSON.stringify("stripe");
    expect(stripeImportsIn(`import Stripe from ${sdk};`)).toEqual(["stripe"]);
    expect(stripeImportsIn(`import type Stripe from ${sdk};`)).toEqual(["stripe"]);
    expect(stripeImportsIn(`const s = await import(${sdk});`)).toEqual(["stripe"]);
    expect(stripeImportsIn(`const s = require(${sdk});`)).toEqual(["stripe"]);
    // A mention in prose is not an import — the seam test next door has the same calibration.
    expect(stripeImportsIn("// the plane talks to stripe; this file does not")).toEqual([]);
  });
});
