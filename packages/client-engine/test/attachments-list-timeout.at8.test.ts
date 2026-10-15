import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdapter } from "../src/adapters/http-adapter.js";
import { OhmailEngine } from "../src/engine.js";
import type { AttachmentsOutcome } from "../src/engine.js";

/**
 * ═══ GAP A REQUEST THAT NEVER ANSWERS IS NOT A FAILURE, AND THAT IS THE PROBLEM ══════
 *
 * An earlier change made a REFUSAL say so: the shell stopped flattening the engine's outcome, so a
 * 500 or a dead session now draws a sentence and a "Try again". None of it touches the case where
 * the server takes the request and never answers — no status, no rejection, nothing to classify.
 * `attachmentLists` stays on `{state: "loading"}`, `AttachmentStrip` draws a non-retrying
 * `loading` as `null` (deliberately: one indexed row is not a wait anybody should be shown), and
 * the message renders a paperclip over nothing for as long as the tab is open.
 *
 * There was NO timeout anywhere on the path. Not in `HttpAdapter.request`, not in
 * `loadAttachments`, and not in the browser — `fetch` has no default deadline. The worker's
 * `DEFAULT_NET_TIMEOUTS` bound imapflow's sockets server-side and are unreachable from here.
 *
 * ── WHY THE BOUND IS IN THE ADAPTER AND NOT IN THE ENGINE ─────────────────────────────────
 *
 * The adapter is the only layer holding the `fetch`, so it is the only layer that can ABORT. A
 * race in `loadAttachments` could make the promise settle, but the socket would stay open and the
 * user would be told it failed while it was still running — and worse, the engine's single-flight
 * map (`attachmentListRequests`, deleted only in the request chain's `finally`) would keep handing
 * the same zombie promise to every subsequent call, so the retry that change built would be unreachable.
 *
 * ── WHY THE BOUND IS A RACE *AND* AN ABORT ────────────────────────────────────────────────
 *
 * Abort alone is the defect one indirection down: a transport that ignores `signal` hangs
 * exactly as before. The race is what makes the bound unconditional; the abort is what makes the
 * sentence true about the socket as well as about us. Both are asserted below.
 *
 * The surface half is `apps/webapp/test/attachment-list-timeout.at8.test.tsx`.
 */

/** Longer than any bound this file argues for, and far longer than a person waits. */
const A_LONG_TIME_MS = 10 * 60_000;

/**
 * Only `setTimeout`/`clearTimeout` are faked. Faking the whole clock takes `setImmediate` with
 * it, and this file needs a REAL macrotask boundary to prove the abandoned request's late
 * rejection was swallowed rather than left unhandled.
 */
function freezeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/** A real macrotask tick, unaffected by the fake clock — where an unhandled rejection surfaces. */
const macrotask = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

afterEach(() => {
  vi.useRealTimers();
});

interface HungTransport {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Every signal the adapter handed to `fetch`, in call order. */
  signals: Array<AbortSignal | undefined>;
  calls: number;
}

/**
 * A `fetch` that neither resolves nor rejects — the whole of that change in one line.
 *
 * It deliberately IGNORES the signal, which is not laziness: it is the second half of the
 * argument. A bound that only aborted would still hang against a transport like this, and
 * "a transport that does not answer" is precisely the class this gap is about.
 */
function hungTransport(): HungTransport {
  const t: HungTransport = {
    signals: [],
    calls: 0,
    fetch: (_url, init) => {
      t.calls += 1;
      t.signals.push(init?.signal ?? undefined);
      return new Promise<Response>(() => {});
    },
  };
  return t;
}

function listOf(items: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const ONE_FILE = {
  id: "a1", filename: "invoice.pdf", contentType: "application/pdf",
  sizeBytes: 2_300_000, inline: false, messageId: "m1",
};

function engineOver(fetchImpl: HungTransport["fetch"]): OhmailEngine {
  return new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "/api", fetch: fetchImpl }) });
}

/* ── 1. the defect, and the bound that closes it ───────────────────────────────────────── */

