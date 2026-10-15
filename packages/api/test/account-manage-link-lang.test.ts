import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import type { AccessVerdict, EntitlementsPort } from "@trafficflow/db";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * `POST /account/manage-link` NAMES THE PAGE'S LANGUAGE. The mint is pressed from a screen in one
 * language and the page it opens must speak it; the body may carry `lang`, one of two words, and
 * nothing else reaches the port. Driven through the route table, so the body the handler reads is
 * the one the pipeline hands it.
 */

/** A port that records the language each mint was asked for. */
function recordingPort(verdict: AccessVerdict): { port: EntitlementsPort; asked: Array<string | undefined> } {
  const asked: Array<string | undefined> = [];
  const access = async (): Promise<AccessVerdict> => verdict;
  return {
    asked,
    port: {
      access,
      accessOrFault: access,
      spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
      release: async () => "settled" as const,
      manageLink: async (_accountId, lang) => { asked.push(lang); return { url: "https://plane.ohmail.app/manage?token=t" }; },
      releaseAccount: async () => "none",
    },
  };
}

const OPEN: AccessVerdict = {
  ok: true, limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: true },
};

async function setup(verdict: AccessVerdict = OPEN) {
  const made = await makeDeps();
  const { port, asked } = recordingPort(verdict);
  const deps = { ...made.deps, services: { ...made.deps.services, entitlementsPort: port } } as ApiDeps;
  const s = await seedSession(made.db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const mint = (body?: string): Promise<Response> =>
    H(req("POST", "/account/manage-link", { bearer: s.token, ...(body !== undefined ? { body } : {}) }), deps);
  return { mint, asked };
}

describe("POST /account/manage-link forwards the page's language", () => {
  it("de and en reach the port as themselves", async () => {
    const { mint, asked } = await setup();
    expect((await mint(JSON.stringify({ lang: "de" }))).status).toBe(200);
    expect((await mint(JSON.stringify({ lang: "en" }))).status).toBe(200);
    expect(asked).toEqual(["de", "en"]);
  });

  it("no body, an empty object, an unknown word and a non-string all name no language", async () => {
    // The positive control above is what makes these mean something: a handler that never read
    // the body would pass every case here.
    const { mint, asked } = await setup();
    for (const body of [undefined, "{}", JSON.stringify({ lang: "fr" }), JSON.stringify({ lang: 7 })]) {
      expect((await mint(body)).status, String(body)).toBe(200);
    }
    expect(asked).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("a JSON body that is not an object is no language, not a 500", async () => {
    const { mint, asked } = await setup();
    expect((await mint("null")).status).toBe(200);
    expect((await mint(JSON.stringify("de"))).status).toBe(200);
    expect(asked).toEqual([undefined, undefined]);
  });

  it("a body that is not JSON is refused before the port is asked", async () => {
    const { mint, asked } = await setup();
    expect((await mint("{lang:")).status).toBe(400);
    expect(asked).toEqual([]);
  });

  it("a REFUSED account still reaches the door, language and all — the way back is not behind the lock", async () => {
    const { mint, asked } = await setup({ ok: false, reason: "payment_required" });
    expect((await mint(JSON.stringify({ lang: "de" }))).status).toBe(200);
    expect(asked).toEqual(["de"]);
  });
});
