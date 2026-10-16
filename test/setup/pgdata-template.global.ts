/**
 * WARM THE TWO TEMPLATES, ONCE PER RUN, OUTSIDE EVERY TEST BUDGET: the sidecar's migrated PGDATA
 * (`apps/sidecar/test/_datadir.ts`, ten seconds of `initdb`) and `makeTestDb`'s tarball
 * (`packages/db/src/testing-template.ts`). Built lazily, either lands inside whichever test asks
 * first, against vitest's 5 s default, and fails a correct test on the clock.
 *
 * IT NEVER DECIDES WHETHER THE SUITE CAN RUN: a warm-up that fails is REPORTED, and each fixture's
 * own lazy path — for `makeTestDb`, verified on load and refused by name — stays the guarantee.
 */
export async function setup(): Promise<void> {
  if (process.env.OHMAIL_PGDATA_TEMPLATE !== "0") {
    try {
      const { warmPgdataTemplate } = await import("../../apps/sidecar/test/_datadir.js");
      await warmPgdataTemplate();
    } catch (e) {
      process.stderr.write(
        `[pgdata-template] warm-up did not run (${e instanceof Error ? e.message : String(e)}); `
          + "the sidecar fixture will build the template on first use instead\n");
    }
  }
  try {
    const { templateDisabled, warmPgliteTemplate } = await import("../../packages/db/src/testing-template.js");
    if (!templateDisabled()) await warmPgliteTemplate();
  } catch (e) {
    process.stderr.write(
      `[pglite-template] warm-up did not run (${e instanceof Error ? e.message : String(e)}); `
        + "makeTestDb will build and verify the template on first use instead\n");
  }
}
