import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDataDir } from "../_datadir.js";
import { SCREEN_DESTINATIONS, StaticKeyProvider } from "@trafficflow/core/mail";
import type { ClassifierInput } from "@trafficflow/core/mail";
import { hasInstalledModel } from "@trafficflow/core/model-name";
import { createLocalAi, originIsThisMachine, type LocalAi } from "../../src/ai-provider.js";
import { createSidecarLog } from "../../src/log.js";

/**
 * A REAL MODEL, RUNNING ON THIS MACHINE, ANSWERING THE REAL SCREENING QUESTION.
 *
 * Every other test of this seam drives a recorded transport, which is the right instrument for
 * "what bytes would leave this machine" and is worth exactly nothing for "does a local model
 * actually answer this". Those are different claims and only one of them can be checked by
 * inspecting a request:
 *
 *  · The recorded tests prove the REQUEST is right — the shared prefix, the schema, the address.
 *  · This one proves the ANSWER comes back and survives the coercion into something the Screener
 *    can act on. A prompt and a schema that a hosted model handles and a 0.5B local model turns
 *    into unusable prose would pass every recorded test in this package.
 *
 * The second is the claim the README makes to a self-hoster, so it gets an instrument that can
 * falsify it.
 *
 * ── IT SKIPS WHEN NOTHING IS LISTENING, AND A SKIP MUST NOT LOOK LIKE A PASS ────────────────
 *
 * There is no model server in CI, so these skip rather than fail when nothing answers on
 * {@link OLLAMA_BASE}. That has to be a REAL skip, and the first version of this file got it
 * wrong in the way this repository has a standing warning about: it wrote `if (!reachable)
 * return;`, which vitest records as a PASSED test. Four green ticks, no model contacted, and the
 * comment above them claimed the skip was loud. A bare `return` is the purest form of a failure
 * reporting success — the assertions never ran and the report says they did.
 *
 * {@link skipWithReason} calls `ctx.skip()` instead, so the line reads as skipped in the summary.
 * A skipped test is a test that did not run, and the report now says so where somebody counting
 * greens would see it. The REASON is PRINTED rather than handed to `ctx.skip()`, which takes no
 * argument on this vitest and drops one silently — see that helper.
 *
 * To run it: start Ollama, then `ollama pull llama3.2` for the main checks and
 * `ollama pull qwen2.5:0.5b` for the ceiling check. Each gates on the model IT uses, so pulling
 * only one runs that half and skips the other, printing the reason.
 */

const OLLAMA_BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434";
/**
 * THE MODEL THE PRODUCT ITSELF NAMES — `DEFAULT_OLLAMA.classifyModel`, and the one the README
 * tells a self-hoster to pull. Testing the documented default is the point: a green against some
 * other model would not be evidence for the sentence anybody is going to read.
 */
const MODEL = process.env.OLLAMA_E2E_MODEL ?? "llama3.2";

/**
 * A model small enough to FAIL, kept deliberately.
 *
 * `qwen2.5:0.5b` does not merely answer worse — under the drafting schema it falls into a
 * repetition loop and never emits a stopping token. That is the case the token ceiling exists for,
 * and the only way to know the ceiling works is to run the thing that hits it.
 */
const TOO_SMALL_MODEL = process.env.OLLAMA_E2E_SMALL_MODEL ?? "qwen2.5:0.5b";

/** The daemon answered at all. Distinct from having any particular model. */
let daemonUp = false;
let reachable = false;
let smallReachable = false;
let why = "";

