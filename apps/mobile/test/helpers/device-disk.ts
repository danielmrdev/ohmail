/**
 * A PHONE'S DISK, AS THE PHONE WRITES IT — `node:sqlite` behind the expo-shaped handle the app's
 * own serial lane (`src/engine/sql-queue.ts`) drives, one statement per turn, so a write waits
 * behind whatever the lane already holds. The controls a kill test needs: `slow()` holds every
 * statement (a lane busy with a drain's page), `step()` lets one through, `release()` ends it, and
 * `kill()` is a process death — an open transaction rolls back and nothing the dead process asks
 * is ever done or answered. The next launch opens the same files through a fresh lane.
 */
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { SqlExecutor, SqlValue } from "@ohmail/client-engine";
import type { ExclusiveTxnDatabase } from "../../src/engine/sql-queue";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const turn = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

export function deviceDisk() {
  const files = new Map<string, DatabaseSync>();
  let life = { dead: false, open: new Set<DatabaseSync>() };
  let slowed = false;
  let permits = 0;
  let waiting: Array<() => void> = [];
  const wake = (): void => { const w = waiting; waiting = []; for (const r of w) r(); };
  const admit = async (): Promise<void> => {
    while (slowed && permits === 0) await new Promise<void>((r) => waiting.push(r));
    if (slowed) permits -= 1;
  };

  const handle = (name: string): ExclusiveTxnDatabase => {
    let db = files.get(name);
    if (!db) { db = new sqlite.DatabaseSync(":memory:"); files.set(name, db); }
    const file = db;
    const mine = life;
    const step = async <T>(run: () => T): Promise<T> => {
      await turn();
      await admit();
      if (mine.dead) return never<T>();
      return run();
    };
    return {
      databasePath: name,
      getAllAsync: <T>(sql: string, params: readonly SqlValue[]) =>
        step(() => file.prepare(sql).all(...params) as T[]),
      runAsync: (sql: string, params: readonly SqlValue[]) => step(() => {
        const out = file.prepare(sql).run(...params);
        if (/^\s*BEGIN/i.test(sql)) mine.open.add(file);
        if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) mine.open.delete(file);
        return out;
      }),
      closeAsync: () => step(() => undefined),
    };
  };

  return {
    /** The opener a launch hands `bootEngine` — the app's serial lane over this disk. */
    opener: (serial: (db: ExclusiveTxnDatabase) => SqlExecutor) => ({
      open: (name: string): SqlExecutor => serial(handle(name)),
      drop: async (name: string): Promise<void> => { files.delete(name); },
    }),
    /** Every statement from here waits: the lane is busy. */
    slow: (): void => { slowed = true; permits = 0; },
    /** One statement through. */
    step: (): void => { permits += 1; wake(); },
    release: (): void => { slowed = false; wake(); },
    /** The process dies: its open transactions roll back and it is never answered again. */
    kill: (): void => {
      for (const db of life.open) db.exec("ROLLBACK");
      life.dead = true;
      life = { dead: false, open: new Set() };
      slowed = false;
      wake();
    },
    /** What the file holds, read outside any process — the kill's evidence. */
    rows: (name: string, like: string): number => {
      const db = files.get(name);
      if (!db) return 0;
      const r = db.prepare("SELECT count(*) AS n FROM entities WHERE key LIKE ?").get(like) as { n: number };
      return r.n;
    },
    names: (): string[] => [...files.keys()],
  };
}
