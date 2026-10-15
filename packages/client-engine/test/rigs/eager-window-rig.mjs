/**
 * WHAT THE EAGER RECENT-WINDOW BODY PASS COSTS PER DRAIN, and what it buys at the open.
 *
 * A rig, not a test: it reports milliseconds, bytes and bumps, and a timing assertion in a suite
 * is a flake. It drives the real `OhmailEngine` from `dist` over the same corpus the import rigs
 * use (`import-corpus.mjs`), through an adapter that paginates the way the door does, and then
 * fires the scheduler's own kick — `prefetchRecentBodies()` from the one place that knows a drain
 * settled — exactly as `sync-scheduler.ts` does.
 *
 *   node --expose-gc --max-old-space-size=8192 \
 *        packages/client-engine/test/rigs/eager-window-rig.mjs \
 *        --scale 1 [--dist <dir|/abs/dir>] [--fetch-ms 0] [--json <path>]
 *
 * `--dist` names a sibling build, so the four settings of `EAGER_BODIES_MAX` are four processes
 * over four patched builds rather than four rebuilds: the constant is compiled in, and an engine
 * option for it would be a product change made to take a measurement.
 *
 * FOUR PASSES, because "what the pass costs" is four different questions:
 *   cold        the first pass after the import settles — every body still to fetch
 *   steady      the same pass again over a mailbox nothing arrived in — the RECURRING per-drain
 *               cost, which is the one the 8 s cadence has to absorb
 *   delta       a pass after a poll delivered `--delta` new messages — the ordinary steady state
 *   opens       the open latency of the 1st, 100th, 500th, 1000th and 2000th newest message
 *
 * WHAT IT MEASURES AND WHAT IT DOES NOT. Wall and CPU of the pass, wire bytes and requests, the
 * mirror's version bumps and the whole-mirror derivations they cause (`client-vitals`, the same
 * counters the shell's five-minute line reports). It does NOT measure React, the DOM or the body
 * iframe, so every figure here is a FLOOR for what the renderer is charged — the rule
 * `import-peak-rig.mjs` states and this rig inherits.
 *
 * THE SUBSCRIBER IS THE SHELL'S OWN REACTION, and it has to be: `useEngineVersion` is an
 * unthrottled `useSyncExternalStore` over `notify()`, and the whole-mirror pass the store times
 * runs on the first selector call after each bump. A rig without a subscriber measures the pass
 * with the mirror's reaction switched off, which is the half that is not the cost.
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { corpus as sharedCorpus, CORPUS_NOW, CORPUS_OWNER } from "./import-corpus.mjs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const SCALE = Number(arg("scale", 1));
const PAGE = Number(arg("page", 500));
const BODY_KB = Number(arg("body-kb", 12));
const DAYS = Number(arg("days", 90));
const MIN_ROWS = Number(arg("min-rows", 5000));
const POLICY = arg("policy", "windowed");
/** Modelled per-request latency. `0` = the CPU floor; `100` = the warm round trip the eager docblock cites. */
const FETCH_MS = Number(arg("fetch-ms", 0));
/** How many new messages the poll before the `delta` pass delivers. */
const DELTA = Number(arg("delta", 20));
/** Ranks whose open latency is timed, newest-first. */
const OPEN_RANKS = arg("open-ranks", "1,100,500,1000,2000").split(",").map(Number);
/** How many of the newest window are opened for the p95 — every `1000/OPEN_SAMPLE`-th. */
const OPEN_SAMPLE = Number(arg("open-sample", 40));
const JSON_OUT = arg("json", "");
const DIST = arg("dist", "dist");
/** Attach the shell's own projection to every bump — the reaction, not just the store. */
const DERIVE = arg("derive", "1") !== "0";
/** How many consecutive do-nothing passes to run after the delta — does the pass settle, or chase? */
const REPAIRS = Number(arg("repairs", 3));

const dist = (m) => (DIST.startsWith("/")
  ? pathToFileURL(join(DIST, m)).href
  : new URL(`../../${DIST}/${m}`, import.meta.url).href);
