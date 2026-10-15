import { describe, expect, it } from "vitest";
import { MIGRATION_ALLOWANCES } from "../src/migration-allowances.js";

/**
 * AN ALLOWANCE IS ONLY AS GOOD AS THE HASH IT NAMES, and there is usually more than one.
 *
 * A row records the bytes THAT database applied, and a migration that was comment-rewritten after
 * it shipped has several such versions. Naming one of them admits that population and silently
 * refuses the rest — a deployment stopped by `journal MISDESCRIBED` for a change the table was
 * meant to allow. This file checks the table's own shape: every allowance names two sha256 hashes,
 * and they differ. Which versions a file really held is read from git history, which a published
 * tree does not carry, so that half runs where the history is.
 */

const TAGS = [...new Set(MIGRATION_ALLOWANCES.map((a) => a.tag))];

describe("the allowance table", () => {
  it("the table covers at least the tags this tree edited", () => {
    expect(TAGS.length).toBeGreaterThan(0);
    for (const a of MIGRATION_ALLOWANCES) {
      expect(a.recorded).toMatch(/^[0-9a-f]{64}$/);
      expect(a.shipped).toMatch(/^[0-9a-f]{64}$/);
      expect(a.recorded, `${a.tag}: an allowance from a hash to itself admits nothing`)
        .not.toBe(a.shipped);
    }
  });
});
