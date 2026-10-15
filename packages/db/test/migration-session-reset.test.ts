import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A MIGRATION SESSION HANDS ITS BACKEND BACK WITH THE ROLE'S CEILINGS. The sessions lift
 * statement_timeout, lock_timeout and idle_in_transaction_session_timeout with a session SET, and
 * a session pooler gives the backend to its next client with those settings intact. A recording
 * fake stands in for postgres.js, so the ORDER is what is read: the three RESETs come after every
 * SET and immediately before the close, on the success path and on runMigrations' throw path.
 */
const h = vi.hoisted(() => {
  const calls: string[] = [];
  const state: { failOn: RegExp | null; onclose: (() => void) | undefined } = { failOn: null, onclose: undefined };
  function fakePostgres(_url: string, opts: { onclose?: () => void }) {
    state.onclose = opts.onclose;
    const run = (text: string): Promise<unknown[]> => {
      calls.push(text);
      if (state.failOn?.test(text)) return Promise.reject(Object.assign(new Error("refused by the fake"), { code: "FAKE_REFUSAL" }));
      return Promise.resolve([]);
    };
    const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> =>
      run(strings.reduce((a, s, i) => a + s + (i < values.length ? `$${i + 1}` : ""), ""));
    return Object.assign(tag, {
      unsafe: (text: string) => run(text),
      end: async (o?: { timeout?: number }) => { calls.push(`END timeout=${o?.timeout}`); },
    });
  }
  return { calls, state, fakePostgres };
});
vi.mock("postgres", () => ({ default: h.fakePostgres }));

const { openMigrationSession, runMigrations } = await import("../src/migrate.js");
const URL = "postgres://u:p@127.0.0.1:5432/db";
const RESETS = ["reset statement_timeout", "reset lock_timeout", "reset idle_in_transaction_session_timeout"];

beforeEach(() => { h.calls.length = 0; h.state.failOn = null; h.state.onclose = undefined; });

describe("a migration session resets its ceilings before it closes", () => {
  it("the success path: every SET, then the three RESETs, then the close", async () => {
    const session = await openMigrationSession(URL);
    await session.sql.unsafe("set statement_timeout = 0");
    await session.sql.unsafe("set lock_timeout = 0");
    await session.end();
    expect(h.calls.slice(-4)).toEqual([...RESETS, "END timeout=5"]);
    const lastSet = h.calls.map((c) => c.startsWith("set ")).lastIndexOf(true);
    expect(lastSet).toBeLessThan(h.calls.indexOf(RESETS[0]!));
  });

  it("runMigrations' throw path: the lock refusal still ends on the three RESETs and the close", async () => {
    h.state.failOn = /pg_advisory_lock/;
    await expect(runMigrations(URL)).rejects.toThrow(/could not take the migration advisory lock/);
    expect(h.calls.filter((c) => c.startsWith("set ")).length).toBe(3);
    expect(h.calls.slice(-4)).toEqual([...RESETS, "END timeout=5"]);
  });

  it("a lost session resets nothing and closes at once", async () => {
    const session = await openMigrationSession(URL);
    h.state.onclose!();
    expect(session.lost()).not.toBeNull();
    await session.end();
    expect(h.calls.filter((c) => c.startsWith("reset "))).toEqual([]);
    expect(h.calls.at(-1)).toBe("END timeout=0");
  });

  it("a RESET that fails is logged by its class, the other two still run, and the session closes", async () => {
    h.state.failOn = /^reset lock_timeout$/;
    const lines: string[] = [];
    const session = await openMigrationSession(URL, { log: (m) => lines.push(m) });
    await session.end();
    expect(h.calls.slice(-4)).toEqual([...RESETS, "END timeout=5"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/could not reset lock_timeout .*\(FAKE_REFUSAL\)/);
  });
});
