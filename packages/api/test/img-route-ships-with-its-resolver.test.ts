import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { trackerEvents } from "@trafficflow/db";
import type { HostResolver, RemoteFetch } from "@trafficflow/services/mail";
import { makeDeps, seedSession, seedMessage, seedBody, req, FIXED_NOW, ONE_BY_ONE_GIF } from "./helpers.js";

/**
 * ═══ `GET /img` SHIPS WITH ITS PUBLIC-URL RESOLVER — THE standing residual ══════════════
 *
 * The SSRF hole is closed; what survives it is a DEPLOY-ORDER obligation nobody was holding.
 * `/img` opens a socket to a host the SENDER named, and the only thing between that and this
 * machine's own network is `assertPublicHttpUrl` resolving the name through an INJECTED
 * resolver. Mount without the resolver — a second composition, a route moved to a module that
 * fetches for itself — and the proxy is an open one; nothing in the repo said so.
 *
 * Two halves, because either alone is decoration. The LIVE half drives the real app: hosts that
 * are ordinary public names and are private only in what the injected resolver answers, so a
 * route that skipped the gate, or one whose gate read a literal instead of the resolver, serves
 * 200. The STRUCTURAL half is the obligation itself: the mount and the guard cannot be separated
 * by an edit, and the addresses the guard returned are the ones the fetch is pinned to.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/** A public address for an unnamed host, so a mistyped probe is ADMITTED and reds its own case. */
const PUBLIC = "93.184.216.34";

/** The injected DNS port, recording every name it is asked. */
function resolverAnswering(table: Record<string, string[]>): { asked: string[]; resolver: HostResolver } {
  const asked: string[] = [];
  return {
    asked,
    resolver: {
      async resolve(hostname: string): Promise<string[]> {
        asked.push(hostname);
        return table[hostname] ?? [PUBLIC];
      },
    },
  };
}

/** The outbound port, recording url and pin — no socket, and the pin is the gate's own answer. */
function recordingRemote(): { calls: Array<{ url: string; pin: readonly string[] }>; remote: RemoteFetch } {
  const calls: Array<{ url: string; pin: readonly string[] }> = [];
  return {
    calls,
    remote: {
      async fetch(url, pin) {
        calls.push({ url, pin });
        return { status: 200, contentType: "image/gif", body: ONE_BY_ONE_GIF };
      },
    },
  };
}

/* Every address family the gate names, reached through a host that looks like an ordinary CDN.
   The last row is the one a first-record check admits: ANY refused record refuses the name. */
const REFUSED: Array<[label: string, host: string, answers: string[]]> = [
  ["a private address", "private.acme-cdn.com", ["10.1.2.3"]],
  ["loopback", "loopback.acme-cdn.com", ["127.0.0.1"]],
  ["link-local", "linklocal.acme-cdn.com", ["169.254.10.1"]],
  ["the cloud metadata address", "metadata.acme-cdn.com", ["169.254.169.254"]],
  ["an IPv4-mapped loopback", "mapped.acme-cdn.com", ["::ffff:127.0.0.1"]],
  ["one private record among public ones", "mixed.acme-cdn.com", [PUBLIC, "10.0.0.7"]],
];