describe("a hung metadata read stops being silent", () => {
  it("THE DEFECT: ten minutes of no answer used to leave the list on `loading`, which draws as nothing", async () => {
    freezeTimers();
    const t = hungTransport();
    const engine = engineOver(t.fetch);

    void engine.loadAttachments("m1");
    expect(engine.attachmentsOf("m1")).toEqual({ state: "loading" });

    await vi.advanceTimersByTimeAsync(A_LONG_TIME_MS);

    expect(
      engine.attachmentsOf("m1"),
      "ten minutes with no answer still reads as `loading`, and the strip renders that as silence",
    ).toMatchObject({ state: "failed" });
  });

  it("the bound is TWELVE SECONDS — still asking at 11 999 ms, stopped at 12 000 ms", async () => {
    freezeTimers();
    const engine = engineOver(hungTransport().fetch);
    void engine.loadAttachments("m1");

    await vi.advanceTimersByTimeAsync(11_999);
    expect(
      engine.attachmentsOf("m1"),
      "the client gave up before the deadline it documents",
    ).toEqual({ state: "loading" });

    await vi.advanceTimersByTimeAsync(1);
    expect(
      engine.attachmentsOf("m1"),
      "the deadline passed and the client was still waiting",
    ).toMatchObject({ state: "failed" });
  });

  it("the outcome is classified `timeout` and RETRYABLE, so the attachment row offers Try again", async () => {
    freezeTimers();
    const engine = engineOver(hungTransport().fetch);
    const pending = engine.loadAttachments("m1");

    await vi.advanceTimersByTimeAsync(12_000);
    const outcome = await pending;

    // `code` is what the strip branches on for its sentence, and `retryable` is what decides
    // whether the row gets a button at all. A timeout is the case where asking again is the
    // entire advice, so anything but `true` here strands the user in front of a dead read.
    expect(outcome).toMatchObject({ state: "failed", code: "timeout", retryable: true });
    // Ours, and readable as ours: there is no server sentence to quote, because no server spoke.
    // This lands in the row's `title`, so it has to say what actually happened.
    expect((outcome as Extract<AttachmentsOutcome, { state: "failed" }>).error)
      .toContain("12000 ms");
  });

  it("the request is ABORTED when the deadline fires — the socket agrees with the sentence", async () => {
    freezeTimers();
    const t = hungTransport();
    const engine = engineOver(t.fetch);
    void engine.loadAttachments("m1");

    expect(t.signals[0], "no signal reached `fetch`, so nothing can ever be cancelled").toBeDefined();
    expect(t.signals[0]!.aborted, "aborted before the deadline").toBe(false);

    await vi.advanceTimersByTimeAsync(12_000);

    // Without this the user is told the read failed while it may yet succeed — a lie in the
    // other direction, and one that keeps a socket open per hung message open.
    expect(t.signals[0]!.aborted, "the request was left running after the user was told it failed").toBe(true);
  });

  it("a HANG ON THE BODY is bounded too — headers are not an answer", async () => {
    freezeTimers();
    // A server that sends 200 and then stalls the body stream. `res.json()` is outside
    // `request()`, so a deadline that ended when the Response object arrived would miss this
    // entirely and the list would sit on `loading` exactly as before.
    const stalled = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise<unknown>(() => {}),
    } as unknown as Response;
    const engine = engineOver(async () => stalled);

    const pending = engine.loadAttachments("m1");
    await vi.advanceTimersByTimeAsync(12_000);

    expect(await pending).toMatchObject({ state: "failed", code: "timeout", retryable: true });
  });

  it("an answer inside the bound is untouched, and no late timer fires over it", async () => {
    freezeTimers();
    const engine = engineOver(async () => listOf([ONE_FILE]));

    const outcome = await engine.loadAttachments("m1");
    expect(outcome).toMatchObject({ state: "ready" });

    // The deadline must be DISARMED, not merely out-raced. Left armed it is one live timer per
    // message opened for the life of the tab, and it fires an abort at a controller whose request
    // is long finished. Counting is the only way to see it: the outcome below is identical either
    // way, which is exactly how an uncleared timer survives a test suite.
    expect(vi.getTimerCount(), "the deadline outlived the request it was bounding").toBe(0);

    await vi.advanceTimersByTimeAsync(A_LONG_TIME_MS);
    expect(engine.attachmentsOf("m1")).toMatchObject({ state: "ready" });
  });

  it("the abandoned request's LATE rejection is swallowed, not left unhandled", async () => {
    freezeTimers();
    let rejectLate: ((err: unknown) => void) | null = null;
    const engine = engineOver(() => new Promise<Response>((_resolve, reject) => { rejectLate = reject; }));

    const seen: unknown[] = [];
    const onUnhandled = (err: unknown): void => { seen.push(err); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending = engine.loadAttachments("m1");
      await vi.advanceTimersByTimeAsync(12_000);
      await pending;

      // The real transport rejects with an AbortError the moment we abort it; a proxy that
      // eventually gives up rejects later. Either way the loser of the race is a rejected
      // promise nobody is awaiting, and an unhandled rejection in a browser is a console error
      // the user gets to see for a request the app deliberately abandoned.
      rejectLate!(new Error("the abandoned request eventually failed"));
      await macrotask();
      await macrotask();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(seen, "abandoning the request left an unhandled rejection behind").toEqual([]);
  });
});

/* ── 2. the retry that change landed still works over a timeout ────────────────────────── */

