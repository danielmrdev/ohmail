import { afterEach, describe, expect, it, vi } from "vitest";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { boot, liar, ordinary, rig, server, type Msg } from "./_overrun-rig.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 6 });

/**
 * OVERRUN SET-ASIDES AND THE BACKSTOP HOLD, DESKTOP ENGINE. With
 * only liars to read, every one is set aside once and the server answers, so the mailbox row says
 * nothing about storage: the hold, reloaded from the store each cycle, does not stand over them.
 */
describe("the desktop engine: overrun set-asides and the hold", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); vi.restoreAllMocks(); });
  const clock = { skewMs: 0 };

  for (const LIARS of [5, 6]) {
    it(`row 1: ${LIARS} liars and no other mail: the mailbox row never reads errorCode storage`, async () => {
      const inbox: Array<[number, Msg]> = [];
      for (let u = 1; u <= LIARS; u++) inbox.push([u, liar(`${u}`)]);
      const s = server(inbox);
      const { cycle, connection, errorCode, subjects } = await boot(rig(s), clock, cleanups);
      const per: Array<{ i: number; aside: number; reachable: boolean; code: string | null }> = [];
      for (let i = 0; i < LIARS + 4; i++) {
        clock.skewMs += 400_000; await cycle();
        const c = await connection();
        per.push({ i, aside: c.setAside, reachable: c.reachable, code: await errorCode() });
      }
      console.log(`ROW1 desktop LIARS=${LIARS}`, JSON.stringify({ per, perLiar: s.state.perLiar }));
      expect(Object.values(s.state.perLiar), "a set-aside message was fetched again").toEqual(Array(LIARS).fill(1));
      expect(per.at(-1), "the liars are set aside over a reachable server").toMatchObject({ aside: LIARS, reachable: true });
      expect(await subjects()).toEqual([]);
      expect(per.filter((p) => p.code === "storage").map((p) => p.i), "polls whose row read errorCode storage").toEqual([]);
    });
  }
});
