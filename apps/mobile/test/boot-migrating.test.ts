/**
 * A LONG STORE UPGRADE ON A RELAUNCH COUNTS ITSELF ON THE PHONE (FIX-026 row 95). The desktop's
 * window said "Updating your local mail store… (3 of 12)" and the phone's boot shell said nothing
 * at all over the same pass. Rules: the count only where more than one entry is owed on a store
 * that is not fresh, "3 of 12" being THIS open's owed entries, the slow line after five seconds,
 * and nothing of it surviving into the refusal a failed upgrade ends in. Mutations: `pending <= 1`
 * → `< 1`, the `fresh` arm dropped, `migratingState`'s connecting check dropped.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BOOT_MIGRATING_SLOW_MS, bootMigratingLines, migratingNext, migratingState } from "../src/ui/boot-migrating";
import { gateFor } from "../src/state/gate";
import { refuse } from "../src/refusal";
import { setActiveLocale } from "../src/i18n/locale";
import { DECKS } from "../src/copy";

afterEach(() => { setActiveLocale("en"); });

describe("the boot shell's upgrade line", () => {
  const upgrade = { applied: 3, pending: 12, fresh: false, since: 1_000 };

  it("counts this open's owed entries, in both languages", () => {
    setActiveLocale("en");
    expect(bootMigratingLines(upgrade, 1_000).count).toBe(DECKS.en.bootMigratingOf(3, 12));
    expect(DECKS.en.bootMigratingOf(3, 12)).toContain("(3 of 12)");
    setActiveLocale("de");
    expect(bootMigratingLines(upgrade, 1_000).count).toBe(DECKS.de.bootMigratingOf(3, 12));
    expect(DECKS.de.bootMigratingOf(3, 12)).toContain("(3 von 12)");
  });

  it("says nothing for a first launch, one owed entry, or no upgrade at all", () => {
    expect(bootMigratingLines({ ...upgrade, fresh: true }, 1_000)).toEqual({ count: null, slow: null });
    expect(bootMigratingLines({ ...upgrade, pending: 1, applied: 0 }, 1_000)).toEqual({ count: null, slow: null });
    expect(bootMigratingLines(undefined, 1_000)).toEqual({ count: null, slow: null });
    expect(bootMigratingLines({ ...upgrade, pending: 2, applied: 0 }, 1_000).count, "control: two owed are counted")
      .not.toBeNull();
  });

  it("adds the slow line only once the phase has lasted five seconds", () => {
    setActiveLocale("en");
    expect(bootMigratingLines(upgrade, 1_000 + BOOT_MIGRATING_SLOW_MS - 1).slow).toBeNull();
    expect(bootMigratingLines(upgrade, 1_000 + BOOT_MIGRATING_SLOW_MS).slow).toBe(DECKS.en.bootMigratingSlow);
  });
});

describe("where an announcement may land", () => {
  const progress = { applied: 0, pending: 4, fresh: false };

  it("on the connecting state of this connect, the phase stamped by the first announcement", () => {
    const first = migratingState({ k: "connecting", origin: "local" }, "local", progress, 5_000);
    expect(first).toEqual({ k: "connecting", origin: "local", migrating: { ...progress, since: 5_000 } });
    const later = migratingState(first!, "local", { ...progress, applied: 2 }, 9_000);
    expect(later?.migrating).toEqual({ applied: 2, pending: 4, fresh: false, since: 5_000 });
    expect(migratingNext(undefined, progress, 7).since).toBe(7);
  });

  it("never on a state that moved on — a refusal keeps no count", () => {
    expect(migratingState({ k: "refused" }, "local", progress, 1)).toBeNull();
    expect(migratingState({ k: "live" }, "local", progress, 1)).toBeNull();
    expect(migratingState({ k: "connecting", origin: "http://10.0.0.2:4180" }, "local", progress, 1)).toBeNull();
  });

  it("the gate hands the count to the boot shell, and a refusal to Servers with none", () => {
    const migrating = { applied: 1, pending: 3, fresh: false, since: 1 };
    expect(gateFor({ k: "connecting", origin: "local", migrating }, 1)).toEqual({ to: "connecting", origin: "local", migrating });
    expect(gateFor({ k: "connecting", origin: "local" }, 1)).toEqual({ to: "connecting", origin: "local" });
    expect(gateFor({ k: "refused", reason: refuse("notPairedHere") }, 1)).toEqual({ to: "servers" });
  });
});
