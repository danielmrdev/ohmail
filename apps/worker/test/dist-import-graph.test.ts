import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

// THE BUILD IS GREEN AND THE PROGRAM CANNOT START.
//
// `tsc` keeps a bare specifier as written, so an import of a `@trafficflow/core` leaf whose
// exports target is a .ts file compiles and typechecks. Node then resolves that .ts at run time,
// strips the types, and fails on the file's OWN `./types.js` — `ERR_MODULE_NOT_FOUND`, at boot,
// in a container, after every gate was green. 0.16.2 shipped exactly that into a worker image.
//
// So this walks the real graph: it imports the BUILT entry in a subprocess and reads stderr. The
// database URL points at a closed port on purpose — the graph is loaded before anything dials, so
// a connection refusal is the ACCEPTED shape and a missing module is the finding. Nothing here
// asserts the worker runs; it asserts the worker can be loaded.
const ROOT = new URL("../../../", import.meta.url).pathname;
const ENTRY = `${ROOT}apps/worker/dist/index.js`;

// A port nothing listens on: the boot fails fast rather than hanging on a real server.
const DEAD_DB = "postgres://nobody:nobody@127.0.0.1:1/nothing";

describe("the built worker's module graph resolves under Node", () => {
  it("has a build to read", () => {
    // Refused, not skipped: the class this guards is invisible without a build, and a skip here
    // would read as a pass in exactly the run that matters.
    expect(existsSync(ENTRY), `${ENTRY} is absent — build the workspace's packages before this suite`).toBe(true);
  });

  it("loads without ERR_MODULE_NOT_FOUND", () => {
    const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(ENTRY)}).catch((e) => { console.error(String(e && e.code || e)); process.exit(0); })`], {
      env: {
        ...process.env,
        DATABASE_URL: DEAD_DB,
        DB_URL: DEAD_DB,
        NODE_ENV: "test",
        OHMAIL_WORKER_SELFTEST: "1",
      },
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    const err = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    expect(r.error?.message ?? "", "the subprocess could not be started").not.toMatch(/ENOENT/);
    // The finding, named with what Node said.
    const missing = /ERR_MODULE_NOT_FOUND[\s\S]*/.exec(err);
    expect(missing?.[0]?.slice(0, 400) ?? "", "the built graph has an unresolvable import").toBe("");
    // And the accepted shapes, so a silent empty run cannot pass for a loaded graph: either the
    // import settled (any outcome) or the process was still alive when the box expired.
    expect(r.status === 0 || r.signal === "SIGKILL", `neither settled nor timed out: status=${r.status} signal=${r.signal}`).toBe(true);
  }, 90_000);
});
