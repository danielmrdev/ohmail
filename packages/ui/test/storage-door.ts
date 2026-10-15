import type { StorageDoor, StorageVerdict } from "@ohmail/ui";

/**
 * A `StorageDoor` for the tests, over a jar they hand it.
 *
 * `packages/ui` declares the door's SHAPE and implements none of it — the real one is in
 * `@ohmail/client-engine` and this package may not import it, which is the whole reason
 * `ThemeProvider` takes a prop. So the tests implement the interface too, and they implement it
 * the way production fails: a jar that throws answers "lost", never a silent success.
 */
export interface CountingDoor extends StorageDoor {
  /** Every call, in order — `set k=v`, `remove k`, `get k` — so an assertion can be about zero. */
  readonly calls: string[];
}

export function jarDoor(jar: Storage = window.localStorage): CountingDoor {
  const calls: string[] = [];
  const attempt = (note: string, run: () => void): StorageVerdict => {
    calls.push(note);
    try {
      run();
      return "stored";
    } catch {
      return "lost";
    }
  };
  return {
    calls,
    get(key) {
      calls.push(`get ${key}`);
      try {
        return jar.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => attempt(`set ${key}=${value}`, () => jar.setItem(key, value)),
    remove: (key) => attempt(`remove ${key}`, () => jar.removeItem(key)),
  };
}

/** A jar that refuses every write the way a private window does. Reads still work. */
export function refusingJar(): Storage {
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
