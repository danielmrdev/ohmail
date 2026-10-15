/**
 * THE STANDALONE INSTALL'S ENGINE KEY — the four ways it loses mail, each watched.
 *
 * `kek.ts` holds the key that opens the mailbox password on a phone that organizes its own mail.
 * Every failure it guards is silent and arrives late: the credential is sealed now and unopenable
 * on a launch days later, on a screen that says nothing about a keystore. So each rule gets a case
 * whose failure is the DATA LOSS, not the code path — and each of the two "did nothing" rules gets
 * a positive control, because a module that refuses everything passes a suite made only of
 * refusals (`ensureKek` must also mint a key for an ordinary first launch, and must NOT mint one
 * when a good key is already there).
 *
 * ── THE DOUBLE YIELDS, AND THAT IS THE POINT OF THE LAST CASE ─────────────────────────────
 *
 * A ruling's amendment measured this exact trap on the store next door: a SYNCHRONOUS test
 * double cannot express the interleaving hazard an asynchronous platform half has, so removing the
 * serialization leaves the suite green. expo-secure-store is asynchronous. The double here awaits
 * a real macrotask between read and write, so the concurrency case fails when the chain in `kek.ts`
 * is removed — verified by removing it (see the case's own note).
 */
import { describe, expect, it } from "vitest";
import type { SecureKV } from "../src/state/servers";
import { KEK_BYTES, KEK_KEY, ensureKek, forgetKek, kekRing, type KekVerdict } from "../src/engine/kek";
import { sayRefusal, type Refusal } from "../src/refusal";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";

/** A valid key: 64 hex characters. Fixed rather than random so a failure prints the same thing. */
const GOOD = "a".repeat(64);
const OTHER = "b".repeat(64);

/**
 * expo-secure-store's two methods over a Map, WITH A REAL YIELD in each of them.
 *
 * The yield is the fixture's whole contribution beyond a Map: it is what lets two callers
 * interleave at an `await`, which is the only shape in which a lost key is reachable.
 */
function memoryKV(
  seed?: Record<string, string>,
  /**
   * A KEYSTORE THAT ACCEPTS A WRITE AND DOES NOT KEEP IT — armed up front, never mid-flight.
   *
   * Every read that happens AFTER the first `set` answers this instead of what is stored. Stated
   * as a MODE rather than as "make the next `get` answer X" because the one-shot spelling was
   * written first and was a fixture bug, not a finding: arming it from the test body races the
   * module's own `await`s, so whether it landed on the mint's read or on the read-back depended on
   * macrotask ordering, and two cases failed for reasons that had nothing to do with `kek.ts`.
   * Keyed on "a write has happened" it is deterministic whatever the interleaving.
   */
  readBackAs?: { value: string | null },
): SecureKV & { readonly writes: string[]; store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  const writes: string[] = [];
  const kv = {
    store,
    writes,
    async get(key: string): Promise<string | null> {
      await new Promise((r) => setTimeout(r, 0));
      if (readBackAs && writes.length > 0) return readBackAs.value;
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      await new Promise((r) => setTimeout(r, 0));
      writes.push(value);
      store.set(key, value);
    },
    async remove(key: string): Promise<void> {
      await new Promise((r) => setTimeout(r, 0));
      store.delete(key);
    },
  };
  return kv;
}

/** A random source that counts its calls, so "it did not regenerate" is an assertion. */
function countingRandom(value = GOOD): { hex: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    hex: async () => {
      calls += 1;
      return value;
    },
    calls: () => calls,
  };
}

/**
 * THE REFUSAL A VERDICT CARRIES, and the assertion that it refused at all.
 *
 * `ensureKek` returns rather than throws, so every case below reads a VALUE. This is where "it
 * produced a key instead" fails by name rather than as a missing property on the wrong shape.
 */
const refusalOf = (verdict: KekVerdict): Refusal => {
  expect(verdict.kind, "ensureKek produced a key where it must refuse").toBe("refused");
  return (verdict as { kind: "refused"; reason: Refusal }).reason;
};