describe("GET /img — the mounted route drives every target through the injected resolver", () => {
  /** The app, a consented message, and the two injected ports, for one probe. */
  async function rig(table: Record<string, string[]>): Promise<{
    ask: (u: string) => Promise<Response>;
    asked: string[];
    calls: Array<{ url: string; pin: readonly string[] }>;
    rows: () => Promise<unknown[]>;
  }> {
    const { asked, resolver } = resolverAnswering(table);
    const { calls, remote } = recordingRemote();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { resolver, remote });
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: true });
    return {
      ask: (u: string) => H(req("GET", `/img?mid=${id}&u=${encodeURIComponent(u)}`, { bearer: s.token }), deps),
      asked,
      calls,
      rows: async () => await db.select().from(trackerEvents),
    };
  }

  it("is mounted exactly once, as the GET route this file is about", () => {
    const img = apiRoutes.filter((r) => r.pattern === "/img");
    expect(img, "the pair this file asserts starts with the mount").toHaveLength(1);
    expect(img[0]!.method).toBe("GET");
  });

  it.each(REFUSED)("refuses %s by name, after asking the injected resolver", async (_label, host, answers) => {
    const r = await rig({ [host]: answers });
    const res = await r.ask(`https://${host}/hero.png`);

    // The resolver decided. Without this the case could pass on a literal check that never
    // needed a DNS port at all, which is the exact substitution this file exists to refuse.
    expect(r.asked, "the injected resolver was never asked about this host").toContain(host);

    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe("validation_failed");
    // BY NAME: `validation_failed` is also the url-length and scheme refusal. Only the gate's
    // prefix says WHICH arm answered, and the arm is the address one.
    expect(error.message).toMatch(/^u is not a permitted url: /);
    expect(error.message).toMatch(/non-public address/);

    expect(r.calls, "a refused target still opened a socket").toHaveLength(0);
    expect(await r.rows()).toHaveLength(0);
  });

  it("admits a public host, and pins the fetch to the addresses the resolver returned", async () => {
    const r = await rig({ "img.acme-cdn.com": [PUBLIC] });
    const res = await r.ask("https://img.acme-cdn.com/hero.png");

    // The positive control for all six refusals above: the same route, the same rig, one
    // different answer from the resolver, and the picture is served.
    expect(res.status, "the ordinary case must be admitted, or the refusals assert nothing").toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(r.asked).toContain("img.acme-cdn.com");

    // The gate's RETURN VALUE is the pin — that is the half that closes DNS rebinding, and a
    // fetch handed the hostname instead would resolve a second time.
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.pin).toEqual([PUBLIC]);
  });

  it("refuses an address LITERAL without a DNS lookup at all", async () => {
    const r = await rig({});
    const res = await r.ask("http://169.254.169.254/latest/meta-data/");
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/non-public address/);
    // A literal IS the pin; asking a resolver about it would be a name the gate never had.
    expect(r.asked, "a literal was handed to the DNS port").toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE STRUCTURAL HALF — the obligation, not a run of it
   ───────────────────────────────────────────────────────────────────────────────────────── */

const API_SRC = resolve(__dirname, "../src");
const ROUTE_FILE = resolve(API_SRC, "routes/privacy.ts");
const SERVICE_FILE = resolve(__dirname, "../../services/src/privacy-service.ts");

const walkDir = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
};

/* `typescript`'s own parser rather than text: a comment, a string and a regex all carry the
   words below, and three text scanners in `input-bounds-census.test.ts` were each defeated by
   ordinary valid source. A census satisfied by a symbol APPEARING passes for a file that never
   calls it, so every statement here is about a node. */
const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, /* setParentNodes */ true);

function* walk(node: ts.Node): Generator<ts.Node> {
  yield node;
  for (const child of node.getChildren()) yield* walk(child);
}

/** The value of a string-literal property of an object literal, or null. */
function propString(obj: ts.ObjectLiteralExpression, name: string): string | null {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || p.name.getText() !== name) continue;
    return ts.isStringLiteral(p.initializer) ? p.initializer.text : null;
  }
  return null;
}

const hasProp = (obj: ts.ObjectLiteralExpression, name: string): boolean =>
  obj.properties.some((p) => p.name !== undefined && p.name.getText() === name);

/** Every route-table entry in a file: an object literal carrying both a pattern and a handler. */
function routeLiterals(ast: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  for (const n of walk(ast)) {
    if (ts.isObjectLiteralExpression(n) && hasProp(n, "pattern") && hasProp(n, "handler")) out.push(n);
  }
  return out;
}

/** The nearest ancestor satisfying `pred`, or null. */
function ancestor(node: ts.Node, pred: (n: ts.Node) => boolean): ts.Node | null {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) if (pred(n)) return n;
  return null;
}

