/**
 * ONE GREENMAIL PER CHECKOUT — the pure half of `scripts/lane-greenmail.sh`, shared by the tool, the
 * vitest setup file, the IMAP resolver and `box-files.mjs`. `<checkout>/.lane-greenmail.env` names
 * this checkout's own compose project and its four variables; when it exists it WINS over the
 * environment, like `.lane-db.env`. All four or none, and never the shared box's ports: a lane that
 * isolates its reads and delivers its sends into the shared box is worse than no lane.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const LANE_GREENMAIL_ENV_FILE = ".lane-greenmail.env";
export const LANE_GREENMAIL_PREFIX = "ohmail-gm-";
export const LANE_GREENMAIL_PROJECT_RE = /^ohmail-gm-[0-9a-f]{12}$/;
export const LANE_GREENMAIL_VARS = ["IMAP_HOST", "IMAP_PORT", "SMTP_HOST", "SMTP_PORT"];
/** The shared container's host ports, which a lane file may never name. */
export const SHARED_GREENMAIL_PORTS = new Set([3143, 3025]);
/** Where a lane's ports are drawn from: IMAP in [21000, 23000), SMTP at a fixed offset above it. */
export const LANE_PORT_BASE = 21000;
export const LANE_PORT_SLOTS = 2000;

/** The checkout's key: the first 12 hex of sha256 over its ABSOLUTE path, as `lane-db.sh` keys it. */
export function laneGreenmailKey(worktreePath) {
  return createHash("sha256").update(resolve(worktreePath)).digest("hex").slice(0, 12);
}

export function laneGreenmailProject(worktreePath) {
  return LANE_GREENMAIL_PREFIX + laneGreenmailKey(worktreePath);
}

/** A project name this tool may create or tear down. The shared compose project is refused. */
export function assertLaneGreenmailProject(name) {
  if (!LANE_GREENMAIL_PROJECT_RE.test(String(name))) {
    throw new Error(`refusing to touch compose project "${name}": this tool creates and removes `
      + `${LANE_GREENMAIL_PREFIX}<12 hex> and nothing else — the shared GreenMail is not a lane's`);
  }
  return name;
}

/** The ports tried for `attempt`: a slot derived from the key, walked linearly past a taken one. */
export function lanePorts(key, attempt = 0) {
  const slot = (parseInt(String(key).slice(0, 8), 16) + attempt) % LANE_PORT_SLOTS;
  return { imap: LANE_PORT_BASE + slot, smtp: LANE_PORT_BASE + LANE_PORT_SLOTS + slot };
}

/** A lane file's body, or a refusal naming what is wrong with it — an empty file included. */
export function parseLaneGreenmailEnv(text, where = LANE_GREENMAIL_ENV_FILE) {
  const kv = {};
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const m = /^([A-Z_]+)=(.*)$/.exec(t);
    if (m) kv[m[1]] = m[2].trim();
  }
  const project = kv.LANE_GREENMAIL_PROJECT;
  const missing = ["LANE_GREENMAIL_PROJECT", ...LANE_GREENMAIL_VARS].filter((k) => !kv[k]);
  if (missing.length > 0) {
    throw new Error(`${where} names ${missing.join(", ")} as nothing: a lane GreenMail sets all four `
      + "variables and its project, or none — run bash scripts/lane-greenmail.sh <checkout> again");
  }
  assertLaneGreenmailProject(project);
  const ports = { imap: Number(kv.IMAP_PORT), smtp: Number(kv.SMTP_PORT) };
  for (const [k, p] of Object.entries(ports)) {
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error(`${where}: ${k.toUpperCase()}_PORT is not a port`);
    if (SHARED_GREENMAIL_PORTS.has(p)) {
      throw new Error(`${where}: ${k.toUpperCase()}_PORT ${p} is the SHARED GreenMail's port — a lane file `
        + "naming it runs unlocked against the box every checkout shares");
    }
  }
  return { project, vars: Object.fromEntries(LANE_GREENMAIL_VARS.map((k) => [k, kv[k]])) };
}

/** `<root>/.lane-greenmail.env` parsed, `null` when the checkout has none; a malformed one throws. */
export function readLaneGreenmail(root) {
  let text;
  try { text = readFileSync(join(root, LANE_GREENMAIL_ENV_FILE), "utf8"); } catch { return null; }
  return parseLaneGreenmailEnv(text, join(root, LANE_GREENMAIL_ENV_FILE));
}

/** The lane's four variables written into `env`, the lane WINNING. Returns the names it overrode. */
export function applyLaneGreenmail(env, lane) {
  if (lane === null) return [];
  const overrode = LANE_GREENMAIL_VARS.filter((k) => env[k] !== undefined && env[k] !== lane.vars[k]);
  for (const k of LANE_GREENMAIL_VARS) env[k] = lane.vars[k];
  return overrode;
}

/**
 * THE HOST AND PORTS A TEST DIALS: the lane file first, then the environment, then the shared box.
 * With a lane file the environment must already carry its values — the proof that the run's setup
 * applied it, so the files that read `process.env` directly dial the same server. A run whose config
 * lost `test/setup/lane-greenmail.ts` refuses here by name instead of reading half of its traffic
 * from the lane and half from the shared box.
 */
