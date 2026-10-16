/** @vitest-environment jsdom */
/**
 * A REQUEST WAITS FOR ANOTHER TAB'S RENEWAL, through the one cross-tab lock and the same 15 s bound.
 *
 * Tab 2 renews: it holds `ohmail:session-refresh` and its rotation replaces the access token at the
 * server before its answer lands. A request tab 1 sends beside it carried the replaced token, was
 * refused once, and its recovery rotated the family again. Two tabs here are two module instances over
 * one jar, one fetch and one FIFO lock; the server refuses an access generation a rotation replaced
 * and a write whose CSRF is not its session's. The invariant: one rotation, every request sent once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const R_ARRIVE = 10;
const ARRIVE = 20;

interface Sent { at: number; url: string; status: number | null }
let sent: Sent[] = [];
let access = 0;
let serverAccess = 0;
let hangRefresh = false;

const csrfOf = (g: number): string => `csrf-${g}`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const later = <T,>(ms: number, fn: () => T): Promise<T> => new Promise((r) => setTimeout(() => r(fn()), ms));

function setJar(g: number): void {
  access = g;
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = `tf_csrf=${csrfOf(g)}; Path=/`;
}

function serve(url: string, init?: RequestInit): Promise<Response> {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)
    .map(([k, v]) => [k.toLowerCase(), v]));
  const carried = access;
  const row: Sent = { at: Date.now(), url, status: null };
  sent.push(row);
  if (url === "/auth/refresh") {
    if (hangRefresh) return new Promise<Response>(() => {});
    // The rotation lands at the server first; its answer reaches the jar a moment later.
    return later(R_ARRIVE, () => { serverAccess += 1; return serverAccess; })
      .then((g) => later(R_ARRIVE, () => { setJar(g); row.status = 204; return new Response(null, { status: 204 }); }));
  }
  return later(ARRIVE, () => {
    let res: Response;
    if (carried !== serverAccess) res = json(401, { error: { code: "unauthorized", message: "authentication required" } });
    else if ((init?.method ?? "GET") !== "GET" && headers["x-csrf-token"] !== csrfOf(carried)) {
      res = json(403, { error: { code: "csrf_failed", message: "csrf validation failed" } });
    } else res = json(200, {});
    row.status = res.status;
    return res;
  });
}

async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5) {
    await vi.advanceTimersByTimeAsync(Math.min(5, left));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
}

async function openTab() {
  vi.resetModules();
  const truth = await import("../app/shell/session-truth");
  const client = await import("../app/api-client");
  const refresh = await import("../app/session-refresh");
  client.bindApiOwner("acct_A");
  return { truth, client, refresh };
}

const refreshes = (): number => sent.filter((s) => s.url === "/auth/refresh").length;
const asks = (url: string): Sent[] => sent.filter((s) => s.url === url);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-06T08:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  sent = [];
  serverAccess = 0;
  hangRefresh = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  setJar(0);
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
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => serve(String(input), init)) as unknown as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  const { resetSessionTruthForTests } = await import("../app/shell/session-truth");
  resetSessionTruthForTests();
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Tab 2 starts its renewal and its request is out; tab 1 then asks. */
async function besideTab2Renewal<T>(ask: (tab1: Awaited<ReturnType<typeof openTab>>) => Promise<T>): Promise<T> {
  const tab2 = await openTab();
  const renewal = tab2.refresh.resumeSession();
  await advance(1);
  expect(refreshes(), "control: tab 2's renewal is out").toBe(1);
  const tab1 = await openTab();
  const answer = ask(tab1);
  await advance(200);
  expect(await renewal).toBe("resumed");
  return answer;
}

describe("a request beside a renewal another tab is making", () => {
  it("api(): waits for it, leaves on the renewed jar, and is sent once with no second rotation", async () => {
    const res = await besideTab2Renewal((tab1) => tab1.client.api("/consent").then(() => "ok", (e: { status?: number }) => `refused:${e.status}`));
    expect(res).toBe("ok");
    expect(asks("/api/consent").map((s) => s.status), "the request was refused beside the other tab's rotation").toEqual([200]);
    expect(refreshes(), "the request's recovery rotated the family a second time").toBe(1);
  });

  it("the engine's transport: a press waits, carries the renewed CSRF, and is applied once", async () => {
    const res = await besideTab2Renewal((tab1) => tab1.truth.sessionFetch("/api/messages/m1/triage", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k1", "x-csrf-token": csrfOf(0) },
      body: "{}",
    }));
    expect(res.status).toBe(200);
    expect(asks("/api/messages/m1/triage").map((s) => s.status)).toEqual([200]);
    expect(refreshes()).toBe(1);
  });

  it("the wait is bounded: a renewal that never answers holds a request 15 s, then it goes", async () => {
    hangRefresh = true;
    const tab2 = await openTab();
    void tab2.refresh.resumeSession();
    await advance(1);
    const tab1 = await openTab();
    const start = Date.now();
    void tab1.client.api("/consent").catch(() => undefined);
    await advance(14_900);
    expect(asks("/api/consent"), "the request left before the bound").toEqual([]);
    await advance(200);
    const left = asks("/api/consent");
    expect(left, "the request never left").toHaveLength(1);
    expect(left[0]!.at - start).toBeGreaterThanOrEqual(15_000);
  });

  it("CONTROL: with no other tab renewing, a request leaves at once", async () => {
    const tab1 = await openTab();
    const start = Date.now();
    const done = tab1.client.api("/consent");
    await advance(1);
    expect(asks("/api/consent").map((s) => s.at - start)).toEqual([0]);
    await advance(100);
    await done;
    expect(refreshes()).toBe(0);
  });

  it("CONTROL: a renewal name left by an answer that landed long ago holds nothing", async () => {
    window.localStorage.setItem("ohmail.session.refreshAttempt",
      JSON.stringify({ id: "w-old", csrf: "00000000", at: Date.now() - 60_000 }));
    const tab1 = await openTab();
    const start = Date.now();
    void tab1.client.api("/consent").catch(() => undefined);
    await advance(1);
    expect(asks("/api/consent").map((s) => s.at - start)).toEqual([0]);
  });
});
