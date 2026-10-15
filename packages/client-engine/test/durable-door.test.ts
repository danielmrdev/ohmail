/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DURABILITY_LOST_EVENT,
  type DurabilityLostDetail,
  durabilityLost,
  durableProbe,
  durableRemove,
  durableSessionRemove,
  durableSessionSet,
  durableSet,
  localStorageDoor,
  resetDurabilityForTest,
  storageDoor,
} from "../src/durable.js";
import { MIRROR_REGISTRY_PREFIX, rememberMirror } from "../src/idb.js";

/**
 * THE DOOR MOVED PACKAGES AND STILL ANSWERS — and three roots that could not reach it now do.
 *
 * The class this closes: the client engine's mirror registry, the shared UI package's theme
 * provider and the desktop window each wrote `localStorage` inside a swallowing `try`, because the
 * door that ANSWERS lived in `apps/webapp` and no package may import from an app. A private window
 * therefore turned "this browser remembers" into a claim nobody had checked, in three places at
 * once. The door is in this package now; these cases drive it from here.
 *
 * ── THE MUTATIONS EVERY CASE BELOW WAS WATCHED AGAINST ─────────────────────────────────────────
 *
 *  · `return lost(store)` → `return "lost"` in `durableSet` (announce without the latch) →
 *    "a refused write raises the notice once" goes red: no event, `durabilityLost()` false;
 *  · `announced = true` deleted from `lost()` → the same case goes red on `durabilityLost()`;
 *  · `durableProbe`'s `return false` → `return lost(key)` (the probe joining the notice) →
 *    "a refused probe says no and stays quiet" goes red on the event count;
 *  · `if (!jar) return lost(store)` → `return "stored"` in `storageDoor` → "a null jar is lost,
 *    not quietly fine" goes red;
 *  · `rememberMirror`'s `durableSet` → a bare `globalThis.localStorage.setItem` in a `try` →
 *    "the mirror registry's refusal reaches the notice" goes red.
 */

/** A jar that refuses every write the way a private window does: it throws on `setItem`. */
function refusingJar(): Storage {
  const kept = new Map<string, string>();
  return {
    get length() { return kept.size; },
    clear: () => kept.clear(),
    getItem: (k: string) => kept.get(k) ?? null,
    key: (i: number) => [...kept.keys()][i] ?? null,
    removeItem: () => { throw new DOMException("removal refused", "QuotaExceededError"); },
    setItem: () => { throw new DOMException("quota exceeded", "QuotaExceededError"); },
  } as Storage;
}

let heard: DurabilityLostDetail[] = [];
const listen = (e: Event): void => { heard.push((e as CustomEvent<DurabilityLostDetail>).detail); };

/**
 * Put a hostile jar on the window for one case, and put the real one back afterwards.
 *
 * jsdom's `localStorage` lives on the prototype, so an own property shadows it — and `globalThis`
 * IS `window` here, which is the whole reason the door reads the jar off `globalThis`.
 */
const realJar = Object.getOwnPropertyDescriptor(window, "localStorage");
function swapJar(jar: Storage): void {
  Object.defineProperty(window, "localStorage", { value: jar, configurable: true });
}
function restoreJar(): void {
  if (realJar) Object.defineProperty(window, "localStorage", realJar);
  else delete (window as { localStorage?: unknown }).localStorage;
}

beforeEach(() => {
  resetDurabilityForTest();
  heard = [];
  window.addEventListener(DURABILITY_LOST_EVENT, listen);
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  window.removeEventListener(DURABILITY_LOST_EVENT, listen);
  restoreJar();
});

