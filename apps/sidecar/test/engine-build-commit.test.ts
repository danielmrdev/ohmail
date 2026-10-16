import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSidecar, type Sidecar, type SidecarConfig } from "../src/engine.js";
import { freshDataDir as templatedDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

/**
 * ═══ WHICH BUILD THIS ENGINE IS ════════════════════════════════════════════════════════════════
 *
 * The desktop download is ONE artifact with two halves: a Rust shell and this engine. The window
 * has always been able to name the commit it was built from; the engine could name none, so the
 * reproducibility gate (`scripts/verify-engine-repro.mjs`) could build this source twice and never
 * tie that evidence to the engine a person is actually running. The shell now bakes its commit
 * (`build.rs`), hands it over at spawn (`OHMAIL_BUILD_COMMIT`, composed by `config::env_for`), and
 * this is where the engine says it: `/health.buildCommit`.
 *
 * `/health` is asked rather than the config re-read, because the claim is about what a READER of a
 * running engine can learn — the gate's `--against` takes a health document and nothing else.
 *
 * Three states, and they are three: a commit, the literal `unknown` (a build that could not name
 * itself), and ABSENT (nothing told this engine — a dev run, or a shell older than the knob). The
 * third is the positive control: collapsing it into `null` would make a hosted deployment look
 * like a host that reports a build commit and has none.
 */

const dataDirs: string[] = [];
const engines: Sidecar[] = [];

afterEach(async () => {
  for (const s of engines.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Nothing is dialled here: the claim is about a published field, not about mail. */
const dialsNothing = (() => ({
  connect: async () => undefined,
  send: async () => { throw new Error("this engine was asked to send"); },
  messageInSent: async () => null,
  close: async () => undefined,
  changesSince: async () => ({ messages: [], truncated: false }),
  ensureFolders: async () => undefined,
})) as unknown as SidecarConfig["adapterFactory"];

async function anEngine(buildCommit?: string): Promise<Sidecar> {
  const dataDir = await templatedDataDir("ohmail-build-commit-");
  dataDirs.push(dataDir);
  const sidecar = await createSidecar({
    dataDir,
    imap: {
      host: "imap.example.test",
      port: 993,
      secure: true,
      auth: { user: `t-${randomUUID()}@trafficflow.test` },
    },
    address: `t-${randomUUID()}@trafficflow.test`,
    displayName: "This Mac",
    adapterFactory: dialsNothing,
    pollIntervalMs: 60 * 60 * 1000,
    ...(buildCommit === undefined ? {} : { buildCommit }),
  });
  engines.push(sidecar);
  return sidecar;
}

async function healthOf(sidecar: Sidecar): Promise<Record<string, unknown>> {
  const res = await sidecar.handle(new Request("http://sidecar/health"));
  return await res.json() as Record<string, unknown>;
}

describe("the engine names the build the shell handed it", () => {
  it(
    "publishes the shell's commit at /health, publishes `unknown` as it stands, and says nothing when nobody told it",
    async () => {
      const sha = "e".repeat(40);
      expect((await healthOf(await anEngine(sha))).buildCommit).toBe(sha);

      // `unknown` travels verbatim: a build that could not identify itself is a different answer
      // from a launch that was never told, and the repro gate refuses that word BY NAME.
      expect((await healthOf(await anEngine("unknown"))).buildCommit).toBe("unknown");

      // THE POSITIVE CONTROL. An engine nobody told carries no key at all — absent, never null.
      const untold = await healthOf(await anEngine());
      expect("buildCommit" in untold).toBe(false);
      // …and it is still an ordinary healthy engine, so the absence is the only difference.
      expect(untold.ok).toBe(true);
    },
    PGLITE_STANDUP_BUDGET_MS * 3,
  );
});
