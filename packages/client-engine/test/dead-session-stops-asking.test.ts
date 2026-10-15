import { describe, expect, it, vi } from "vitest";
import {
  createSessionHeal,
  HttpAdapter,
  SESSION_ENDED_CODE,
  SESSION_HEAL_BACKOFF_MS,
} from "../src/index.js";

/**
 * ═══ A CLIENT WHOSE SESSION IS OVER STOPS ASKING ═══════════
 *
 * Measured in production: one browser with a dead session asked three routes about twice a second
 * for more than eight minutes — hundreds of refusals each — and every refusal started a refresh that was
 * refused the same way. Nothing was broken; nothing had a bound.
 *
 * Every case below counts REQUESTS ON A FAKE WIRE over a 60 s virtual clock: the poll rate the
 * logs recorded, the gate that closes the doors, the schedule that is the only thing still asking,
 * and the revival that reopens them with exactly one re-ask per open surface.
 */

/** Twice a second, the rate the production logs recorded. */
const POLL_MS = 500;
const WINDOW_MS = 60_000;

/** The API's own coded 401 — the shape a dead session is answered with. */
const coded401 = (): Response =>
  new Response(JSON.stringify({ error: { code: "unauthorized", message: "authentication required" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

interface Wire {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
}

/** A wire that answers the death shape and remembers every path it was asked for. */
function deadWire(): Wire {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      return coded401();
    },
  };
}

/**
 * The three routes the logs named, each on its own poller, run for `WINDOW_MS` of virtual time.
 * Every tick is awaited so a refused read cannot be counted before it happened.
 */
async function pollFor(adapter: HttpAdapter, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += POLL_MS) {
    await Promise.all([
      adapter.listAttachments!("m1").catch(() => undefined),
      adapter.listAttachments!("m2").catch(() => undefined),
      adapter.listAttachments!("m3").catch(() => undefined),
    ]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
  }
}

describe("a confirmed dead session closes every door in the transport", () => {
  it("THE STORM, as measured: an ungated client asks 360 times in one minute", async () => {
    vi.useFakeTimers();
    try {
      const wire = deadWire();
      const adapter = new HttpAdapter({ baseUrl: "", fetch: wire.fetch });
      await pollFor(adapter, WINDOW_MS);
      // 120 ticks × three routes. The number is the control the gate is measured against; what
      // matters is that it is unbounded in the length of the outage, and this is one minute of it.
      expect(wire.calls.length).toBe(360);
    } finally {
      vi.useRealTimers();
    }
  });

  it("THE GATE: with the death confirmed, not one byte leaves — and the answer is the server's own", async () => {
    vi.useFakeTimers();
    try {
      const wire = deadWire();
      let dead = false;
      const adapter = new HttpAdapter({ baseUrl: "", fetch: wire.fetch, mayAsk: () => !dead });

      // Alive: the doors behave exactly as they did — the gate is invisible until it closes.
      await pollFor(adapter, 2_000);
      expect(wire.calls.length).toBe(12);

      dead = true;
      const before = wire.calls.length;
      await pollFor(adapter, WINDOW_MS);
      expect(wire.calls.length, "a dead session still reached the wire").toBe(before);

      // The refusal a caller sees is the one the server sends, so nothing above re-classifies.
      const refused = await adapter.listAttachments!("m1").then(
        () => null,
        (err: unknown) => err as { status?: number; code?: string },
      );
      expect(refused?.status).toBe(401);
      expect(refused?.code).toBe(SESSION_ENDED_CODE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("THE HEAL: the only thing still asking is the schedule, twice in that minute", async () => {
    vi.useFakeTimers();
    try {
      const attempts: number[] = [];
      const heal = createSessionHeal(() => attempts.push(Date.now()));
      const started = Date.now();
      heal.arm();
      await vi.advanceTimersByTimeAsync(WINDOW_MS);

      // 5 s, then 30 s later. The third step (two minutes) falls outside this window.
      expect(attempts.map((t) => t - started)).toEqual([5_000, 35_000]);
      expect(heal.attempts()).toBe(2);
      expect(heal.armed(), "the schedule stopped while the session was still dead").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("THE REVIVAL: the doors reopen and each open surface asks exactly once", async () => {
    vi.useFakeTimers();
    try {
      const wire = deadWire();
      let dead = true;
      const adapter = new HttpAdapter({ baseUrl: "", fetch: wire.fetch, mayAsk: () => !dead });
      const heal = createSessionHeal(() => { /* the refresh, refused for now */ });
      heal.arm();
      await pollFor(adapter, WINDOW_MS);
      expect(wire.calls.length).toBe(0);

      // A real 204: the gate opens, the schedule stops.
      dead = false;
      heal.disarm();
      expect(heal.armed()).toBe(false);
      expect(heal.attempts()).toBe(0);

      // Three open surfaces re-ask. ONE request each — the re-ask is a surface's own act, and the
      // gate neither replays what it refused nor multiplies what it lets through.
      await Promise.all([
        adapter.listAttachments!("m1").catch(() => undefined),
        adapter.listAttachments!("m2").catch(() => undefined),
        adapter.listAttachments!("m3").catch(() => undefined),
      ]);
      expect(wire.calls.length).toBe(3);
      expect(new Set(wire.calls).size, "one surface asked twice").toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the heal schedule is a schedule, never a reflex", () => {
  it("widens by the declared steps and then repeats the last one for ever", async () => {
    vi.useFakeTimers();
    try {
      const at: number[] = [];
      const started = Date.now();
      const heal = createSessionHeal(() => at.push(Date.now() - started));
      heal.arm();
      // Long enough for every declared step plus two repeats of the last.
      await vi.advanceTimersByTimeAsync(20 * 60_000);

      const waits = at.map((t, i) => (i === 0 ? t : t - at[i - 1]!));
      expect(waits.slice(0, SESSION_HEAL_BACKOFF_MS.length)).toEqual([...SESSION_HEAL_BACKOFF_MS]);
      const last = SESSION_HEAL_BACKOFF_MS[SESSION_HEAL_BACKOFF_MS.length - 1]!;
      expect(waits.slice(SESSION_HEAL_BACKOFF_MS.length).every((w) => w === last)).toBe(true);
      // Twelve an hour against the flood the outage produced.
      expect(at.length).toBeLessThanOrEqual(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second confirmation of the same death does not start a second schedule", async () => {
    vi.useFakeTimers();
    try {
      const heal = createSessionHeal(() => { /* counted below */ });
      heal.arm();
      heal.arm();
      heal.arm();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(heal.attempts(), "each arm scheduled its own attempt — the storm rebuilt").toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarming from inside an attempt stops it — a heal that works does not schedule the next", async () => {
    vi.useFakeTimers();
    try {
      let heal = null as ReturnType<typeof createSessionHeal> | null;
      let made = 0;
      heal = createSessionHeal(() => {
        made += 1;
        heal!.disarm();
      });
      heal.arm();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(made).toBe(1);
      expect(heal.armed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the wait the next step will take is readable before it fires", async () => {
    vi.useFakeTimers();
    try {
      const heal = createSessionHeal(() => { /* nothing */ });
      expect(heal.pendingWaitMs(), "an unarmed schedule named a wait").toBe(0);
      heal.arm();
      expect(heal.pendingWaitMs()).toBe(SESSION_HEAL_BACKOFF_MS[0]);
      await vi.advanceTimersByTimeAsync(SESSION_HEAL_BACKOFF_MS[0]!);
      expect(heal.pendingWaitMs()).toBe(SESSION_HEAL_BACKOFF_MS[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
