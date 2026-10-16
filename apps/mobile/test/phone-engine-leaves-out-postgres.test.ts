/**
 * Three Postgres-only modules leave the phone's engine through `WORKSPACE_MODULE_SUBSTITUTES` in
 * `apps/sidecar/src/phone/aliases.js`: `/health`'s schema markers, the Postgres dialect and the
 * `/events` stream every local composition switches off. The folder-ops singleton left by being
 * deleted. This file reads all four out of the artifact, then drives the twins through a bundle
 * built under the same table: a device store answers as it does today, and a Postgres-branded
 * handle is refused BY NAME, never answered with an empty census.
 */
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eventsRoutes as realEventsRoutes } from "../../../packages/api/src/routes/events.js";
import { REPO, buildPhoneEngine, bundleProbe } from "../scripts/bundle-engine.mjs";

const require_ = createRequire(import.meta.url);
/* The API package's `local` entry as the sidecar resolves it. Its name is read from its manifest:
   this app's privacy census refuses the workspace's scope spelled anywhere under it. */
const API_NAME = (JSON.parse(readFileSync(join(REPO, "packages", "api", "package.json"), "utf8")) as { name: string }).name;
const API_LOCAL = createRequire(join(REPO, "apps", "sidecar", "package.json")).resolve(`${API_NAME}/local`);

const TWINS = [
  "apps/sidecar/src/phone/dialect-pg.ts",
  "apps/sidecar/src/phone/events.ts",
  "apps/sidecar/src/phone/health-markers.ts",
];
/* `search-setup` is named beside the dialect because it calls `pgDialect()` at MODULE LOAD: with
   the twin in place, that module entering the graph is a crash at import on every phone. */
const LEFT_OUT = /^packages\/(?:api\/(?:src|dist)\/routes\/(?:health-markers|events)|db\/(?:src|dist)\/(?:dialect\/pg|search-setup))\.[jt]s$/;
const FOLDER_OPS = /^packages\/services\/(?:src|dist)\/folder-ops-service\.[jt]s$/;

type Route = { method: string; pattern: string; cost: string; options?: unknown;
  handler: (req: Request, deps: unknown, params: Record<string, string>) => Promise<Response> };
type Probe = {
  probeDatabase: (db: unknown) => Promise<{ kind: string; schemaOk?: boolean }>;
  healthRoutes: Route[];
  localRoutes: Route[];
  dialect: (db: unknown) => unknown;
  brandDialect: <T extends object>(db: T, name: "pg" | "sqlite") => T;
};

describe("the artifact carries none of them", () => {
  it("the three twins are inputs, the real modules are not, and the table applied each row once", async () => {
    const { inputs, applied, metafile } = await buildPhoneEngine({ write: false });
    expect(inputs.filter((p: string) => LEFT_OUT.test(p))).toEqual([]);
    expect(inputs.filter((p: string) => TWINS.includes(p)).sort()).toEqual(TWINS);
    const rows = applied.filter(([, to]: [string, string]) => TWINS.some((t) => to.endsWith(t)));
    expect(rows.map(([from]: [string, string]) => from).sort())
      .toEqual(["./events.js", "./health-markers.js", "./pg.js"]);
    // The modules that import them are still in, so each twin answers a real importer.
    for (const importer of [/api\/(dist|src)\/routes\/health\./, /db\/(dist|src)\/dialect\/index\./,
      /api\/(dist|src)\/routes\/local\./]) {
      expect(inputs.some((p: string) => importer.test(p)), String(importer)).toBe(true);
    }
    /* The services barrel still re-exports the class, so the module is PARSED; what matters is
       that none of its code is in the artifact. */
    const out = Object.values(metafile.outputs as Record<string, { inputs: Record<string, { bytesInOutput: number }> }>)[0]!.inputs;
    const folderOps = Object.entries(out).filter(([p]) => FOLDER_OPS.test(p));
    expect(folderOps.every(([, v]) => v.bytesInOutput < 64), JSON.stringify(folderOps)).toBe(true);
  }, 120_000);
});

