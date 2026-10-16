import { sql, type SQL } from "drizzle-orm";

/**
 * A COMPLETE structural fingerprint of a Postgres schema, ordered deterministically so two
 * databases can be compared line-for-line.
 *
 * This exists because the two-journal split (stage 3) has exactly one proof that it was
 * faithful: migrate the OLD single journal into one database, the TWO new journals into
 * another, and diff everything the catalog knows. Nothing cheaper can see it. A `(table,
 * column)` probe — which is what `SCHEMA_MARKERS` and baseline adoption use, correctly, for
 * their own purposes — is blind to indexes, unique constraints, foreign keys, CHECK
 * constraints, triggers, functions and generated columns. Those are precisely where this
 * schema keeps its invariants: `credit_ledger_source_uq` IS the ledger's dedup identity,
 * `billing_sub_one_live_idx` IS "at most one live subscription", and the `credit_*_coupled`
 * constraint triggers ARE the guarantee that the money record and the balance agree.
 *
 * Lose one of those in the statement surgery and every database created from that point
 * forward is missing an invariant while production — which ran the original journal — still
 * has it. Production and fresh diverge permanently, silently, and the money-safety story is
 * gone. So the diff is over the whole catalog, and `journal-split.pg.test.ts` proves it can
 * still fail.
 *
 * Deliberately NOT `pg_dump -s`: this repository has no `pg_dump` on the path, the output
 * order is not guaranteed stable across versions, and a text dump interleaves DDL in a way
 * that makes a one-line difference hard to attribute. One sorted line per object attributes
 * itself.
 */

/** Minimal structural SQL runner, mirroring `search-setup.ts` — no schema-type coupling. */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

async function rows<T>(db: SqlExecutor, query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/**
 * Every catalog object in `public`, one line each, sorted.
 *
 * `pg_trgm`'s own functions and operator classes are EXCLUDED. `ensureSearchExtensions` is
 * deliberately outside the migrator (a `CREATE EXTENSION` would throw in PGlite and take the
 * whole unit suite red — see `search-setup.ts`), so whether the extension is installed is a
 * property of the *provisioning path*, not of the journal. Including it would make this diff
 * depend on which database happened to have had `search.pg.test.ts` run against it.
 */
export async function catalogFingerprint(db: SqlExecutor): Promise<string[]> {
  const out: string[] = [];

  const cols = await rows<{
    table_name: string; ordinal_position: number; column_name: string; udt_name: string;
    is_nullable: string; column_default: string | null; is_generated: string;
    generation_expression: string | null; character_maximum_length: number | null;
    numeric_precision: number | null; numeric_scale: number | null;
  }>(db, sql`
    select c.table_name, c.ordinal_position, c.column_name, c.udt_name, c.is_nullable,
           c.column_default, c.is_generated, c.generation_expression,
           c.character_maximum_length, c.numeric_precision, c.numeric_scale
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
     order by c.table_name, c.ordinal_position`);
  for (const c of cols) {
    out.push(
      `COLUMN ${c.table_name}.${c.ordinal_position} ${c.column_name} ${c.udt_name} ` +
      `null=${c.is_nullable} default=${c.column_default ?? "-"} gen=${c.is_generated} ` +
      `genexpr=${c.generation_expression ?? "-"} len=${c.character_maximum_length ?? "-"} ` +
      `prec=${c.numeric_precision ?? "-"}/${c.numeric_scale ?? "-"}`,
    );
  }

  // Constraint DEFINITIONS, plus deferrability — the `credit_*_coupled` triggers are
  // DEFERRABLE INITIALLY DEFERRED and a copy that lost that would check at the wrong time.
  const cons = await rows<{
    tbl: string; conname: string; def: string; contype: string;
    condeferrable: boolean; condeferred: boolean;
  }>(db, sql`
    select t.relname as tbl, c.conname, pg_get_constraintdef(c.oid) as def, c.contype,
           c.condeferrable, c.condeferred
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
     order by t.relname, c.conname`);
  for (const c of cons) {
    out.push(
      `CONSTRAINT ${c.tbl} ${c.conname} [${c.contype}] deferrable=${c.condeferrable} ` +
      `deferred=${c.condeferred} :: ${c.def}`,
    );
  }

  const idx = await rows<{ tablename: string; indexname: string; indexdef: string }>(
    db, sql`select tablename, indexname, indexdef from pg_indexes
              where schemaname = 'public' order by tablename, indexname`);
  for (const i of idx) out.push(`INDEX ${i.tablename} ${i.indexname} :: ${i.indexdef}`);

  const trg = await rows<{
    tbl: string; tgname: string; def: string; tgenabled: string;
    tgdeferrable: boolean; tginitdeferred: boolean; is_constraint: boolean;
  }>(db, sql`
    select t.relname as tbl, g.tgname, pg_get_triggerdef(g.oid) as def, g.tgenabled,
           g.tgdeferrable, g.tginitdeferred, g.tgconstraint <> 0 as is_constraint
      from pg_trigger g
      join pg_class t on t.oid = g.tgrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and not g.tgisinternal
     order by t.relname, g.tgname`);
  for (const t of trg) {
    out.push(
      `TRIGGER ${t.tbl} ${t.tgname} enabled=${t.tgenabled} deferrable=${t.tgdeferrable} ` +
      `initdeferred=${t.tginitdeferred} constraint=${t.is_constraint} :: ${t.def}`,
    );
  }

  // Functions the MIGRATIONS create. C-language functions are excluded BY LANGUAGE rather
  // than by name, so `pg_trgm` — and any future extension — cannot quietly start appearing
  // in this diff and make it depend on which database had `search.pg.test.ts` run against it.
  const fns = await rows<{ proname: string; def: string }>(db, sql`
    select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where n.nspname = 'public' and p.prokind = 'f' and l.lanname <> 'c'
     order by p.proname`);
  for (const f of fns) out.push(`FUNCTION ${f.proname} :: ${f.def.replace(/\s+/g, " ").trim()}`);

  const seq = await rows<{
    sequence_name: string; data_type: string; start_value: string; increment: string;
  }>(db, sql`select sequence_name, data_type, start_value, increment
               from information_schema.sequences
              where sequence_schema = 'public' order by sequence_name`);
  for (const s of seq) {
    out.push(`SEQUENCE ${s.sequence_name} ${s.data_type} start=${s.start_value} inc=${s.increment}`);
  }

  return out;
}