describe("the mount and the guard cannot be separated by an edit", () => {
  it("exactly one route table in packages/api/src mounts /img, and it is routes/privacy.ts", () => {
    const mounts: string[] = [];
    for (const file of walkDir(API_SRC)) {
      for (const lit of routeLiterals(parse(file))) if (propString(lit, "pattern") === "/img") mounts.push(file);
    }
    // Moving the mount into a module of its own — the shape that would leave the service, and
    // therefore the gate, behind — is this line going red. Compared as paths, so the failure
    // names the module the mount moved to.
    expect(mounts.map((f) => f.replace(/^.*\/src\//, ""))).toEqual(["routes/privacy.ts"]);
  });

  it("the /img handler's only outbound door is the privacy service", () => {
    const ast = parse(ROUTE_FILE);
    const mount = routeLiterals(ast).find((l) => propString(l, "pattern") === "/img");
    expect(mount, "the mount moved out of this module").toBeDefined();

    const handler = mount!.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "handler",
    );
    expect(handler).toBeDefined();

    const proxied = [...walk(handler!.initializer)].filter(
      (n) =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "proxyImage" &&
        ts.isCallExpression(n.expression.expression) &&
        n.expression.expression.expression.getText() === "privacy",
    );
    expect(proxied, "the handler no longer reaches `privacy(deps).proxyImage`").toHaveLength(1);

    // No door of its own. A handler that fetched directly would pass every service test in the
    // repo while the gate sat unreached, which is the failure this whole file is about.
    const doors = [...walk(ast)].filter(
      (n) =>
        (ts.isCallExpression(n) && n.expression.getText().split(".").pop() === "fetch") ||
        (ts.isPropertyAccessExpression(n) && n.getText() === "deps.remote"),
    );
    expect(doors.map((d) => d.getText()), "the route module opened a socket of its own").toEqual([]);

    const transports = [...walk(ast)].filter(
      (n) => ts.isImportDeclaration(n) && /^["'](node:(http|https|net|dns|dgram|tls)|undici)["']$/.test(n.moduleSpecifier.getText()),
    );
    expect(transports.map((t) => t.getText()), "the route module imported a transport").toEqual([]);
  });

  it("the service the route dispatches to cannot be constructed without a resolver", () => {
    const ast = parse(SERVICE_FILE);
    const deps = [...walk(ast)].find(
      (n): n is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(n) && n.name.text === "PrivacyServiceDeps",
    );
    expect(deps, "PrivacyServiceDeps is where the injected resolver is required").toBeDefined();

    const resolver = deps!.members.find(
      (m): m is ts.PropertySignature => ts.isPropertySignature(m) && m.name.getText() === "resolver",
    );
    expect(resolver, "the resolver left the service's dependency type").toBeDefined();
    // OPTIONAL is the whole failure: a composition that omits it still compiles, and every
    // deployment built from that composition mounts /img with no DNS port to refuse anything.
    expect(resolver!.questionToken, "the resolver became optional").toBeUndefined();
  });

  it("every remote fetch in proxyImage is preceded by the gate, on the url it fetches", () => {
    const ast = parse(SERVICE_FILE);
    const method = [...walk(ast)].find(
      (n): n is ts.MethodDeclaration => ts.isMethodDeclaration(n) && n.name.getText() === "proxyImage",
    );
    expect(method, "proxyImage moved out of privacy-service.ts").toBeDefined();

    const gates = [...walk(method!.body!)].filter(
      (n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText() === "assertPublicHttpUrl",
    );
    expect(gates, "the gate call left proxyImage").toHaveLength(1);
    // The INJECTED port, not a default: a `node:dns` fallback resolves for real inside whatever
    // network the deployment sits in, which is the private network the gate is about.
    expect(gates[0]!.arguments[1]!.getText()).toBe("this.deps.resolver");

    // The gate's return value is bound to a name, and that name is what the fetch is pinned to.
    const bound = ancestor(gates[0]!, ts.isVariableDeclaration) as ts.VariableDeclaration | null;
    expect(bound, "the gate's answer is not bound to anything — the pin was thrown away").not.toBeNull();
    const pin = bound!.name.getText();

    const fetches = [...walk(ast)].filter(
      (n): n is ts.CallExpression =>
        ts.isCallExpression(n) && n.expression.getText() === "this.deps.remote.fetch",
    );
    expect(fetches, "every outbound fetch this file makes must be the one the gate covers").toHaveLength(1);
    expect(ancestor(fetches[0]!, (n) => n === method!), "a fetch outside proxyImage").not.toBeNull();

    const f = fetches[0]!;
    // Same loop, gate first, same url, and the pin the gate produced.
    expect(ancestor(f, ts.isForStatement)).toBe(ancestor(gates[0]!, ts.isForStatement));
    expect(gates[0]!.getStart()).toBeLessThan(f.getStart());
    expect(f.arguments[0]!.getText()).toBe(gates[0]!.arguments[0]!.getText());
    expect(f.arguments[1]!.getText()).toBe(pin);
  });
});
