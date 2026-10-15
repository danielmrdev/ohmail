import { describe, expect, it } from "vitest";
import {
  armRoutingIntent,
  decideIntentsKey,
  disarmRoutingIntent,
  isDecideIntent,
  routingIntentsKey,
  routingSubject,
  screenIntentsKey,
  takeRoutingIntents,
  type DecideIntent,
  type RoutingIntent,
  type StorageDoor,
} from "@ohmail/client-engine";

/**
 * A SCREENER DECISION HAS ITS OWN JAR AND ITS OWN SUBJECT. The phone holds every Screener decision
 * in the routing window, so the row must survive an older build's load-and-save of the other two
 * jars, carry both scopes and the read answer, and never be dropped unsent by a Move of one of the
 * sender's letters inside the window.
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
const decide: DecideIntent = {
  v: 3, verb: "decide", id: "d1", seedId: "m1", address: "Alerts@Kestrel.example", scope: "sender",
  dest: "screened", read: false, messageIds: ["m1", "m3"], at: 1000,
};
const move: RoutingIntent = {
  v: 1, id: "v1", seedId: "m2", address: "alerts@kestrel.example", scope: "sender", dest: "reads", messageIds: ["m2"], at: 900,
};

describe("the decide jar", () => {
  it("a v3 row lands in its own jar and comes back whole", () => {
    const d = door();
    armRoutingIntent(d, KEY, move);
    armRoutingIntent(d, KEY, decide);
    expect(JSON.parse(d.jar.get(KEY)!)).toEqual([move]);
    expect(d.jar.has(screenIntentsKey(KEY))).toBe(false);
    expect(JSON.parse(d.jar.get(decideIntentsKey(KEY))!)).toEqual([decide]);
    expect(takeRoutingIntents(d, KEY, 2000).live).toEqual([move, decide]);
  });

  it("a Move about the same sender does not drop the decision, and a later decision does", () => {
    const d = door();
    armRoutingIntent(d, KEY, decide);
    armRoutingIntent(d, KEY, move);
    expect(routingSubject(decide)).not.toBe(routingSubject(move));
    expect(takeRoutingIntents(d, KEY, 2000).live.map((r) => r.id)).toEqual(["v1", "d1"]);
    armRoutingIntent(d, KEY, { ...decide, id: "d2", dest: "ohbox", at: 1100 });
    expect(JSON.parse(d.jar.get(decideIntentsKey(KEY))!).map((r: DecideIntent) => r.id)).toEqual(["d2"]);
    disarmRoutingIntent(d, KEY, "d2");
    expect(d.jar.has(decideIntentsKey(KEY))).toBe(false);
  });

  it("a domain decision is one subject for everyone at the domain", () => {
    const wide = { ...decide, scope: "domain" as const };
    expect(routingSubject(wide)).toBe(routingSubject({ ...wide, address: "news@KESTREL.example" }));
    expect(routingSubject(wide)).not.toBe(routingSubject(decide));
  });

  it("an older build's load-and-save of the other jars leaves the decide jar byte for byte", () => {
    const d = door();
    armRoutingIntent(d, KEY, decide);
    const before = d.jar.get(decideIntentsKey(KEY));
    d.set(KEY, JSON.stringify([move]));
    d.set(screenIntentsKey(KEY), JSON.stringify([]));
    expect(d.jar.get(decideIntentsKey(KEY))).toBe(before);
  });

  it("a row missing an answer is not a row", () => {
    const { read: _r, ...noRead } = decide;
    expect(isDecideIntent(decide)).toBe(true);
    expect(isDecideIntent({ ...decide, scope: "domain" })).toBe(true);
    expect(isDecideIntent(noRead)).toBe(false);
    expect(isDecideIntent({ ...decide, scope: "everyone" })).toBe(false);
    expect(isDecideIntent({ ...decide, dest: "screener" })).toBe(false);
    expect(isDecideIntent({ ...decide, v: 2 })).toBe(false);
  });
});