describe("a timeout is a state a human can act on", () => {
  it("Try again really asks a second time, and the files arrive in place of the sentence", async () => {
    freezeTimers();
    let call = 0;
    const engine = engineOver((_url, _init) => {
      call += 1;
      if (call === 1) return new Promise<Response>(() => {});
      return Promise.resolve(listOf([ONE_FILE]));
    });

    const first = engine.loadAttachments("m1");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await first).toMatchObject({ state: "failed", code: "timeout", retryable: true });

    // The engine's single-flight map has to have released this message, or the retry coalesces
    // onto the request we just abandoned and the button does nothing for ever.
    const again = await engine.loadAttachments("m1", { retry: true });
    expect(call, "the retry never reached the wire — it coalesced onto the abandoned request").toBe(2);
    expect(again).toMatchObject({ state: "ready" });
    expect((again as Extract<AttachmentsOutcome, { state: "ready" }>).items[0]!.filename).toBe("invoice.pdf");
  });

  it("an ORDINARY call over a held timeout does not re-ask — only a press does", async () => {
    freezeTimers();
    const t = hungTransport();
    const engine = engineOver(t.fetch);

    const first = engine.loadAttachments("m1");
    await vi.advanceTimersByTimeAsync(12_000);
    await first;
    expect(t.calls).toBe(1);

    // The shell's effect calls this on every message open. Re-asking automatically would mean a
    // hung backend costs 12 seconds per render pass rather than 12 seconds per press.
    await engine.loadAttachments("m1");
    expect(t.calls).toBe(1);
  });

  it("RELEASED MID-FLIGHT: the deadline still lands, and what it leaves behind is serviceable", async () => {
    freezeTimers();
    const t = hungTransport();
    const engine = engineOver(t.fetch);

    void engine.loadAttachments("m1");
    // The user navigated away. `releaseAttachments` drops the list; the deadline is still armed.
    engine.releaseAttachments("m1");
    await vi.advanceTimersByTimeAsync(12_000);

    // ACCEPTED, NOT AN OVERSIGHT. The write-back resurrects an entry for a message nobody is
    // looking at. The obvious guard — only write back when a `loading` entry is still there —
    // reintroduces a re-select while the request is in flight returns through the
    // single-flight branch WITHOUT re-setting `loading`, so the guard would skip the write-back
    // and that message would sit on the default `loading` for ever. A stale, honest, retryable
    // failure is the cheaper of the two.
    expect(engine.attachmentsOf("m1")).toMatchObject({ state: "failed", code: "timeout", retryable: true });

    // Serviceable is the whole claim: whatever the resurrected entry says, the user is never
    // stuck behind it. A press re-asks and reaches the wire.
    const second = engine.loadAttachments("m1", { retry: true });
    expect(t.calls, "the re-ask after a release did not reach the wire").toBe(2);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await second).toMatchObject({ state: "failed", code: "timeout" });
  });
});

/* ── 3. the blast radius, pinned ───────────────────────────────────────────────────────── */

describe("the deadline is opt-in per call, and the calls that DON'T have one are a decision", () => {
  it("`/sync` is NOT bounded — a drain legitimately runs longer than a list read", async () => {
    freezeTimers();
    const adapter = new HttpAdapter({ baseUrl: "/api", fetch: () => new Promise<Response>(() => {}) });

    let settled = false;
    void adapter.sync({ since: "0" }).then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(A_LONG_TIME_MS);

    expect(
      settled,
      "a blanket deadline on `request()` would bound the sync drain too — that is a different decision from bounding one read",
    ).toBe(false);
  });

  it("the BYTE fetch is NOT bounded — giving up here does not release the server's IMAP slot", async () => {
    freezeTimers();
    const adapter = new HttpAdapter({ baseUrl: "/api", fetch: () => new Promise<Response>(() => {}) });

    let settled = false;
    void adapter.fetchAttachment("a1").then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(A_LONG_TIME_MS);

    // `GET /attachments/:id` is `cost: "connection"`: it holds a slot in `imap-admission` for up
    // to `IMAP_ADMISSION_WINDOW_MS` (90 s), and a CLIENT that stops waiting does not hand that
    // slot back. A deadline here plus the retry it invites would double-count against the
    // per-mailbox cap and produce a `mailbox_busy` the user caused by being told to try again.
    expect(settled, "a client-side deadline on a `cost: \"connection\"` route is not a free action").toBe(false);
  });

  it("MUTATIONS are NOT bounded — an aborted write is ambiguous in a way a read never is", async () => {
    freezeTimers();
    const adapter = new HttpAdapter({ baseUrl: "/api", fetch: () => new Promise<Response>(() => {}) });

    let settled = false;
    void adapter
      .mutate({ kind: "triage_set", messageId: "m1", state: "done" } as never, { idempotencyKey: "k1" })
      .then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(A_LONG_TIME_MS);

    // "It failed" over a write that may have landed is the lie this gap exists to avoid, pointed
    // the other way — and `POST /rules` carries no server-side idempotency claim, so an
    // abort-then-retry there writes a second rule. Bounding writes needs that work first.
    expect(settled, "a deadline on mutations is a separate decision with its own hazards").toBe(false);
  });
});
