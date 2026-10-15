import { describe, expect, it } from "vitest";
import {
  armRoutingIntent,
  disarmRoutingIntent,
  isReleaseIntent,
  releaseIntentsKey,
  routingIntentsKey,
  routingSubject,
  takeRoutingIntents,
  type ReleaseIntent,
  type RoutingIntent,
  type StorageDoor,
} from "@ohmail/client-engine";

/**
 * A SCREENER RELEASE HAS ITS OWN JAR, AND IT IS A CHANGE OF MIND ABOUT ITS SENDER. A release held
 * in the routing window survives a kill as its own row, a later press about the same sender
 * replaces it (only the last word is written), and a row this build cannot act on is dropped.
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
const release: ReleaseIntent = {
  v: 4, verb: "release", id: "r1", seedId: "m1", address: "Out@One.test", scope: "sender",
  from: "ohmail/Screened", dest: "ohbox", messageIds: ["m1"], at: 1000,
};
const move: RoutingIntent = {
  v: 1, id: "v1", seedId: "m2", address: "out@one.test", scope: "sender", dest: "reads", messageIds: ["m2"], at: 1100,
};

describe("the release jar", () => {
  it("a v4 row lands in its own jar and comes back at the next launch", () => {
    const d = door();
    armRoutingIntent(d, KEY, release);
    expect(JSON.parse(d.jar.get(releaseIntentsKey(KEY))!)).toEqual([release]);
    expect(d.jar.has(KEY)).toBe(false);
    expect(takeRoutingIntents(d, KEY, 2000).live).toEqual([release]);
    disarmRoutingIntent(d, KEY, "r1");
    expect(d.jar.has(releaseIntentsKey(KEY))).toBe(false);
  });

  it("a later Move about the same sender replaces the release, and the other way round", () => {
    const d = door();
    expect(routingSubject(release)).toBe(routingSubject(move));
    armRoutingIntent(d, KEY, release);
    armRoutingIntent(d, KEY, move);
    expect(takeRoutingIntents(d, KEY, 2000).live.map((r) => r.id)).toEqual(["v1"]);
    armRoutingIntent(d, KEY, { ...release, id: "r2", at: 1200 });
    expect(takeRoutingIntents(d, KEY, 2000).live.map((r) => r.id)).toEqual(["r2"]);
  });

  it("back to Waiting is a release; a pile it cannot come from is not a row", () => {
    expect(isReleaseIntent({ ...release, from: "ohmail/Quarantine", dest: "screener" })).toBe(true);
    expect(isReleaseIntent({ ...release, from: "INBOX" })).toBe(false);
    const { from: _f, ...noFrom } = release;
    expect(isReleaseIntent(noFrom)).toBe(false);
    const d = door();
    d.set(releaseIntentsKey(KEY), JSON.stringify([{ ...release, from: "INBOX" }, release]));
    expect(takeRoutingIntents(d, KEY, 2000).live).toEqual([release]);
  });
});