describe("on a bundle built under the same table", () => {
  let dir = "";
  let phone: Probe;
  let probeInputs: string[] = [];
  beforeAll(async () => {
    const src = (...p: string[]) => JSON.stringify(join(REPO, "packages", ...p));
    const probe = await bundleProbe(
      `export { probeDatabase, healthRoutes } from ${src("api", "src", "routes", "health.ts")};\n`
      /* The file the engine's own specifier resolves to, so the probe holds ONE route table, as
         the artifact does: the twin imports its refusal from this entry, and a second copy of the
         table would be evaluated before the twin it spreads. */
      + `export { localRoutes } from ${JSON.stringify(API_LOCAL)};\n`
      + `export { dialect, brandDialect } from ${src("db", "src", "dialect", "index.ts")};\n`,
    );
    dir = probe.dir;
    probeInputs = Object.keys((probe.metafile as { inputs: Record<string, unknown> }).inputs);
    // The two native requires: Node's crypto answers one, and nothing here dials a socket.
    const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
    const original = Module._load;
    Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
      if (request === "react-native-quick-crypto") return require_("node:crypto");
      if (request === "react-native-tcp-socket") return {};
      return original.call(this, request, parent, isMain);
    };
    try {
      phone = require_(probe.bundlePath) as Probe;
    } finally { Module._load = original; }
  }, 180_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const deviceStore = () => phone.brandDialect({ all: async () => [[1]] }, "sqlite");
  /* A Postgres handle whose statement answers a well-formed row of zeros: a twin that answered an
     empty tier instead of refusing would read that as `schemaOk: true`. */
  const pgStore = () => phone.brandDialect({
    execute: async () => [{ one: 1, pg_trgm: true, schema_markers: 0, type_markers: 0, index_markers: 0,
      check_markers: 0, check_def_markers: 0, function_def_markers: 0, fk_markers: 0 }],
  }, "pg");
  const healthDeps = (db: unknown) => ({
    db, allowCookieAuth: true,
    health: { version: "probe", kek: null, kekError: null, buildError: null, schemaTier: "mail" },
  });

  it("the probe is built under the same table", () => {
    expect(probeInputs.filter((p) => LEFT_OUT.test(p))).toEqual([]);
    expect(probeInputs.filter((p) => TWINS.includes(p)).sort()).toEqual(TWINS);
  });

  it("a device store answers live, and /health 200 with the device body", async () => {
    expect((await phone.probeDatabase(deviceStore())).kind).toBe("live");
    const route = phone.healthRoutes.find((r) => r.pattern === "/health")!;
    const res = await route.handler(new Request("http://phone.local/health"), healthDeps(deviceStore()), {});
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("schemaMarkers");
    expect(body).not.toHaveProperty("schemaOk");
  });

  it("a Postgres-branded handle is refused by name: the dialect, and the probe OUT of the function", async () => {
    expect(() => phone.dialect(pgStore())).toThrow(/Postgres dialect/);
    await expect(phone.probeDatabase(pgStore())).rejects.toThrow(/schema markers/);
  });

  it("/events answers the real route's refusal, byte for byte", async () => {
    const twin = phone.localRoutes.filter((r) => r.pattern === "/events");
    const real = realEventsRoutes.find((r) => r.pattern === "/events")!;
    expect(twin).toHaveLength(1);
    const { handler: _t, ...twinShape } = twin[0]!;
    const { handler: _r, ...realShape } = real;
    expect(twinShape).toEqual(realShape);
    const req = new Request("http://phone.local/events");
    const fromTwin = await twin[0]!.handler(req, { session: { accountId: "a" } }, {});
    const fromReal = await real.handler(req, { session: { accountId: "a" }, sse: { enabled: false } } as never, {});
    expect(fromTwin.status).toBe(503);
    expect([...fromTwin.headers]).toEqual([...fromReal.headers]);
    const text = await fromTwin.text();
    expect(text).toBe(await fromReal.text());
    expect(text).toContain("sse_disabled");
  });
});
