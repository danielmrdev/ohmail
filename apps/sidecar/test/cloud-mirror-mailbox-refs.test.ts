import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAILBOX_REFERENCE_TABLES } from "../src/cloud-mirror.js";

/**
 * THE RETIRED-MAILBOX GUARD'S TABLE LIST IS THE MIGRATIONS', NOT SOMEBODY'S MEMORY OF IT.
 *
 * `dropRetiredMailboxes` deletes a retired `mailboxes` row only when nothing references it, and it
 * runs INSIDE the refresh transaction — a key it fails to probe aborts every tick, not one row.
 * The list said "seven tables" while mail 0118 had made it eleven: its four new keys are declared
 * in SQL alone, so neither a reader of `schema-mail.ts` nor a census reading `references(() => …)`
 * could see them. This one reads the migrations.
 */

const SOURCE = fileURLToPath(new URL("../src/cloud-mirror.ts", import.meta.url));
const DRIZZLE = fileURLToPath(new URL("../../../packages/db-mail/drizzle", import.meta.url));
const SCHEMA = fileURLToPath(new URL("../../../packages/db/src/schema-mail.ts", import.meta.url));

/** Every table a live migration key points at `mailboxes`, replayed with DROPs honoured. */
function tablesKeyedToMailboxes(): string[] {
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const live = new Map<string, [string, string]>();
  for (const entry of journal.entries) {
    // Split on the breakpoint BEFORE stripping comments — it is itself a `--` line.
    const stmts = readFileSync(join(DRIZZLE, `${entry.tag}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.replace(/^\s*--[^\n]*$/gm, ""));
    for (const s of stmts) {
      const drop = /ALTER TABLE "([a-z_]+)"\s+DROP CONSTRAINT (?:IF EXISTS )?"([a-z_]+)"/i.exec(s);
      if (drop) { live.delete(drop[2]!); continue; }
      const child = (/ALTER TABLE "([a-z_]+)"/i.exec(s) ?? /CREATE TABLE (?:IF NOT EXISTS )?"([a-z_]+)"/i.exec(s))?.[1];
      if (!child) continue;
      for (const m of s.matchAll(
        /CONSTRAINT "([a-z_]+)"\s+FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s+(?:"public"\.)?"([a-z_]+)"/gi,
      )) {
        live.set(m[1]!, [child, m[2]!]);
      }
    }
  }
  const hits = new Set<string>();
  for (const [child, parent] of live.values()) if (parent === "mailboxes") hits.add(child);
  return [...hits].sort();
}

describe("the retired-mailbox guard probes every key the migrations declare", () => {
  it("the probe list is exactly the migrations' set", () => {
    const derived = tablesKeyedToMailboxes();
    // The vacuity guard: a regex that stopped matching would compare two empty sets.
    expect(derived.length, "the SQL walk found no keys — this census is reading nothing")
      .toBeGreaterThan(8);
    expect([...MAILBOX_REFERENCE_TABLES].sort(), "the guard's list and the migrations disagree")
      .toEqual(derived);
  });

  it("and every name on the list is actually PROBED, not merely listed", () => {
    /* A list beside a hand-written chain of queries drifts the moment somebody adds one to the
       list and forgets the query. So the calls are parsed: each `.from(<ident>)` in the source is
       mapped to its SQL name through `schema-mail.ts`'s own `pgTable("<name>")` declarations. */
    const src = readFileSync(SOURCE, "utf8");
    const body = src.slice(src.indexOf("async function mailboxReferenced"));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    const sqlNameOf = new Map(
      [...readFileSync(SCHEMA, "utf8").matchAll(/export const (\w+) = pgTable\(\s*"([\w_]+)"/g)]
        .map((m) => [m[1]!, m[2]!] as const),
    );
    const probed = new Set<string>();
    for (const m of fn.matchAll(/\.from\((\w+)\)/g)) {
      const name = sqlNameOf.get(m[1]!);
      if (name) probed.add(name);
    }
    // Low on purpose: this guards against a regex that parsed NOTHING. A threshold near the real
    // count would make a shrunken list fail here instead of on the comparison below, which is a
    // case failing for the wrong reason — measured doing exactly that.
    expect(probed.size, "no `.from(…)` calls parsed — this case is vacuous").toBeGreaterThan(3);
    expect([...probed].sort(), "listed but never probed, or probed but never listed")
      .toEqual([...MAILBOX_REFERENCE_TABLES].sort());
  });
});