const { MemoryMirrorStore } = await import(dist("store.js"));
const { OhmailEngine, EAGER_BODIES_MAX, BODY_CACHE_MAX, BODIES_IDS_MAX } = await import(dist("engine.js"));
const { peekClientEngineVitals } = await import(dist("client-vitals.js"));
const { consentPartition, presentationReader } = await import(dist("consent-cutline.js"));

const NOW = CORPUS_NOW;
const OWN = [CORPUS_OWNER];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * BODY BYTES THAT COST WHAT MAIL COSTS — derived per id, never concatenated from shared
 * constants: a cons-string tree over one leaf measures the rope and not the mail.
 */
function bodyText(id) {
  const want = BODY_KB * 1024;
  let out = "";
  let i = 0;
  while (out.length < want) out += createHash("sha256").update(`${id}:${i++}`).digest("hex");
  return out.slice(0, want);
}

/** Everything the wire was asked for, so a phase's bytes are a delta and not a total. */
const wire = { bodyCalls: 0, batchCalls: 0, ids: 0, bytes: 0 };

const messages = sharedCorpus({ scale: SCALE, order: "asc", now: NOW });
const corpusSize = messages.length;
/** Kept for the delta poll: the newest of the corpus, re-dated so they arrive after everything. */
const feed = messages.splice(0);
let served = 0;
let seq = 0;
const pending = [];

const adapter = {
  sync: async () => {
    const slice = pending.length > 0 ? pending.splice(0, PAGE) : feed.splice(0, PAGE);
    served += slice.length;
    const creates = slice.map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    }));
    return {
      changes: { creates, updates: [], moves: [], deletes: [] },
      cursor: String(seq), hasMore: feed.length > 0 || pending.length > 0,
      serverTime: NOW.toISOString(),
    };
  },
  mutate: async () => ({ changes: [], seq: null }),
  fetchBody: async (id) => {
    wire.bodyCalls += 1;
    wire.ids += 1;
    if (FETCH_MS > 0) await sleep(FETCH_MS);
    const text = bodyText(id);
    wire.bytes += text.length;
    return { text, html: null, loadedRemoteContent: false };
  },
  fetchBodies: async (ids) => {
    wire.batchCalls += 1;
    wire.ids += ids.length;
    if (FETCH_MS > 0) await sleep(FETCH_MS);
    return ids.map((id) => {
      const text = bodyText(id);
      wire.bytes += text.length;
      return { messageId: id, text, html: null, loadedRemoteContent: false };
    });
  },
};

const policy = POLICY === "full"
  ? { mode: "full" }
  : { mode: "windowed", days: DAYS, minRows: MIN_ROWS };

const store = new MemoryMirrorStore();
const engine = new OhmailEngine({
  adapter, store, now: () => NOW, storePolicy: policy, eagerBodies: true,
});

/**
 * THE SHELL'S REACTION, AND IT IS NOT THE STORE'S BUCKET REBUILD. `client-vitals` times
 * `bucketsOf`, which is a partition of the record map and costs ~1 ms at the rig's size on this host —
 * a real number, and not the one that is felt. What the shell pays per bump is the PROJECTION:
 * `consentPartition` + `presentationReader` and the eighteen memos keyed on the mirror version,
 * which is the 180–236 ms pass `PERFORMANCE.md` records. So the subscriber derives the projection
 * the piles read, exactly as `import-peak-rig.mjs --derive` does, and both numbers are reported:
 * `derives`/`deriveMsTotal` from the store's own counters, `presMs` from here.
 *
 * `--derive 0` turns the projection off, to attribute a pass between the engine and the reaction.
 */
let publishes = 0;
let presCount = 0;
let presMs = 0;
let presKept = 0;
engine.subscribe(() => {
  publishes += 1;
  if (!DERIVE) { store.entries("message"); return; }
  const t = performance.now();
  const pres = presentationReader(store, consentPartition(store, { now: NOW, ownAddresses: OWN }));
  // Read the projection the way the piles do, so the derivation is not dead-code-eliminated.
  presKept += pres.list("message").length > 0 ? 1 : 0;
  presMs += performance.now() - t;
  presCount += 1;
});