export function greenmailEndpoint(env, lane) {
  if (lane !== null) {
    const off = LANE_GREENMAIL_VARS.filter((k) => env[k] !== lane.vars[k]);
    if (off.length > 0) {
      throw new Error(`this checkout has its own GreenMail (${lane.project}) but ${off.join(", ")} in the `
        + "environment do not name it: the run did not apply test/setup/lane-greenmail.ts, so files "
        + "reading process.env would dial the shared box. Nothing was measured.");
    }
  }
  return {
    imapHost: env.IMAP_HOST ?? "127.0.0.1",
    imapPort: Number(env.IMAP_PORT ?? 3143),
    smtpHost: env.SMTP_HOST ?? "127.0.0.1",
    smtpPort: Number(env.SMTP_PORT ?? 3025),
    lane: lane === null ? null : lane.project,
  };
}

/**
 * THE HOST'S DOCKER ADDRESS POOLS (`lane-greenmail.sh --count-networks`). Every compose project takes
 * one bridge network from them, and 28 lane GreenMails left up "for the landing" took the last one
 * at 2026-09-27T02:46Z. Docker's own pools, used when /etc/docker/daemon.json names none, hold 31
 * networks: fifteen /16s from 172.17-172.31 and sixteen /20s of 192.168.0.0/16.
 */
export const DOCKER_DEFAULT_POOLS = [
  { base: "172.17.0.0/16", size: 16 }, { base: "172.18.0.0/16", size: 16 }, { base: "172.19.0.0/16", size: 16 },
  { base: "172.20.0.0/14", size: 16 }, { base: "172.24.0.0/14", size: 16 }, { base: "172.28.0.0/14", size: 16 },
  { base: "192.168.0.0/16", size: 20 },
];

/** How many networks a pool list gives: 2^(size - prefix) each; a malformed pool throws. */
export function poolCapacity(pools) {
  let n = 0;
  for (const p of pools) {
    const m = /^\d{1,3}(?:\.\d{1,3}){3}\/(\d{1,2})$/.exec(String(p?.base ?? ""));
    const size = Number(p?.size);
    if (!m || !Number.isInteger(size) || size < Number(m[1]) || size > 32) throw new Error(`not an address pool: ${JSON.stringify(p)}`);
    n += 2 ** (size - Number(m[1]));
  }
  return n;
}

/* A ROUTE OVER A POOL TAKES ITS NETWORKS. Docker skips a pool subnet that
 * overlaps a host route (a libvirt 192.168.122.0/24 takes one /20 of 192.168.0.0/16), and the count
 * above still counted it free. Docker's own bridges are its allocated networks, already counted as
 * bridges, and the default route overlaps nothing, so neither is read here. */
export const DOCKER_OWNED_DEV = /^(docker0|docker_gwbridge|br-[0-9a-f]{12})$/;
const ipv4 = (s) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(String(s ?? ""));
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255)) return null;
  const bits = m[5] === undefined ? 32 : Number(m[5]);
  if (bits > 32) return null;
  const span = 2 ** (32 - bits), ip = ((Number(m[1]) * 256 + Number(m[2])) * 256 + Number(m[3])) * 256 + Number(m[4]);
  return { start: ip - (ip % span), span };
};

/** The pool networks a non-Docker host route overlaps, and the routes that did it; a malformed route throws. */
export function routeSkipped(pools, routes) {
  const by = [];
  for (const r of routes) {
    if (r.dst === "default" || DOCKER_OWNED_DEV.test(String(r.dev ?? ""))) continue;
    const net = ipv4(r.dst);
    if (net === null) throw new Error(`not a host route: ${JSON.stringify(r)}`);
    by.push({ ...net, name: `${r.dst} on ${r.dev}` });
  }
  let skipped = 0;
  const names = new Set();
  for (const p of pools) {
    const pn = ipv4(p.base), block = 2 ** (32 - Number(p.size));
    const idx = [];
    for (const r of by) {
      const lo = Math.max(pn.start, r.start), hi = Math.min(pn.start + pn.span, r.start + r.span);
      if (lo >= hi) continue;
      idx.push([Math.floor((lo - pn.start) / block), Math.floor((hi - 1 - pn.start) / block)]);
      names.add(r.name);
    }
    idx.sort((a, b) => a[0] - b[0]);
    let end = -1;
    for (const [a, b] of idx) { if (b > end) { skipped += b - Math.max(a, end + 1) + 1; end = b; } }
  }
  return { skipped, routes: [...names] };
}

/** The count line, and rc 3 when fewer than `minFree` networks are left for a new project. */
export function networkPoolReading({ bridge, lanes, orphans, pools, source, routes, minFree = 1 }) {
  if (!Array.isArray(routes)) throw new Error("no host routes were read — a pool network under a route is not free, and an unread route list is not an empty one");
  const cap = poolCapacity(pools);
  const under = routeSkipped(pools, routes);
  const free = cap - bridge - under.skipped;
  const line = `NETWORKS bridge ${bridge} of ${cap} (${source}) · under a host route ${under.skipped}`
    + `${under.routes.length ? ` (${under.routes.join(", ")})` : ""} of ${routes.length} route(s) read · free ${free} · lane GreenMail ${lanes} (${orphans} ORPHAN)`;
  if (free >= minFree) return { rc: 0, free, lines: [line] };
  return { rc: 3, free, lines: [line, `POOL-NEARLY-FULL free ${free} < ${minFree} — a new compose project gets no network; drop the ORPHAN lane GreenMails first (bash scripts/lane-greenmail.sh --list, then --drop --name <project>)`] };
}