describe("the engine key on a standalone install", () => {
  it("mints one on a first launch, stores it under the engine's own name, and returns it", async () => {
    const kv = memoryKV();
    const rnd = countingRandom();

    const verdict = await ensureKek(kv, rnd.hex);

    // THE POSITIVE CONTROL for the whole file: the ordinary first launch WORKS. A suite of
    // refusals would pass over a module that never produced a key at all, and the product would
    // be a phone that cannot store a password.
    expect(verdict).toEqual({ kind: "key", hex: GOOD });
    expect(rnd.calls()).toBe(1);
    expect(kv.store.get(KEK_KEY)).toBe(GOOD);
    // Namespaced apart from the pairing store, whose fresh-install purge walks its own index.
    expect(KEK_KEY.startsWith("ohmail.servers")).toBe(false);
  });

  it("returns the standing key on every later launch and does NOT ask the random source", async () => {
    const kv = memoryKV({ [KEK_KEY]: GOOD });
    const rnd = countingRandom(OTHER);

    expect(await ensureKek(kv, rnd.hex)).toEqual({ kind: "key", hex: GOOD });

    // The assertion that matters is the SECOND one. A version of this module that minted a fresh
    // key on every launch would satisfy the first: it returns 64 valid hex characters. What it
    // would also do is orphan every credential sealed under the previous one.
    expect(rnd.calls()).toBe(0);
    expect(kv.writes).toEqual([]);
  });

  it("refuses a stored key that is malformed rather than replacing it", async () => {
    const kv = memoryKV({ [KEK_KEY]: "not-a-key" });
    const rnd = countingRandom();

    expect(refusalOf(await ensureKek(kv, rnd.hex)).say).toBe("kekUnreadable");

    // Nothing was minted and nothing was overwritten: the unopenable-forever outcome is what the
    // refusal exists to prevent, so "the slot still holds what it held" is the real assertion.
    expect(rnd.calls()).toBe(0);
    expect(kv.store.get(KEK_KEY)).toBe("not-a-key");
  });

  it("never puts the stored value into the refusal it returns, or into either sentence", async () => {
    // A recognisable secret rather than "not-a-key", so a value that echoes any part of it is
    // caught. 64 characters, so it fails the hex test while looking like a key.
    const secret = "SECRET-VALUE-THAT-MUST-NOT-BE-LOGGED".padEnd(64, "!");
    const kv = memoryKV({ [KEK_KEY]: secret });

    const reason = refusalOf(await ensureKek(kv, countingRandom().hex));

    /* THE WHOLE VERDICT and BOTH RENDERINGS, because the refusal is a value that gets carried and
       then formatted: a key with no arguments has nowhere to put the slot's contents, and reading
       only one of the three would leave the other two unchecked. */
    let text = JSON.stringify(reason);
    try {
      resetLocaleRegisterForTests();
      text += ` ${sayRefusal(reason)}`;
      setActiveLocale("de");
      text += ` ${sayRefusal(reason)}`;
    } finally {
      resetLocaleRegisterForTests();
    }
    expect(reason.args).toBeUndefined();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("SECRET-VALUE");
    // Not even a fragment: a sentence quoting the first bytes of a key is still one quoting a key.
    expect(text).not.toContain(secret.slice(0, 8));
  });

  it("REFUSES rather than throwing, and the refusal reads in the reader's own language", async () => {
    /*
     * THE CONTROL FOR THIS FIX. Three sites here threw English `Error`s and `refusal.test.ts`
     * refused all three: an engine throw reaches a reader through `faultDetail`, which classifies
     * anything that is not ours as somebody else's words and quotes it verbatim — so the sentence
     * a German reader met was English, permanently. The failure is a value carrying a deck key now.
     */
    const kv = memoryKV({ [KEK_KEY]: "not-a-key" });

    const outcome = await ensureKek(kv, countingRandom().hex).then((v) => v, (e: unknown) => e);
    /* Watched red before the fix: the module threw here, and this line read
       "expected Error to not be an instance of Error". */
    expect(outcome, "ensureKek threw where it must refuse").not.toBeInstanceOf(Error);

    const reason = refusalOf(outcome as KekVerdict);
    // A KEY, and NO arguments: nothing from the slot can travel with it.
    expect(reason).toEqual({ say: "kekUnreadable" });

    try {
      resetLocaleRegisterForTests();
      expect(sayRefusal(reason)).toBe(EN.kekUnreadable);
      setActiveLocale("de");
      const german = sayRefusal(reason);
      expect(german, "the refusal did not follow the language switch").toBe(DE.kekUnreadable);
      expect(german).not.toBe(EN.kekUnreadable);
      for (const said of [EN.kekUnreadable, german]) {
        expect(said).not.toMatch(/undefined|\[object Object\]/);
        // The claim the ruling requires it to carry: the mailbox on the server is the master and
        // is untouched, so what is lost is this phone's copy and not anybody's mail.
        expect(said.toLowerCase(), "the refusal does not say what happened to the mail")
          .toContain("server");
      }
    } finally {
      resetLocaleRegisterForTests();
    }
  });

  it("refuses when a freshly written key does not read back", async () => {
    // The mint happens, the write is accepted, and the READ-BACK answers absent — a keystore that
    // took the write and did not keep it. Without the read-back this launch would seal the mailbox
    // password under a key the next launch cannot find, and nothing would report a problem now:
    // the symptom arrives on a later launch as a mailbox asking for its password again.
    const kv = memoryKV(undefined, { value: null });

    expect(refusalOf(await ensureKek(kv, countingRandom().hex)).say).toBe("kekNotKept");

    // The write DID happen — this is not "the store refused", it is "the store lied".
    expect(kv.writes).toEqual([GOOD]);
  });

  it("refuses when the key that reads back is not the key that was written", async () => {
    // The other half of the same failure, and the more dangerous one: a value comes back, it is a
    // perfectly valid key, and it is not ours. Returning it would have this launch seal under a
    // key it never generated.
    const kv = memoryKV(undefined, { value: OTHER });

    expect(refusalOf(await ensureKek(kv, countingRandom().hex)).say).toBe("kekNotKept");
  });

  it("refuses a random source that does not produce a key, and stores nothing", async () => {
    const kv = memoryKV();

    expect(refusalOf(await ensureKek(kv, async () => "short")).say).toBe("kekNotGenerated");

    // The distinction the message draws is worth an assertion: nothing reached the keystore, so
    // the fix is in the random source and not in a half-written slot.
    expect(kv.store.has(KEK_KEY)).toBe(false);
    expect(kv.writes).toEqual([]);
  });

  it("gives two callers in one tick ONE key, and writes it once", async () => {
    const kv = memoryKV();
    // Two DIFFERENT values, so a second mint is visible in the result rather than hidden behind
    // two callers agreeing by luck.
    let n = 0;
    const random = async (): Promise<string> => {
      n += 1;
      return n === 1 ? GOOD : OTHER;
    };

    const [a, b] = await Promise.all([ensureKek(kv, random), ensureKek(kv, random)]);

    // ── ASSERT THE WRITES, NOT A FLAG ───────────────────────────────────────────────────────
    // With the mutation chain removed from `kek.ts` both callers read absent, both mint, and both
    // write: `writes` is `[GOOD, OTHER]`, the two callers disagree, and whichever one sealed a
    // credential first has sealed it under a key the store no longer holds. Watched: deleting
    // `serialize` reddens the length assertion first.
    expect(kv.writes).toEqual([GOOD]);
    expect(a).toEqual({ kind: "key", hex: GOOD });
    expect(b).toEqual({ kind: "key", hex: GOOD });
    expect(n).toBe(1);
  });

  it("hands the engine a one-version ring in the desktop's shape", () => {
    expect(kekRing(GOOD)).toEqual({ 1: GOOD });
    // The contract the desktop's `keksFromEnv` validates: version 1 exists and is contiguous
    // from 1, which a single entry satisfies by construction.
    expect(Object.keys(kekRing(GOOD))).toEqual(["1"]);
    expect(GOOD.length).toBe(KEK_BYTES * 2);
  });

  it("removes the key for the door's take-back", async () => {
    const kv = memoryKV({ [KEK_KEY]: GOOD });
    await forgetKek(kv);
    expect(kv.store.has(KEK_KEY)).toBe(false);
    // And a launch after the take-back is an ordinary first launch, not a refusal.
    expect(await ensureKek(kv, countingRandom(OTHER).hex)).toEqual({ kind: "key", hex: OTHER });
  });
});
