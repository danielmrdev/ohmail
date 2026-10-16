import { describe, expect, it } from "vitest";
import {
  armRoutingIntent,
  disarmRoutingIntent,
  isScreenIntent,
  routingIntentsKey,
  screenIntentsKey,
  takeRoutingIntents,
  type RoutingIntent,
  type ScreenIntent,
  type StorageDoor,
} from "@ohmail/client-engine";

/**
 * A SENDER-SHEET PRESS HAS ITS OWN JAR. An older build loads the v1 jar, drops what it cannot
 * read and saves the jar back — so a v2 row there would be lost at the next save. In its own jar
 * it survives that, carries its answers, and still supersedes a press on the same sender.
 */
function door(): StorageDoor & { jar: Map<string, string> } {
  const jar = new Map<string, string>();
  return {
    jar,
    get: (k) => jar.get(k) ?? null,
    set: (k, v) => { jar.set(k, v); return "stored"; },
    remove: (k) => { jar.delete(k); return "stored"; },
  };
}

const KEY = routingIntentsKey("owner-1");
const screen: ScreenIntent = {
  v: 2, verb: "screen", id: "s1", seedId: "m1", address: "Alerts@Kestrel.example", scope: "sender", dest: "ohbox",
  messageIds: ["m1"], makeRule: true, applyRetro: true, resolution: "remove", shown: [{ id: "term", fp: "fp" }], at: 1000,
};
const move: RoutingIntent = {
  v: 1, id: "v1", seedId: "m2", address: "other@x.example", scope: "sender", dest: "reads", messageIds: ["m2"], at: 900,
};

describe("the screen jar", () => {
  it("a v2 row lands in its own jar and comes back with its resolution", () => {
    const d = door();
    armRoutingIntent(d, KEY, move);
    armRoutingIntent(d, KEY, screen);
    expect(JSON.parse(d.jar.get(KEY)!)).toEqual([move]);
    expect(JSON.parse(d.jar.get(screenIntentsKey(KEY))!)).toEqual([screen]);
    const { live } = takeRoutingIntents(d, KEY, 2000);
    expect(live).toEqual([move, screen]);
  });

  it("an older build's load-and-save over the v1 jar leaves the screen jar byte for byte", () => {
    const d = door();
    armRoutingIntent(d, KEY, screen);
    const before = d.jar.get(screenIntentsKey(KEY));
    // The 0.25.1 loader: read the v1 key, keep `v === 1`, write it back.
    const old = (JSON.parse(d.jar.get(KEY) ?? "[]") as Array<{ v: number }>).filter((r) => r.v === 1);
    d.set(KEY, JSON.stringify([...old, move]));
    expect(d.jar.get(screenIntentsKey(KEY))).toBe(before);
    expect(takeRoutingIntents(d, KEY, 2000).live.map((r) => r.id)).toEqual(["v1", "s1"]);
  });

  it("a press on the same sender supersedes across both jars, and a disarm finds either", () => {
    const d = door();
    armRoutingIntent(d, KEY, { ...move, address: "alerts@kestrel.example" });
    armRoutingIntent(d, KEY, screen);
    expect(d.jar.has(KEY)).toBe(false);
    disarmRoutingIntent(d, KEY, "s1");
    expect(d.jar.has(screenIntentsKey(KEY))).toBe(false);
  });

  it("a row missing an answer is not a row", () => {
    const { resolution: _r, ...noResolution } = screen;
    const { applyRetro: _a, ...noRetro } = screen;
    expect(isScreenIntent(screen)).toBe(true);
    expect(isScreenIntent(noResolution)).toBe(false);
    expect(isScreenIntent(noRetro)).toBe(false);
    expect(isScreenIntent({ ...screen, v: 1 })).toBe(false);
  });
});