describe("the durable write door, in the package every client root can reach", () => {
  it("a write that lands says so, and raises nothing", () => {
    expect(durableSet("k", "v", "probe")).toBe("stored");
    expect(window.localStorage.getItem("k")).toBe("v");
    expect(durableRemove("k", "probe")).toBe("stored");
    expect(window.localStorage.getItem("k")).toBeNull();
    expect(durableSessionSet("s", "v", "probe")).toBe("stored");
    expect(durableSessionRemove("s", "probe")).toBe("stored");
    expect(heard).toEqual([]);
    expect(durabilityLost()).toBe(false);
  });

  it("a refused write raises the notice once, and names the store", () => {
    swapJar(refusingJar());
    expect(durableSet("k", "v", "screener")).toBe("lost");
    expect(durableRemove("k", "screener")).toBe("lost");
    expect(heard.map((d) => d.store)).toEqual(["screener", "screener"]);
    // The NOTICE is the latch, not the event count: two losses, one sentence.
    expect(durabilityLost()).toBe(true);
  });

  it("a refused probe answers no and stays quiet — its refusal IS its answer", () => {
    swapJar(refusingJar());
    const answer = durableProbe("probe.key");
    expect(answer).toBe(false);
    expect(heard, "a probe must not claim the reader lost a decision").toEqual([]);
    expect(durabilityLost()).toBe(false);
  });

  it("a probe on a working jar answers yes and leaves nothing behind", () => {
    expect(durableProbe("probe.key")).toBe(true);
    expect(window.localStorage.getItem("probe.key")).toBeNull();
  });

  describe("the door as an object, over a jar the caller is handed", () => {
    it("reads and writes the jar it was given, not the window's", () => {
      const kept = new Map<string, string>();
      const mine = {
        getItem: (k: string) => kept.get(k) ?? null,
        setItem: (k: string, v: string) => void kept.set(k, v),
        removeItem: (k: string) => void kept.delete(k),
      } as unknown as Storage;
      const door = storageDoor(mine, "host-pair");
      expect(door.set("a", "1")).toBe("stored");
      expect(kept.get("a")).toBe("1");
      expect(door.get("a")).toBe("1");
      expect(window.localStorage.getItem("a"), "the window's jar must be untouched").toBeNull();
      expect(door.remove("a")).toBe("stored");
      expect(door.get("a")).toBeNull();
      expect(heard).toEqual([]);
    });

    it("a refusing jar is lost, and a NULL jar is lost too — not quietly fine", () => {
      const refusing = storageDoor(refusingJar(), "host-pair");
      expect(refusing.set("a", "1")).toBe("lost");
      expect(refusing.remove("a")).toBe("lost");
      const none = storageDoor(null, "host-pair");
      expect(none.set("a", "1"), "a browser with no jar at all lost the write").toBe("lost");
      expect(none.remove("a")).toBe("lost");
      expect(none.get("a")).toBeNull();
      expect(heard.map((d) => d.store)).toEqual(["host-pair", "host-pair", "host-pair", "host-pair"]);
    });

    it("localStorageDoor resolves its jar per call, never captures one", () => {
      const door = localStorageDoor("theme");
      expect(door.set("ohmail.theme", "dark")).toBe("stored");
      expect(window.localStorage.getItem("ohmail.theme")).toBe("dark");
      /* THE SSR SHAPE: a host builds this at module scope, and a client module is evaluated on the
         server too. A door that read the jar once, there, would answer "lost" for ever after
         hydration — so the jar is swapped UNDER a door that already exists. */
      swapJar(refusingJar());
      expect(door.set("ohmail.theme", "light")).toBe("lost");
      expect(heard.map((d) => d.store)).toEqual(["theme"]);
    });
  });

  /**
   * THE MIRROR REGISTRY'S REFUSAL REACHES THE NOTICE — the first of the three roots, driven
   * through its own product function rather than through the door.
   *
   * `rememberMirror` is what lets a sign-out name a database on a browser that will not enumerate
   * its own. It swallowed its refusal, so a browser that kept no registry reported a clean wipe
   * over an earlier account's mirror with nothing anywhere saying the registry was empty because
   * it could not be written.
   */
  it("the mirror registry writes through the door, and says so when refused", () => {
    expect(rememberMirror("ohmail-mirror:acct")).toBe("stored");
    expect(window.localStorage.getItem(`${MIRROR_REGISTRY_PREFIX}ohmail-mirror:acct`)).toBe("1");
    expect(heard).toEqual([]);

    swapJar(refusingJar());
    expect(rememberMirror("ohmail-mirror:acct")).toBe("lost");
    expect(heard.map((d) => d.store)).toEqual(["idb:ohmail-mirror"]);
    expect(durabilityLost()).toBe(true);
  });
});