const collect = () => { if (typeof global.gc === "function") { global.gc(); global.gc(); } };
const mb = (n) => Math.round(n / (1024 * 1024));
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** A phase is a delta of every counter, taken the same way on both sides. */
function phase() {
  const v0 = peekClientEngineVitals();
  const p0 = publishes;
  const pm0 = presMs;
  const pc0 = presCount;
  const w0 = { ...wire };
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  return () => {
    const wallMs = performance.now() - t0;
    const c = process.cpuUsage(c0);
    const v = peekClientEngineVitals();
    return {
      wallMs: round(wallMs),
      cpuMs: round((c.user + c.system) / 1000),
      publishes: publishes - p0,
      derives: v.derives - v0.derives,
      deriveMsTotal: round(v.deriveMsTotal - v0.deriveMsTotal),
      deriveMsMax: round(v.deriveMsMax),
      presDerives: presCount - pc0,
      presMsTotal: round(presMs - pm0),
      batchCalls: wire.batchCalls - w0.batchCalls,
      bodyCalls: wire.bodyCalls - w0.bodyCalls,
      wireIds: wire.ids - w0.ids,
      wireKb: Math.round((wire.bytes - w0.bytes) / 1024),
      rssMb: mb(process.memoryUsage().rss),
    };
  };
}

// ── the import ────────────────────────────────────────────────────────────────
const t0 = performance.now();
await engine.start();
for (let i = 0; i < 5000 && (feed.length > 0 || pending.length > 0); i++) await engine.syncOnce();
// The next poll after the import: an empty drain that settles in ONE page, which is what tells the
// engine the catch-up is over (`caughtUpInOnePage`). Without it the pass is a no-op by design.
await engine.syncOnce();
const importMs = Math.round(performance.now() - t0);
const settledRows = store.entries("message").length;
collect();

// ── cold: the first pass, every body still to fetch ───────────────────────────
const endCold = phase();
await engine.prefetchRecentBodies();
await engine.eagerBodiesIdle();
const cold = endCold();
const bodiesAfterCold = store.entries("message_body").length;

// ── steady: the same pass over a mailbox nothing arrived in ───────────────────
await engine.syncOnce();
const endSteady = phase();
await engine.prefetchRecentBodies();
await engine.eagerBodiesIdle();
const steady = endSteady();

// ── delta: a poll delivered `DELTA` new messages, then the pass ───────────────
for (let i = 0; i < DELTA; i++) {
  const when = new Date(NOW.getTime() - i * 60_000).toISOString();
  const id = `delta${i}`;
  pending.push({
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: `<${id}@x.example>`,
    subject: `Invoice ${1000 + i} — the subject line as the row renders it`,
    from: { name: `Sender ${i}`, address: `sender${i}@org${i % 60}.example` },
    to: [{ name: null, address: CORPUS_OWNER }], cc: [],
    date: when, folder: "INBOX",
    snippet: `snippet ${id} — a line of preview text the row renders, long enough to be real`,
    unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: when,
  });
}
await engine.syncOnce();
const endDelta = phase();
await engine.prefetchRecentBodies();
await engine.eagerBodiesIdle();
const delta = endDelta();

// ── the window after the delta: what the evictor took ─────────────────────────
/**
 * WHICH OF THE NEWEST `EAGER_BODIES_MAX` HAVE NO BODY once one poll has landed.
 *
 * The pass walks NEWEST FIRST and `trimBodyCache` evicts the LEAST RECENTLY TOUCHED, and
 * `touchBody` is the write — so the newest mail is the coldest entry in the LRU and is the first
 * thing dropped when the next arrival pushes the cache over {@link BODY_CACHE_MAX}. This counts
 * the holes and names their rank band rather than leaving it to be inferred from a starred open.
 */
const rankedAfterDelta = store.entries("message")
  .sort((a, b) => (b.entity.date ?? "").localeCompare(a.entity.date ?? ""))
  .map((e) => e.id);
const readyAfterDelta = new Set(
  store.entries("message_body").filter((e) => e.entity?.state === "ready").map((e) => e.id),
);
const windowRanks = rankedAfterDelta.slice(0, Math.min(EAGER_BODIES_MAX, rankedAfterDelta.length));
const missRanks = [];
for (let i = 0; i < windowRanks.length; i++) if (!readyAfterDelta.has(windowRanks[i])) missRanks.push(i + 1);
const windowMisses = {
  window: windowRanks.length,
  misses: missRanks.length,
  firstRank: missRanks[0] ?? null,
  lastRank: missRanks[missRanks.length - 1] ?? null,
  newestMissing: missRanks[0] === 1,
};