beforeAll(async () => {
  // One probe, and every unreachable path falls through to the SAME report at the end. The first
  // version returned early from two of these branches, which skipped the warning with them — so
  // the commonest misconfiguration (server up, model not pulled) announced nothing at all.
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) {
      why = `the model server answered ${res.status}`;
    } else {
      daemonUp = true;
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const names = (body.models ?? []).map((m) => m.name ?? "");
      /**
       * THE PRODUCTION MATCHER, not a second copy of it.
       *
       * `hasInstalledModel` is what the provider itself uses, and it honours an explicit tag: a bare
       * `llama3.2` matches any tag, while `qwen2.5:0.5b` must match THAT tag. A family-only
       * comparison written here instead reported the small model present whenever any `qwen2.5`
       * was installed, and the ceiling test then ran against a model the daemon does not have —
       * failing on an undefined drafter rather than skipping, which reads as a product defect.
       */
      const has = (want: string): boolean => hasInstalledModel(names, want);
      smallReachable = has(TOO_SMALL_MODEL);
      if (has(MODEL)) {
        reachable = true;
      } else {
        why = `the model server is running and does not have "${MODEL}" `
          + `(has: ${names.join(", ") || "nothing"})`;
      }
    }
  } catch (err) {
    why = `nothing answered at ${OLLAMA_BASE}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!reachable) {
    // eslint-disable-next-line no-console
    console.warn(`[ai-ollama-live] SKIPPING the live checks — ${why}`);
  }
});

/**
 * A REAL skip, with the reason PRINTED — never a bare `return`, which vitest reports as a pass.
 *
 * `TaskContext.skip()` TAKES NO ARGUMENT on vitest 2.1.9: `@vitest/runner`'s `dist/index.js` sets
 * `test.pending` and throws `PendingError("test is skipped; abort execution")` without ever
 * reading one. So a note handed to it is discarded and the summary says only "skipped". This file
 * used to pass one, and the paragraphs above used to claim the reason was carried — the SKIP was
 * real, which is the half that matters, but the reason reached nobody.
 *
 * It goes to `console.warn`, which is where the suite-level reason already goes, and `ctx.skip()`
 * then does the one thing it does do. The parameter type is vitest's OWN shape rather than a
 * hand-written one: the previous `{ skip: (note?: string) => void }` accepted the real context
 * (fewer parameters is assignable to more) and is exactly what hid this for as long as it did.
 */
function skipWithReason(ctx: { skip: () => void }, reason: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[ai-ollama-live] SKIPPING — ${reason}`);
  ctx.skip();
}

/**
 * Called as the first statement of every test that needs a live model. `ctx.skip()` aborts the
 * test and marks it skipped, so the summary distinguishes "the local model answered" from "no
 * local model was contacted" — a distinction a green tick erases.
 */
