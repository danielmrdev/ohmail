import { describe, expect, it } from "vitest";
import { normalizeSql } from "../src/sql-normalize.js";

/**
 * THE SCANNER THAT DECIDES WHETHER TWO MIGRATIONS ARE THE SAME PROGRAM.
 *
 * `setup-prod.ts` compares the SQL a database recorded as applied against the SQL this tree
 * ships, and it may only ignore what a database cannot see: comments and layout. Everything the
 * server executes — including drizzle's statement separator, which looks like a comment and is
 * not — has to survive, or a real difference is admitted as a comment rewrite.
 */
describe("normalizeSql keeps the program and drops the prose", () => {
  it("blanks line and block comments without fusing the tokens around them", () => {
    expect(normalizeSql("select 1 -- a comment\nfrom t")).toBe("select 1 from t");
    expect(normalizeSql("select/* mid */1")).toBe("select 1");
    expect(normalizeSql("select 1;\n\n\n  from t")).toBe("select 1; from t");
  });

  it("block comments NEST, as Postgres reads them", () => {
    expect(normalizeSql("a /* one /* two */ still */ b")).toBe("a b");
  });

  /** The mutation named in the brief: treat `--` inside a literal as a comment and this breaks. */
  it("a `--` inside a string literal is DATA, not a comment", () => {
    expect(normalizeSql("insert into t values ('a -- b')")).toBe("insert into t values ('a -- b')");
    expect(normalizeSql("select 'x' -- real comment\n, 'y -- not one'")).toBe(
      "select 'x' , 'y -- not one'",
    );
  });

  it("a doubled quote does not end the literal", () => {
    expect(normalizeSql("select 'it''s -- fine' , 1")).toBe("select 'it''s -- fine' , 1");
    expect(normalizeSql('alter table "od""d -- name" add x')).toBe('alter table "od""d -- name" add x');
  });

  it("an E'' string takes backslash escapes", () => {
    expect(normalizeSql("select E'a\\'-- b' , 1")).toBe("select E'a\\'-- b' , 1");
  });

  it("a dollar-quoted body is copied verbatim, whitespace and all", () => {
    const src = "DO $$ BEGIN\n  -- inside\n  raise notice 'x';\nEND $$;";
    expect(normalizeSql(src)).toBe("DO $$ BEGIN\n  -- inside\n  raise notice 'x';\nEND $$;");
    expect(normalizeSql("DO $tag$ a -- b $tag$ ; -- gone")).toBe("DO $tag$ a -- b $tag$ ;");
  });

  /**
   * The two-pass defect, from the source-scan rule: a block-comment OPENER quoted inside a line
   * comment is not a real opener, and a comment regex followed by a whitespace regex deletes from
   * it to the next terminator — thousands of characters of one file, once.
   */
  it("a block-comment opener quoted inside a line comment swallows nothing", () => {
    expect(normalizeSql("select 1; -- see /* here\nselect 2; -- and */ here\nselect 3;")).toBe(
      "select 1; select 2; select 3;",
    );
  });

  it("drizzle's statement separator SURVIVES — it decides which statements share a batch", () => {
    expect(normalizeSql("alter table a add x;\n--> statement-breakpoint\nalter table b add y;")).toBe(
      "alter table a add x; --> statement-breakpoint alter table b add y;",
    );
    const joined = normalizeSql("alter table a add x;\nalter table b add y;");
    expect(joined, "removing the separator must not normalize to the same program").not.toBe(
      normalizeSql("alter table a add x;\n--> statement-breakpoint\nalter table b add y;"),
    );
  });

  /** The ordinary case is ADMITTED: two spellings of one program compare equal. */
  it("a comment rewrite and a re-indent leave the program equal", () => {
    const before = "-- name what this table is called\nCREATE TABLE t (\n  id uuid\n);\n";
    const after = "/* name what this table does */\nCREATE TABLE t ( id uuid );";
    expect(normalizeSql(before)).toBe(normalizeSql(after));
  });

  /**
   * THE LIMIT, STATED RATHER THAN DISCOVERED. Whitespace is COLLAPSED, not removed: `a from b`
   * and `afromb` are different programs, so the scanner cannot drop a run entirely. A reformat
   * that deletes the space before a bracket therefore reads as a difference and REFUSES — the
   * safe direction, and the freeze makes such an edit unreachable on a released file anyway.
   */
  it("a reformat that removes whitespace entirely is NOT admitted", () => {
    expect(normalizeSql("CREATE TABLE t (\n  id uuid\n)")).not.toBe(normalizeSql("CREATE TABLE t (id uuid)"));
  });

  it("a real difference stays different", () => {
    expect(normalizeSql("CREATE TABLE t (id uuid)")).not.toBe(normalizeSql("CREATE TABLE t (id text)"));
  });
});