// ── repair: the very next pass, with nothing new arriving ─────────────────────
/**
 * A pass over a mailbox nothing arrived in should cost NOTHING — every id plans to `skip`. Any
 * wire id here is the pass re-fetching a body the evictor has just dropped, which is the
 * "pass and evictor chasing each other" shape `BODY_CACHE_MAX`'s sizing exists to prevent.
 */
const repairs = [];
for (let i = 0; i < REPAIRS; i++) {
  await engine.syncOnce();
  const endRepair = phase();
  await engine.prefetchRecentBodies();
  await engine.eagerBodiesIdle();
  const r = endRepair();
  const readyNow = new Set(
    store.entries("message_body").filter((e) => e.entity?.state === "ready").map((e) => e.id),
  );
  r.windowMisses = windowRanks.reduce((n, id) => (readyNow.has(id) ? n : n + 1), 0);
  repairs.push(r);
}
const repair = repairs[0];

// ── opens ─────────────────────────────────────────────────────────────────────
/**
 * NEWEST-FIRST, THE PASS'S OWN ORDER — the same sort `runEagerBodies` does, so rank N here is the
 * message the pass would have reached Nth. Read once: every `entries()` call after a bump pays the
 * whole-mirror pass, and a rank list re-derived per open would charge the opens for the rig.
 */
const newest = store.entries("message")
  .sort((a, b) => (b.entity.date ?? "").localeCompare(a.entity.date ?? ""))
  .map((e) => e.id);

/**
 * WHICH BODIES THE PASS LEFT READY — read ONCE, before the first open. Asking the store per open
 * would pay a whole-mirror rebuild per open (every open bumps), which is the rig's cost and not the
 * product's, and it would take longer than the measurement.
 */
const readyAtStart = new Set(
  store.entries("message_body").filter((e) => e.entity?.state === "ready").map((e) => e.id),
);

/**
 * ONE OPEN, timed the way the shell's selection effect issues it — `urgent`, which jumps the
 * non-urgent queue. The wait includes the mirror's own reaction, because the subscriber above runs
 * inside `notify()`: the number is "from the press to the body being in the mirror with the shell
 * re-derived", short of React's own render.
 */
async function timeOpen(rank) {
  const id = newest[rank - 1];
  if (id === undefined) return null;
  const hydrated = readyAtStart.has(id);
  const t = performance.now();
  await engine.hydrateBody(id, { urgent: true });
  return { rank, hydrated, ms: round(performance.now() - t) };
}

const opens = [];
for (const r of OPEN_RANKS) {
  const o = await timeOpen(r);
  if (o) opens.push(o);
}

/**
 * THE p95 OVER THE NEWEST WINDOW. Sampled every `1000/OPEN_SAMPLE`-th rank and NOT over the ranks
 * above, which the point opens have already hydrated — an open is a mutation, so the sample and
 * the points cannot share a process without the sample reading the points' work as the product's.
 */
const sampled = [];
const step = Math.max(1, Math.floor(1000 / OPEN_SAMPLE));
for (let r = 2; r <= 1000; r += step) {
  if (OPEN_RANKS.includes(r)) continue;
  const o = await timeOpen(r);
  if (o) sampled.push(o);
}
const sortedMs = sampled.map((o) => o.ms).sort((a, b) => a - b);
const pct = (p) => (sortedMs.length === 0 ? null : sortedMs[Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1)]);

const report = {
  eagerBodiesMax: EAGER_BODIES_MAX, bodyCacheMax: BODY_CACHE_MAX, bodiesIdsMax: BODIES_IDS_MAX,
  dist: DIST, scale: SCALE, corpus: corpusSize, settledRows, importMs,
  bodyKb: BODY_KB, fetchMs: FETCH_MS, deltaMessages: DELTA,
  derive: DERIVE, presKept,
  bodiesAfterCold,
  cold, steady, delta, repair, repairs,
  windowMisses,
  opens,
  openSample: { n: sampled.length, p50: pct(50), p95: pct(95), max: sortedMs[sortedMs.length - 1] ?? null },
  node: process.version,
};
console.log(JSON.stringify(report));
if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
