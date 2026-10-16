import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { WIPED_TABLES } from "../src/local-mirror.js";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import {
  KEEP, mailGraph, mailboxDomain, parseSchema, tablesTheRemovalOwes, type SchemaGraph,
} from "./_mailbox-rows.js";

/**
 * THE REMOVAL'S TABLE LIST IS THE SCHEMA'S, NOT SOMEBODY'S MEMORY OF IT.
 *
 * `deleteMailboxRows` is the one walk both doors run — the standalone removal and the Cloud
 * mirror's erased-mailbox receipt. Every table the schema ties to a mailbox (`_mailbox-rows.ts`)
 * is in {@link WIPED_TABLES} or in `KEEP` with its reason, and a table added without either is
 * red here by name. Watched failing: cut `threads` from the list and the first case names it.
 */

const WALK = withoutComments(readFileSync(
  fileURLToPath(new URL("../src/local-mirror.ts", import.meta.url)), "utf8",
));
const SCHEMA = readFileSync(
  fileURLToPath(new URL("../../../packages/db/src/schema-mail.ts", import.meta.url)), "utf8",
);

/** Export name → SQL name, so the walk's `db.delete(threadNotes)` reads as `thread_notes`. */
const SQL_NAME = new Map(
  [...SCHEMA.matchAll(/^export const (\w+) = pgTable\(\s*"([\w_]+)"/gm)].map((m) => [m[1]!, m[2]!]),
);

/** The tables `local-mirror.ts` actually deletes from, read off its statements. */
function deletedByTheWalk(): Set<string> {
  const out = new Set<string>();
  for (const m of WALK.matchAll(/\bdb\.delete\(\s*(\w+)\s*\)/g)) out.add(SQL_NAME.get(m[1]!) ?? m[1]!);
  return out;
}

/** What a graph owes that a list does not delete — the census's one question. */
function unplaced(g: SchemaGraph, keep: Record<string, string>, swept: readonly string[]): string[] {
  const k = new Set(Object.keys(keep));
  const listed = new Set(swept);
  return [...mailboxDomain(g, k)].filter((t) => !k.has(t) && !listed.has(t)).sort();
}

describe("the removal walk clears every table the schema ties to a mailbox", () => {
  it("looked — the schema parsed, and the domain holds the tables a reader can see", () => {
    const g = mailGraph();
    expect(g.tables.size, "the pgTable walk found nothing").toBeGreaterThan(40);
    expect(g.edges.length, "no foreign key was read").toBeGreaterThan(40);
    expect(tablesTheRemovalOwes()).toEqual(expect.arrayContaining([
      "messages", "message_bodies", "drafts", "mailbox_folders", "threads", "thread_notes",
    ]));
  });

  it("EVERY table in the mailbox's domain is swept, or kept with a reason", () => {
    expect(
      unplaced(mailGraph(), KEEP, WIPED_TABLES),
      "these tables hold one mailbox's rows and the removal leaves them on disk — add them to "
        + "`deleteMailboxRows` and WIPED_TABLES, or to KEEP in `_mailbox-rows.ts` with the reason",
    ).toEqual([]);
  });

  it("and the walk deletes nothing outside that domain", () => {
    const owed = new Set(tablesTheRemovalOwes());
    expect(WIPED_TABLES.filter((t) => !owed.has(t)), "the walk reaches past the mailbox").toEqual([]);
  });

  it("the list IS the code — every listed table has its delete, and every delete is listed", () => {
    expect([...deletedByTheWalk()].sort()).toEqual([...WIPED_TABLES].sort());
  });

  it("the list has no duplicates, and messages is LAST (nothing cascades to it)", () => {
    expect([...new Set(WIPED_TABLES)]).toEqual([...WIPED_TABLES]);
    expect(WIPED_TABLES[WIPED_TABLES.length - 1]).toBe("messages");
  });

  it("every KEEP entry names a real table and says why", () => {
    const g = mailGraph();
    expect(Object.keys(KEEP).filter((t) => !g.tables.has(t)), "KEEP names a table the schema lost")
      .toEqual([]);
    expect(Object.entries(KEEP).filter(([, why]) => why.trim().length < 20).map(([t]) => t))
      .toEqual([]);
  });

  it("refuses a PLANTED table nobody placed — the census's own positive control", () => {
    /* Three plants through the real parser: one keyed by `mailbox_id`, one reached only by a
       foreign key to `threads`, one hanging off a KEPT table. The first two are owed; the third
       is the account's, because a kept table ends the walk. Then the two ways out. */
    const planted = parseSchema([
      `export const invented = pgTable("invented_rows", {`,
      `  mailboxId: uuid("mailbox_id").notNull(),`,
      `});`,
      `export const reactions = pgTable("thread_reactions", {`,
      `  threadId: uuid("thread_id").references(() => threads.id),`,
      `});`,
      `export const ruleNotes = pgTable("rule_notes", {`,
      `  ruleId: uuid("rule_id").references(() => rules.id),`,
      `});`,
    ].join("\n"));
    expect([...planted.tables].sort(), "the plant did not parse").toEqual(
      ["invented_rows", "rule_notes", "thread_reactions"],
    );
    const real = mailGraph();
    const g: SchemaGraph = {
      tables: new Set([...real.tables, ...planted.tables]),
      mailboxKeyed: new Set([...real.mailboxKeyed, ...planted.mailboxKeyed]),
      edges: [...real.edges, ...planted.edges],
    };
    expect(unplaced(g, KEEP, WIPED_TABLES)).toEqual(["invented_rows", "thread_reactions"]);
    expect(unplaced(g, KEEP, [...WIPED_TABLES, "invented_rows", "thread_reactions"])).toEqual([]);
    expect(unplaced(g, { ...KEEP, invented_rows: "a fixture for this control and nothing else" },
      [...WIPED_TABLES, "thread_reactions"])).toEqual([]);
  });
});