function skipUnlessLive(ctx: { skip: () => void }): void {
  if (!reachable) skipWithReason(ctx, why || "no live model server");
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function localAi(): Promise<LocalAi> {
  const dir = await freshDataDir("ohmail-ollama-live-");
  dirs.push(dir);
  const ai = await createLocalAi({
    dataDir: dir,
    keyProvider: new StaticKeyProvider({ 1: Buffer.alloc(32, 7) }),
    canStoreKey: true,
    log: createSidecarLog({ sink: () => undefined }),
    /**
     * GENEROUS ON PURPOSE, because the deadline is not what this file is testing.
     *
     * Measured on this machine: the same screening call took 862 ms idle and 45 s while a full
     * test suite had the CPU, and a draft that runs in about a second idle blew a 120 s deadline
     * under the same load. A local model's latency is a property of the machine it is sharing,
     * so a tight deadline here would make an environment fact look like a product defect — a red
     * that says "your model server is broken" when the only true statement is "this box was
     * busy". The product's own default deadline is asserted where it belongs, against a recorded
     * transport, in `ai-provider.test.ts`.
     */
    timeoutMs: 300_000,
  });
  const status = await ai.save({
    provider: "ollama",
    ollama: { baseUrl: OLLAMA_BASE, classifyModel: MODEL, draftModel: MODEL },
  });
  // The verification is part of the claim: the settings surface says "available" only after the
  // endpoint answered AND carried the configured model.
  expect(status.probe?.ok, `probe failed: ${status.probe?.reason} ${status.probe?.detail ?? ""}`).toBe(true);
  expect(status.available).toBe(true);
  // The destination is a fact about the ORIGIN, and `OLLAMA_BASE` can be pointed off this box. On
  // the default loopback address the engine says so; against a model server elsewhere it says
  // nothing rather than "this machine", and asserting the loopback answer unconditionally here
  // would report that correctness as a failure.
  if (originIsThisMachine(OLLAMA_BASE)) expect(status.contentGoesTo).toBe("this_machine");
  else expect("contentGoesTo" in status).toBe(false);
  return ai;
}

const aStranger = (subject: string, snippet: string): ClassifierInput => ({
  from: { name: null, address: "stranger@example.test" },
  subject,
  snippet,
  headersDigest: "no list-id",
});

describe("a self-hosted install, a local model, and a real Screener suggestion", () => {
  it("verifies against the running daemon and reports the models it actually has", async (ctx) => {
    skipUnlessLive(ctx);
    const ai = await localAi();
    const status = ai.status();
    expect(status.probe?.models.length).toBeGreaterThan(0);
    expect(status.probe?.models.some((m) => m.split(":")[0] === MODEL.split(":")[0])).toBe(true);
  }, 360_000);

  /**
   * THE CLAIM THE README MAKES, RUN.
   *
   * Not "the answer is correct" — a 0.5B model's routing judgement is not something to assert on,
   * and a test that demanded a particular pile would be testing the model rather than the product.
   * What IS asserted is everything the product is responsible for: a real answer comes back, it is
   * one of the five piles the Screener can act on, the confidence is inside the range the interface
   * renders, and the rationale is a sentence rather than a JSON fragment or an apology.
   */
  it("answers the screening question with something the Screener can act on", async (ctx) => {
    skipUnlessLive(ctx);
    const ai = await localAi();
    const classifier = ai.classifier();
    expect(classifier, "a verified provider must offer the request-path classifier").toBeDefined();

    const result = await classifier!.screen!(aStranger(
      "Your invoice #4417 is ready",
      "Thanks for your business. The invoice for August is attached and due on the 30th.",
    ));

    expect(SCREEN_DESTINATIONS).toContain(result.destination);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.rationale).toBe("string");
    // `spam` is derived from the destination rather than trusted alongside it.
    expect(result.spam).toBe(result.destination === "ohmail/Quarantine");
    // eslint-disable-next-line no-console
    console.log(`[ai-ollama-live] ${MODEL} screened → ${result.destination} `
      + `(confidence ${result.confidence}) — ${result.rationale}`);
  }, 360_000);

  it("writes a reply draft through the same local model", async (ctx) => {
    skipUnlessLive(ctx);
    const ai = await localAi();
    const drafted = await ai.drafter()!.draft({
      incoming: {
        subject: "Are you free Thursday?",
        from: "her@example.test",
        snippet: "Could we move our call to Thursday afternoon?",
      },
      context: { kbEntries: [], threadMessages: [] },
    });
    expect(typeof drafted.subject).toBe("string");
    expect(drafted.body.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[ai-ollama-live] ${MODEL} drafted → ${JSON.stringify(drafted.subject)}`);
  }, 360_000);

  /**
   * A MODEL TOO SMALL TO FINISH IS BOUNDED AND NAMED — the case that used to hang.
   *
   * This is the test that found the defect, and it is worth reading as a warning about instruments.
   * Every recorded test in this package passed while the local provider sent NO token ceiling,
   * because a fake transport always answers. Against a real daemon, `qwen2.5:0.5b` under the
   * drafting schema fell into a repetition loop and never emitted a stopping token: the call ran
   * past 45 s, then past 120 s, then past 300 s. It looked exactly like a slow machine, and the
   * first two times it was diagnosed as one.
   *
   * The provider now sends `num_predict`, so the loop terminates at the ceiling and the truncated
   * answer is reported as what it is rather than as malformed JSON. What is asserted here is the
   * PRODUCT'S guarantee — the call comes back, with a sentence naming the real cause — and not the
   * model's quality, which is the user's choice to make.
   */
  it("refuses in bounded time when the model will not stop talking", async (ctx) => {
    // Gated on the daemon and on the SMALL model alone — never on the default one. This is the
    // only live proof the ceiling works, and tying it to a model it does not use meant it silently
    // did not run on exactly the setup this file's own instructions describe.
    if (!daemonUp) skipWithReason(ctx, why || "no live model server");
    if (!smallReachable) {
      skipWithReason(ctx, `the deliberately-too-small "${TOO_SMALL_MODEL}" is not pulled`);
    }
    const dir = await freshDataDir("ohmail-ollama-live-");
    dirs.push(dir);
    const ai = await createLocalAi({
      dataDir: dir,
      keyProvider: new StaticKeyProvider({ 1: Buffer.alloc(32, 7) }),
      canStoreKey: true,
      log: createSidecarLog({ sink: () => undefined }),
      timeoutMs: 300_000,
    });
    await ai.save({
      provider: "ollama",
      ollama: { baseUrl: OLLAMA_BASE, classifyModel: TOO_SMALL_MODEL, draftModel: TOO_SMALL_MODEL },
    });

    const started = Date.now();
    await expect(ai.drafter()!.draft({
      incoming: {
        subject: "Are you free Thursday?",
        from: "her@example.test",
        snippet: "Could we move our call to Thursday afternoon?",
      },
      context: { kbEntries: [], threadMessages: [] },
    })).rejects.toThrow(/did not finish within \d+ tokens/);
    const took = Date.now() - started;
    // Bounded by the CEILING, not by the deadline. Before the ceiling this call did not return at
    // all; the deadline here is 300 s, so anything near it would mean the bound is not working.
    expect(took).toBeLessThan(200_000);
    // eslint-disable-next-line no-console
    console.log(`[ai-ollama-live] ${TOO_SMALL_MODEL} refused in ${took}ms instead of hanging`);
  }, 360_000);

  /**
   * THE HONEST FAILURE STORY, against the real daemon rather than a fake one.
   *
   * A running server that does not have the model is the single most common way this is set up
   * wrongly, and it is indistinguishable from a working configuration until the first message
   * arrives. The verification is what moves that discovery forward to the moment somebody is still
   * looking at the settings — so it is checked here, where the server is real and genuinely does
   * not have the model being asked for.
   */
  it("a model that is not pulled is a named, actionable state — not an outage", async (ctx) => {
    skipUnlessLive(ctx);
    const dir = await freshDataDir("ohmail-ollama-live-");
    dirs.push(dir);
    const ai = await createLocalAi({
      dataDir: dir,
      keyProvider: new StaticKeyProvider({ 1: Buffer.alloc(32, 7) }),
      canStoreKey: true,
      log: createSidecarLog({ sink: () => undefined }),
    });
    const status = await ai.save({
      provider: "ollama",
      ollama: { baseUrl: OLLAMA_BASE, classifyModel: "not-a-real-model", draftModel: "not-a-real-model" },
    });

    expect(status.available).toBe(false);
    expect(status.probe?.reason).toBe("model_absent");
    expect(status.probe?.detail).toContain("not-a-real-model");
    // Rules-only, which is the floor: the ports are ABSENT rather than throwing.
    expect(ai.classifier()).toBeUndefined();
    expect(ai.classifierForCycle()).toBeUndefined();
  }, 60_000);

  /**
   * The daemon not running at all — the other half of the failure story.
   *
   * A port nothing listens on, so this one needs no live server and runs everywhere. It is in this
   * file rather than the recorded suite because the thing being checked is a REAL connection
   * refusal from the operating system, which a fake transport cannot produce.
   */
  it("a daemon that is not running is 'unreachable', and mail keeps arriving", async () => {
    const dir = await freshDataDir("ohmail-ollama-live-");
    dirs.push(dir);
    const ai = await createLocalAi({
      dataDir: dir,
      keyProvider: new StaticKeyProvider({ 1: Buffer.alloc(32, 7) }),
      canStoreKey: true,
      log: createSidecarLog({ sink: () => undefined }),
      timeoutMs: 5_000,
    });
    const status = await ai.save({
      provider: "ollama",
      // Port 1 on loopback: nothing listens, and nothing can be started there by accident.
      ollama: { baseUrl: "http://127.0.0.1:1", classifyModel: "llama3.2", draftModel: "llama3.2" },
    });

    expect(status.available).toBe(false);
    expect(status.unavailableReason).toBe("unreachable");
    expect(status.probe?.reason).toBe("unreachable");
    expect(ai.classifier()).toBeUndefined();
    expect(ai.classifierForCycle()).toBeUndefined();
  }, 30_000);
});
