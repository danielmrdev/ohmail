import { describe, expect, it } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import { unscreenedGroups, unscreenedTotalOf } from "../src/selectors.js";
import type { EngineAdapter, UnscreenedGroupWire, UnscreenedWire } from "../src/adapters/adapter.js";

/**
 * "N MESSAGES FROM SENDERS YOU HAVE NOT DECIDED ABOUT" — WHAT THE CLIENT MAY SAY ABOUT IT.
 *
 * The set is a SERVER derivation: membership is what the ARRIVAL GATE would answer for each
 * message, over rules and contacts `/sync` carries only part of. So the client's whole job is to
 * hold the door's answer without improving on it — the headline number is the server's, a refresh
 * REPLACES the set rather than merging into it, and a door that cannot answer leaves no row at all
 * rather than a confident zero.
 */

const NOW = new Date("2026-09-22T09:00:00Z");
const ARRIVED = "2024-03-01T08:00:00.000Z";

const group = (o: { address: string; count: number; newestAt?: string }): UnscreenedGroupWire => ({
  newestAt: ARRIVED, ...o,
});

/** A door that answers `unscreened` from a script and records every press. */
function doorWith(answers: UnscreenedWire[]): {
  adapter: EngineAdapter; presses: Array<readonly string[] | undefined>;
} {
  const presses: Array<readonly string[] | undefined> = [];
  let i = 0;
  const adapter = {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: null, hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
    unscreened: async () => answers[Math.min(i++, answers.length - 1)]!,
    screenUnscreened: async (addresses?: readonly string[]) => {
      presses.push(addresses);
      return { screened: [], total: 5 };
    },
  } as unknown as EngineAdapter;
  return { adapter, presses };
}

const engineOn = async (adapter: EngineAdapter): Promise<OhmailEngine> => {
  const engine = new OhmailEngine({ adapter, now: () => NOW });
  await engine.start();
  return engine;
};

describe("the undecided-sender offer, client side", () => {
  it("holds the door's groups largest first, and takes the total from the server", async () => {
    const { adapter } = doorWith([{
      groups: [group({ address: "small@x.test", count: 2 }), group({ address: "big@x.test", count: 9 })],
      total: 11,
      max: 200,
    }]);
    const engine = await engineOn(adapter);
    await engine.refreshUnscreened();

    const rows = unscreenedGroups(engine.read());
    expect(rows.map((r) => [r.id, r.count])).toEqual([["big@x.test", 9], ["small@x.test", 2]]);
    expect(unscreenedTotalOf(engine.read())).toBe(11);
    expect(rows[0]!.newestAt).toBe(ARRIVED);
  });

  it("a refresh REPLACES the set — a group the door no longer names is gone", async () => {
    const { adapter } = doorWith([
      { groups: [group({ address: "a@x.test", count: 3 }), group({ address: "b@x.test", count: 1 })], total: 4, max: 200 },
      { groups: [group({ address: "a@x.test", count: 1 })], total: 1, max: 200 },
    ]);
    const engine = await engineOn(adapter);
    await engine.refreshUnscreened();
    expect(unscreenedGroups(engine.read())).toHaveLength(2);

    await engine.refreshUnscreened();
    const rows = unscreenedGroups(engine.read());
    expect(rows.map((r) => r.id)).toEqual(["a@x.test"]);
    // The stale row's count would still read 3 if the set had been merged into.
    expect(rows[0]!.count).toBe(1);
    expect(unscreenedTotalOf(engine.read())).toBe(1);
  });

  it("a door with no such verb leaves NO row — never a confident zero", async () => {
    const adapter = {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: null, hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ ok: true as const, changes: [] }),
    } as unknown as EngineAdapter;
    const engine = await engineOn(adapter);
    await engine.refreshUnscreened();
    expect(unscreenedGroups(engine.read())).toEqual([]);
    // Zero rows and zero total read the same here, and that is the point: the surface renders no
    // row for either, so "you have none" is a sentence this path never produces.
    expect(unscreenedTotalOf(engine.read())).toBe(0);
    expect(await engine.screenUnscreenedSenders()).toBe(0);
  });

  it("the press carries the caller's groups, or nothing at all for every group", async () => {
    const { adapter, presses } = doorWith([{ groups: [group({ address: "a@x.test", count: 1 })], total: 1, max: 200 }]);
    const engine = await engineOn(adapter);

    expect(await engine.screenUnscreenedSenders()).toBe(5);
    expect(await engine.screenUnscreenedSenders(["a@x.test"])).toBe(5);
    // Absent is EVERY group and an empty array is none — two different requests, never collapsed.
    expect(presses).toEqual([undefined, ["a@x.test"]]);
  });

  it("the press re-reads, so the screen states what is LEFT rather than what was pressed", async () => {
    const { adapter } = doorWith([
      { groups: [group({ address: "a@x.test", count: 3 })], total: 3, max: 200 },
      { groups: [], total: 0, max: 200 },
    ]);
    const engine = await engineOn(adapter);
    await engine.refreshUnscreened();
    expect(unscreenedTotalOf(engine.read())).toBe(3);

    await engine.screenUnscreenedSenders();
    expect(unscreenedGroups(engine.read())).toEqual([]);
  });
});
