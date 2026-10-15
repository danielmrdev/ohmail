/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A RENEWAL NAMES ITS ATTEMPT, AND A RETRY OF AN ANSWER THAT NEVER LANDED REUSES THE NAME. The server
 * re-admits a spent refresh token presented with the attempt that spent it; under a new name past the
 * 60 s grace it sweeps the family. So the name is written to the jar before the request goes, resumed by
 * this page, a reload or another tab while the jar has not moved on, and settled by a definitive answer.
 * Tabs are two module instances over one jsdom jar, one fetch and one FIFO lock.
 */

type Refresh = typeof import("../app/session-refresh");

const MIN = 60_000;
/** A CSRF value no random id or hex digest can contain, so "not stored" is a real reading. */
const MARKED_CSRF = "csrf-value-never-stored";
let answers: Array<() => Response> = [];
let sent: Array<{ attemptId: unknown; contentType: string | null }> = [];

const minted = (csrf: string) => (): Response => {
  document.cookie = `tf_csrf=${csrf}; Path=/`;
  return new Response(null, { status: 204 });
};
const lost = (): Response => { throw new TypeError("Failed to fetch"); };
const revoked = (): Response => new Response(
  JSON.stringify({ error: { code: "refresh_revoked", message: "invalid refresh token" } }),
  { status: 401, headers: { "content-type": "application/json" } },
);

async function openTab(): Promise<Refresh> {
  vi.resetModules();
  return import("../app/session-refresh");
}
const lastName = (): unknown => sent.at(-1)?.attemptId;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-02T21:00:00.000Z"));
  answers = [];
  sent = [];
  window.localStorage.clear();
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = "tf_csrf=c0; Path=/";
  let chain: Promise<unknown> = Promise.resolve();
  Object.defineProperty(globalThis.navigator, "locks", {
    configurable: true,
    value: {
      request: (_n: string, _o: unknown, cb: () => Promise<unknown>) => {
        const run = chain.then(() => cb());
        chain = run.then(() => undefined, () => undefined);
        return run;
      },
    },
  });
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/auth/refresh")) {
      const headers = new Headers(init?.headers as HeadersInit);
      sent.push({ attemptId: JSON.parse(String(init?.body ?? "{}")).attemptId, contentType: headers.get("content-type") });
      const next = answers.shift();
      if (!next) throw new Error("no answer queued for this refresh");
      return next();
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a renewal names its attempt", () => {
  it("every refresh carries a name in a JSON body, and the name is not the CSRF value", async () => {
    document.cookie = `tf_csrf=${MARKED_CSRF}; Path=/`;
    const tab = await openTab();
    answers = [minted("c1")];
    expect(await tab.resumeSession()).toBe("resumed");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.contentType).toBe("application/json");
    expect(typeof lastName()).toBe("string");
    expect(String(lastName()).length).toBeLessThanOrEqual(128);
    expect(String(lastName())).not.toContain(MARKED_CSRF);
  });

  it("an answer that never landed keeps the name: this page, a reload and another tab retry as the SAME attempt", async () => {
    document.cookie = `tf_csrf=${MARKED_CSRF}; Path=/`;
    const tab = await openTab();
    answers = [lost, lost, lost];
    expect(await tab.resumeSession()).toBe("unavailable");
    const first = lastName();
    expect(await tab.resumeSession()).toBe("unavailable");
    expect(lastName(), "this page's retry").toBe(first);
    const other = await openTab();
    expect(await other.resumeSession()).toBe("unavailable");
    expect(lastName(), "a reload or another tab").toBe(first);
    expect(window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY) ?? "", "the stored name holds no CSRF value").not.toContain(MARKED_CSRF);
  });

  it("a 204 settles it: the next renewal is a new attempt, and the jar no longer owes one", async () => {
    const tab = await openTab();
    answers = [lost, minted("c1"), minted("c2")];
    await tab.resumeSession();
    const first = lastName();
    expect(await tab.resumeSession()).toBe("resumed");
    expect(lastName(), "the retry that landed").toBe(first);
    expect(window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY)).toBeNull();
    await tab.resumeSession();
    expect(lastName(), "a new renewal is a new attempt").not.toBe(first);
  });

  it("a coded refusal settles it too", async () => {
    const tab = await openTab();
    answers = [lost, revoked];
    await tab.resumeSession();
    expect(await tab.resumeSession()).toBe("refused");
    expect(window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY)).toBeNull();
  });

  it("a jar that moved on (a new tf_csrf landed) never resumes an old name", async () => {
    const tab = await openTab();
    answers = [lost, minted("c2")];
    await tab.resumeSession();
    const first = lastName();
    document.cookie = "tf_csrf=c1; Path=/";
    await tab.resumeSession();
    expect(lastName()).not.toBe(first);
  });

  it("a tf_csrf that merely LAPSED (no answer landed) still resumes the name", async () => {
    const tab = await openTab();
    answers = [lost, minted("c1")];
    await tab.resumeSession();
    const first = lastName();
    document.cookie = "tf_csrf=; Path=/; Max-Age=0";
    vi.setSystemTime(new Date(Date.now() + 5 * MIN));
    await tab.resumeSession();
    expect(lastName()).toBe(first);
  });

  it("past one access window the name is not resumed", async () => {
    const tab = await openTab();
    answers = [lost, minted("c1")];
    await tab.resumeSession();
    const first = lastName();
    vi.setSystemTime(new Date(Date.now() + 15 * MIN));
    await tab.resumeSession();
    expect(lastName()).not.toBe(first);
  });

  it("a name stamped in the FUTURE is discarded, never resumed", async () => {
    const tab = await openTab();
    answers = [lost, minted("c1")];
    await tab.resumeSession();
    const first = lastName();
    const owed = JSON.parse(window.localStorage.getItem(tab.SESSION_ATTEMPT_KEY)!) as { at: number };
    window.localStorage.setItem(tab.SESSION_ATTEMPT_KEY, JSON.stringify({ ...owed, at: Date.now() + 10 * MIN }));
    const other = await openTab();
    await other.resumeSession();
    expect(lastName()).not.toBe(first);
  });

  it("a jar that refuses storage keeps this page's own name for the retry", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("refused", "QuotaExceededError"); });
    const tab = await openTab();
    answers = [lost, lost];
    await tab.resumeSession();
    const first = lastName();
    await tab.resumeSession();
    expect(lastName()).toBe(first);
  });
});
