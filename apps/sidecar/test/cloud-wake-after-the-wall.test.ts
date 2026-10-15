import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WAKE_WALLED_REDIAL_MIN_MS, startCloudWake } from "../src/cloud-wake.js";

/**
 * SSE-DESKTOP-WAKE-OFF-AFTER-THE-WALL at the wake's own seam. A 402 is the ACCOUNT, not the
 * channel: the wake parks with no timer, and only `rearm()` (the mirror's served pull) dials again,
 * at most once a minute; a still-refused account parks again. 503 and 403 stay permanent for the
 * process. The composed half, with the mirror's served hook wired, is `cloud-wake-walled-door.test.ts`.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A body the test writes into by hand and ends when it likes. */
function sseBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    stream,
    send(text: string): void { controller.enqueue(enc.encode(text)); },
    end(): void { try { controller.close(); } catch { /* already closed */ } },
  };
}

/** The refusal close `GET /events` sends a refused account's open stream, then EOF. */
const REFUSAL_CLOSE =
  "retry: 3000\n\nevent: ready\ndata: {}\n\nretry: 30000\n\nevent: sync\ndata: {\"seq\":5}\n\n";

const answer = (status: number): Response => new Response(JSON.stringify({
  error: { code: status === 402 ? "subscription_required" : "refused", message: "no" },
}), { status, headers: { "content-type": "application/json" } });

/** A server whose next answers the test scripts: a status, or `"stream"` for a live 200. */
function server(script: Array<number | "stream" | "refusal-close">) {
  let dials = 0;
  const live: ReturnType<typeof sseBody>[] = [];
  const events: string[] = [];
  let wakes = 0;
  const wake = startCloudWake({
    auth: {
      authedFetch: async () => {
        const step = script[Math.min(dials, script.length - 1)]!;
        dials += 1;
        if (step === "stream" || step === "refusal-close") {
          const b = sseBody();
          live.push(b);
          if (step === "refusal-close") { b.send(REFUSAL_CLOSE); b.end(); }
          else b.send("event: ready\ndata: {}\n\n");
          return new Response(b.stream, { status: 200 });
        }
        return answer(step);
      },
    },
    onWake: () => { wakes += 1; },
    log: (event) => { events.push(event); },
  });
  return {
    wake,
    dials: (): number => dials,
    wakes: (): number => wakes,
    events,
    stop: (): void => { wake.stop(); for (const b of live) b.end(); },
  };
}

// The defaults plus `performance`: the stream's lifetime and the walled redial floor read it.
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date", "performance"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("a 402 parks the wake; the mirror's served pull re-arms it", () => {
  it("parked: an hour passes with no dial and no timer, the wall said once and never as off", async () => {
    const s = server([402]);
    await flush();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(s.dials(), "a walled wake dialled on its own clock").toBe(1);
    expect(s.events).toEqual(["cloud_wake_walled"]);
    expect(vi.getTimerCount(), "a walled wake holds a timer").toBe(0);
    s.stop();
  });

  it("the refusal close, the re-dial's 402, then rearm(): one dial, the stream kicks, and connected is said again", async () => {
    const s = server(["refusal-close", 402, "stream"]);
    await flush();
    expect(s.wakes(), "the refusal close's sync frame did not kick the mirror").toBe(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(s.dials(), "the re-dial after the 30 s hint").toBe(2);
    s.wake.rearm();
    await flush();
    expect(s.dials(), "rearm() did not dial the walled wake").toBe(3);
    expect(s.events).toEqual(["cloud_wake_connected", "cloud_wake_walled", "cloud_wake_connected"]);
    s.stop();
  });

  it("a standing wall: rearm() at every 20 s served pull dials at most once a minute and parks again", async () => {
    const s = server([402]);
    await flush();
    const at: number[] = [];
    for (let i = 0; i < 30; i++) {          // ten minutes of served pulls
      const before = s.dials();
      s.wake.rearm();
      await flush();
      if (s.dials() > before) at.push(Date.now());
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(at.length, "the re-arm never dialled").toBeGreaterThan(1);
    expect(s.dials(), "at most one dial a minute, plus the first").toBeLessThanOrEqual(11);
    for (let i = 1; i < at.length; i++) {
      expect(at[i]! - at[i - 1]!, "two walled re-dials inside a minute").toBeGreaterThanOrEqual(WAKE_WALLED_REDIAL_MIN_MS);
    }
    expect(s.events, "the wall is said once per episode, and never as off").toEqual(["cloud_wake_walled"]);
    s.stop();
  });

  it("a minute after a walled re-dial rearm() dials again, though the wall clock stepped back an hour", async () => {
    const s = server([402]);
    await flush();
    s.wake.rearm();
    await flush();
    expect(s.dials(), "the first re-arm did not dial, so the floor is not under test").toBe(2);
    await vi.advanceTimersByTimeAsync(WAKE_WALLED_REDIAL_MIN_MS + 1_000);
    vi.setSystemTime(Date.now() - 60 * 60_000);
    s.wake.rearm();
    await flush();
    expect(s.dials(), "the walled wake waited out the clock's step").toBe(3);
    s.stop();
  });

  it("CONTROL: 503 and 403 stay permanent for the process, and rearm() is a no-op on them", async () => {
    for (const status of [503, 403]) {
      const s = server([status, "stream"]);
      await flush();
      for (let i = 0; i < 5; i++) {
        s.wake.rearm();
        await flush();
        await vi.advanceTimersByTimeAsync(WAKE_WALLED_REDIAL_MIN_MS);
      }
      expect(s.dials(), `a ${status} was re-dialled`).toBe(1);
      expect(s.events, `a ${status} is not the account's wall`).toEqual(["cloud_wake_off"]);
      s.stop();
    }
  });

  it("CONTROL: rearm() on a live stream and on a stopped wake dials nothing", async () => {
    const s = server(["stream"]);
    await flush();
    s.wake.rearm();
    await flush();
    expect(s.dials(), "rearm() re-dialled a live stream").toBe(1);
    const w = server([402, "stream"]);
    await flush();
    w.wake.stop();
    w.wake.rearm();
    await flush();
    expect(w.dials(), "rearm() dialled a stopped wake").toBe(1);
    s.stop();
    w.stop();
  });
});
