import { afterEach, describe, expect, it, vi } from "vitest";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { boot, liar, ordinary, rig, server, type Msg } from "./_overrun-rig.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 6 });

/**
 * OVERRUN SET-ASIDES AND THE RECONNECT LADDER, DESKTOP ENGINE.
 * Eight liars stream ascending ahead of new mail, one set aside per re-dial. A re-dial whose breach
 * set its message aside made progress, so the next waits the ladder's first step, never a climbed one.
 */
describe("the desktop engine: overrun set-asides and the reconnect ladder", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); vi.restoreAllMocks(); });
  const clock = { skewMs: 0 };

  it("row 2: eight liars, new mail behind them: every re-dial after a set-aside waits the first step", async () => {
    const LIARS = 8;
    const inbox: Array<[number, Msg]> = [[1, ordinary("old-1")]];
    for (let u = 2; u <= LIARS + 1; u++) inbox.push([u, liar(`${u}`)]);
    const s = server(inbox);
    const { cycle, subjects, events, connection } = await boot(rig(s), clock, cleanups);
    const POLL_MS = 20_000;
    let storedAtMs = -1;
    const unreachableAt: number[] = [];
    // The attach met the first liar: the server answered, so nothing is unreachable before a re-dial.
    if (!(await connection()).reachable) unreachableAt.push(-1);
    for (let i = 0; i < 120 && storedAtMs < 0; i++) {
      if (i === 1) s.state.folders.get("INBOX")!.msgs.set(100, ordinary("new-mail"));
      clock.skewMs += POLL_MS; const n0 = events.length;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hung = await Promise.race([cycle().then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), 15_000); })]);
      clearTimeout(timer);
      // A poll that does not settle is reported by name rather than read as a timeout.
      if (hung) {
        const seen = events.slice(n0).map((e) => e.event);
        const tally: Record<string, number> = {};
        for (const e of seen) tally[e] = (tally[e] ?? 0) + 1;
        console.log("ROW2 HUNG", i, seen.length, JSON.stringify(tally), JSON.stringify(seen.slice(-12)));
        break;
      }
      if (!(await connection()).reachable) unreachableAt.push(i);
      if ((await subjects()).includes("new-mail")) storedAtMs = clock.skewMs;
    }
    const waits = events.filter((e) => e.event === "mailbox_reconnect_failed").map((e) => e.detail.retryInMs as number);
    console.log("ROW2 desktop", JSON.stringify({ storedAtMs, waits, perLiar: s.state.perLiar }));
    expect(Object.values(s.state.perLiar), "a set-aside message was fetched again").toEqual(Array(LIARS).fill(1));
    expect(storedAtMs, "new mail was never stored").toBeGreaterThan(0);
    expect(Math.max(0, ...waits), "a re-dial after a set-aside climbed the ladder").toBeLessThanOrEqual(15_000 * 1.2);
    expect(storedAtMs, "new mail waited longer than one first step per liar").toBeLessThanOrEqual((LIARS + 3) * POLL_MS);
    expect(unreachableAt, "polls that reported the server unreachable while it answered").toEqual([]);
    expect(events.filter((e) => e.event === "mailbox_redial_after_set_aside").length).toBe(LIARS - 1);
  });

  it("row 2: the next poll is armed AT the jittered first step, even past the poll interval", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const armed: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number") armed.push(ms);
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout);
    const inbox: Array<[number, Msg]> = [[1, ordinary("old-1")]];
    for (let u = 2; u <= 4; u++) inbox.push([u, liar(`${u}`)]);
    const s = server(inbox);
    const { cycle, events } = await boot(rig(s), clock, cleanups, { pollIntervalMs: 15_000 });
    for (let i = 0; i < 3; i++) { clock.skewMs += 20_000; await cycle(); }
    const floors = events.filter((e) => e.event === "mailbox_redial_after_set_aside");
    expect(floors.length, "no re-dial after a set-aside").toBeGreaterThanOrEqual(1);
    const retryInMs = floors[0]!.detail.retryInMs as number;
    // 0.99 jitters the 15 s step to 17.97 s, past the 15 s poll: a poll at 15 s would be deferred.
    expect(retryInMs).toBeGreaterThan(15_000);
    expect(armed.some((ms) => Math.abs(ms - retryInMs) <= 50), `no poll armed at ${retryInMs} ms (armed: ${armed.filter((m) => m >= 1_000).join(",")})`).toBe(true);
  });

  it("NO PROGRESS: a liar re-read because its server names no UIDVALIDITY climbs the ladder", async () => {
    /* A set-aside row is not progress unless THIS cycle wrote it: with UIDVALIDITY 0 the adapter
       cannot match the row's epoch, so the same liar comes back on every re-dial. */
    const inbox: Array<[number, Msg]> = [[1, ordinary("old-1")], [2, liar("2")], [3, ordinary("behind-the-liar")]];
    const s = server(inbox);
    s.state.folders.get("INBOX")!.uidValidity = 0n;
    const { cycle, events, connection } = await boot(rig(s), clock, cleanups);
    const reachable: boolean[] = [];
    for (let i = 0; i < 8; i++) { clock.skewMs += 20_000; await cycle(); reachable.push((await connection()).reachable); }
    const waits = events.filter((e) => e.event === "mailbox_reconnect_failed").map((e) => e.detail.retryInMs as number);
    const progress = events.filter((e) => e.event === "mailbox_redial_after_set_aside").length;
    console.log("EPOCHLESS", JSON.stringify({ perLiar: s.state.perLiar, progress, waits, reachable }));
    expect(progress, "a re-read of an older set-aside read as progress").toBe(0);
    expect(Math.max(0, ...waits), "the re-dials over the same liar did not climb").toBeGreaterThan(15_000 * 1.2);
    expect(reachable.at(-1), "a mailbox stuck on one liar read reachable").toBe(false);
  });

  it("a refused certificate, then a press meets a liar: the automatic re-dials resume and the sentence clears", async () => {
    const inbox: Array<[number, Msg]> = [[1, ordinary("old-1")], [2, liar("2")], [3, liar("3")], [4, ordinary("new-mail")]];
    const s = server(inbox);
    const r = rig(s);
    r.control.failNextConnect = Object.assign(new Error("self-signed certificate"), { tlsFailed: true, certificateRefused: true });
    const { cycle, events, subjects, sidecar } = await boot(r, clock, cleanups);
    const refused = (): boolean => sidecar.connectionStates()[sidecar.world.mailboxId]!.certificateRefused === true;
    expect(refused(), "the launch's certificate refusal was not recorded, so this case proves nothing").toBe(true);
    const res = await sidecar.handle(new Request(`http://local/mailboxes/${encodeURIComponent(sidecar.world.mailboxId)}/resync`, {
      method: "POST", headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" }, body: "{}",
    }));
    expect(res.status, "the resync route refused, so this case proves nothing").toBe(202);
    const t0 = Date.now() - clock.skewMs;
    while (!events.some((e) => e.event === "mailbox_redial_after_set_aside") && Date.now() - clock.skewMs - t0 < 10_000) {
      await new Promise((done) => setTimeout(done, 25));
    }
    expect(events.some((e) => e.event === "mailbox_redial_after_set_aside"), "the press never met the liar").toBe(true);
    for (let i = 0; i < 4; i++) { clock.skewMs += 20_000; await cycle(); }
    expect(refused(), "the stale certificate sentence stayed up over a server that answered").toBe(false);
    expect(await subjects(), "the automatic re-dial never resumed after the press").toContain("new-mail");
  });
});
