import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { ROLE_DEFAULT_TIMEOUTS } from "../src/client.js";

type Sql = ReturnType<typeof postgres>;
export type AdminSql = Sql;

/** An admin session with no client-side deadlines, for callers outside this package (no `postgres` dep). */
export function openAdmin(url: string): Sql {
  return postgres(url, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
}

/**
 * `setupProdDatabase` applies `ROLE_DEFAULT_TIMEOUTS` with a role-wide `ALTER ROLE` on the role it
 * connects as. Run as the shared `tf`, that gave every later pg test on the cluster a 30 s lock and
 * 55 s statement ceiling. So a test that runs it connects as a throwaway SUPERUSER (tf's privilege,
 * a different identity), stamped in its comment so a killed run's leftover can be swept by age.
 */
export interface SetupRole {
  readonly name: string;
  /** `url` with this role's credentials in place of the admin's. */
  urlFor(url: string): string;
  create(admin: Sql): Promise<void>;
  /** Drops the databases this role owns, then the role and its `pg_db_role_setting` rows. */
  drop(admin: Sql): Promise<void>;
}

export const SETUP_ROLE_PREFIX = "ohmail_setup_role_";
export const STALE_ROLE_MS = 60 * 60 * 1000;

const STAMP = /^ohmail-test-role (?:created|first-seen)=(\d+)$/;

export function roleStamp(at: number, kind: "created" | "first-seen" = "created"): string {
  return `ohmail-test-role ${kind}=${at}`;
}

/** The sweep's deciding rule: stale only on a stamp older than `maxAgeMs`; unstamped is stamped, never dropped. */
export function roleAgeVerdict(comment: string | null, now: number, maxAgeMs: number): "stale" | "young" | "unstamped" {
  const m = comment === null ? null : STAMP.exec(comment);
  if (!m) return "unstamped";
  return now - Number(m[1]) > maxAgeMs ? "stale" : "young";
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** `admin` is a one-connection session: the SETs hold for the drops, which a timeout must not half-do. */
async function dropRoleAndItsDatabases(admin: Sql, role: string): Promise<void> {
  await admin.unsafe(`set statement_timeout = 0`);
  await admin.unsafe(`set lock_timeout = 0`);
  const owned = await admin<Array<{ datname: string }>>`
    select d.datname from pg_database d join pg_roles r on r.oid = d.datdba where r.rolname = ${role}`;
  for (const { datname } of owned) await admin.unsafe(`drop database if exists ${quoteIdent(datname)} with (force)`);
  await admin.unsafe(`drop role if exists ${quoteIdent(role)}`);
}

export function setupRole(prefix: string = SETUP_ROLE_PREFIX): SetupRole {
  const name = `${prefix}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const password = randomUUID().replace(/-/g, "");
  return {
    name,
    urlFor(url) {
      const u = new URL(url);
      u.username = name;
      u.password = password;
      return u.toString();
    },
    async create(admin) {
      await admin.unsafe(`create role ${quoteIdent(name)} with login superuser password '${password}'`);
      await admin.unsafe(`comment on role ${quoteIdent(name)} is '${roleStamp(Date.now())}'`);
    },
    async drop(admin) {
      await dropRoleAndItsDatabases(admin, name);
    },
  };
}

export interface SweepResult { dropped: string[]; stamped: string[]; kept: string[]; failed: string[] }

/**
 * Drops `prefix*` roles whose stamp is older than `maxAgeMs`, with the databases they own. A role
 * with no stamp (made by an older tree) is stamped first-seen now and judged by a later run, so a
 * live run's role is never taken. A drop that fails (objects elsewhere) is reported, not thrown.
 */
export async function sweepStaleRoles(
  admin: Sql,
  prefix: string,
  opts: { maxAgeMs?: number; now?: number; log?: (line: string) => void } = {},
): Promise<SweepResult> {
  const maxAgeMs = opts.maxAgeMs ?? STALE_ROLE_MS;
  const now = opts.now ?? Date.now();
  const like = `${prefix.replace(/[\\_%]/g, "\\$&")}%`;
  const rows = await admin<Array<{ rolname: string; comment: string | null }>>`
    select r.rolname, shobj_description(r.oid, 'pg_authid') as comment
      from pg_roles r where r.rolname like ${like} order by r.rolname`;
  const out: SweepResult = { dropped: [], stamped: [], kept: [], failed: [] };
  for (const { rolname, comment } of rows) {
    const verdict = roleAgeVerdict(comment, now, maxAgeMs);
    if (verdict === "young") out.kept.push(rolname);
    else if (verdict === "unstamped") {
      await admin.unsafe(`comment on role ${quoteIdent(rolname)} is '${roleStamp(now, "first-seen")}'`);
      out.stamped.push(rolname);
    } else {
      try { await dropRoleAndItsDatabases(admin, rolname); out.dropped.push(rolname); }
      catch { out.failed.push(rolname); }
    }
  }
  opts.log?.(
    `[pg] stale ${prefix}* roles: dropped ${out.dropped.length}, stamped ${out.stamped.length}, ` +
      `kept ${out.kept.length}, drop failed ${out.failed.length}${out.failed.length ? ` (${out.failed.join(", ")})` : ""}`,
  );
  return out;
}

/** One named role's `pg_db_role_setting` rows, as one comparable string. */
export async function roleSettings(admin: Sql, role: string): Promise<{ role: string; settings: string }> {
  const rows = await admin<Array<{ db: number; setconfig: string[] | null }>>`
    select rs.setdatabase::int as db, rs.setconfig
      from pg_db_role_setting rs join pg_roles r on r.oid = rs.setrole
     where r.rolname = ${role} order by rs.setdatabase`;
  return { role, settings: JSON.stringify(rows.map((r) => [r.db, [...(r.setconfig ?? [])].sort()])) };
}

/** The box role every lane database is made by; a lane dials as its own `tf_l_<key>` beside it. */
export const BOX_ROLE = "tf";

/** The roles the guard reads: the URL's own (current_user), and the box role beside it when it exists. */
export async function guardedRoles(admin: Sql): Promise<string[]> {
  const me = (await admin`select current_user as role`)[0]!.role as string;
  const box = await admin`select 1 from pg_roles where rolname = ${BOX_ROLE}`;
  return me !== BOX_ROLE && box.length > 0 ? [me, BOX_ROLE] : [me];
}

/** The deadline GUCs `setupProdDatabase` writes, as they appear in the shared role's settings. */
export function deadlinesIn(settings: string): string[] {
  const rows = JSON.parse(settings) as Array<[number, string[]]>;
  return rows.flatMap(([, kv]) => kv).filter((kv) => Object.keys(ROLE_DEFAULT_TIMEOUTS).some((g) => kv.startsWith(`${g}=`)));
}

const scopeOf = async (admin: Sql, role: string, db: number): Promise<string> => {
  if (db === 0) return `alter role ${quoteIdent(role)}`;
  const d = await admin<Array<{ datname: string }>>`select datname from pg_database where oid = ${db}`;
  if (!d[0]) throw new Error(`role ${role} carries a setting for database oid ${db}, which no longer exists`);
  return `alter role ${quoteIdent(role)} in database ${quoteIdent(d[0].datname)}`;
};

/**
 * PUT A ROLE BACK to a `roleSettings` reading: a key the reading lacks is
 * RESET, a key it holds is SET to its value, per database scope. A guard that only refused left the
 * deadlines on the lane role for every later file. Returns what it did, one entry per statement.
 */
export async function restoreRoleSettings(admin: Sql, role: string, before: string): Promise<string[]> {
  const flat = (s: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const [db, kvs] of JSON.parse(s) as Array<[number, string[]]>) {
      for (const kv of kvs) { const eq = kv.indexOf("="); m.set(`${db}\u0000${kv.slice(0, eq)}`, kv.slice(eq + 1)); }
    }
    return m;
  };
  const was = flat(before), now = flat((await roleSettings(admin, role)).settings), did: string[] = [];
  for (const k of new Set([...was.keys(), ...now.keys()])) {
    if (was.get(k) === now.get(k)) continue;
    const [db, key] = k.split("\u0000") as [string, string];
    if (!/^[a-z_][a-z0-9_.]*$/i.test(key)) throw new Error(`role ${role} carries a setting named ${JSON.stringify(key)}; not putting it back by hand`);
    const head = await scopeOf(admin, role, Number(db));
    const v = was.get(k);
    const stmt = v === undefined ? `${head} reset ${key}` : `${head} set ${key} = '${v.replace(/'/g, "''")}'`;
    await admin.unsafe(stmt);
    did.push(v === undefined ? `${key} reset on ${role}` : `${key} put back to ${v} on ${role}`);
  }
  return did;
}

/**
 * THE GUARD, read at the file's start, after every case and at the end, over the role in the admin
 * URL (a lane's `tf_l_<key>`) AND the box role `tf` beside it. It refuses a role that ALREADY
 * carries the deadlines (a lane role is reset by `scripts/lane-db.sh <worktree>`; tf only by the
 * dispatcher). A change since the start is PUT BACK, read back, and then refused, so the case fails
 * and the next file meets the role as this one did. `roles` replaces the two for a guard's own test.
 */
export function sharedRoleGuard(
  opts: { roles?: (admin: Sql) => Promise<string[]> } = {},
): { start(admin: Sql): Promise<void>; check(admin: Sql): Promise<void> } {
  let before: Array<{ role: string; settings: string }> | null = null;
  return {
    async start(admin) {
      const read: Array<{ role: string; settings: string }> = [];
      for (const role of await (opts.roles ?? guardedRoles)(admin)) read.push(await roleSettings(admin, role));
      before = read;
      for (const r of read) {
        const found = deadlinesIn(r.settings);
        if (found.length === 0) continue;
        throw new Error(
          `the role ${r.role} carries setupProdDatabase's role deadlines before this file ran: ${found.join(", ")} — ` +
            "not this file's doing; every connection as that role inherits them until reset " +
            `(${r.role === BOX_ROLE ? "the dispatcher resets tf" : "bash scripts/lane-db.sh <worktree> resets a lane role"})`,
        );
      }
    },
    async check(admin) {
      if (before === null) return;
      for (const b of before) {
        const now = await roleSettings(admin, b.role);
        if (now.settings !== b.settings) {
          const did = await restoreRoleSettings(admin, b.role, b.settings);
          const after = await roleSettings(admin, b.role);
          throw new Error(
            `the role ${b.role}'s settings changed during this file: ${b.settings} -> ${now.settings} ` +
              "(setupProdDatabase ran as that role; run it through setupRole().urlFor) — " +
              (after.settings === b.settings
                ? `put back, read back equal: ${did.join("; ")}`
                : `PUT-BACK FAILED, the role still reads ${after.settings}`),
          );
        }
      }
    },
  };
}
