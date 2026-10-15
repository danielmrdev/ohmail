/**
 * WHAT A FIRST IMPORT COSTS THE WINDOW, over the real engine, the real store and the real drain.
 *
 * A rig, not a test: it reports megabytes and row counts, and a memory assertion in a suite is a
 * flake. It drives the real `OhmailEngine` from `dist` with the desktop window's own options over
 * the corpus's measured date distribution, through an adapter that PAGINATES the way the
 * standalone door does — which is the whole point, because `drain()` skips the windowed prune on
 * every page that answers `hasMore: true`.
 *
 *   node --expose-gc --max-old-space-size=8192 \
 *        packages/client-engine/test/rigs/import-peak-rig.mjs \
 *        --policy windowed --max-rows 0 [--dist <dir>] [--json <path>] [--snapshot <phase>]
 *
 * Run it from the repo root after `pnpm -r build`. It imports dist MODULES and not the barrel:
 * the package's exports map points at `src`, which a Node consumer cannot resolve (the documented
 * source-leaf hazard). `--dist` names a sibling build, so a before/after is one process pair
 * rather than a rebuild between arms.
 *
 * FOUR PHASES, because "the peak" is four different questions:
 *   import      the backlog drain, page by page — where the mirror grows and nothing prunes
 *   settle      the last page, where `hasMore` goes false and the first prune pass runs
 *   eager       the scheduler's body pass over the mirror's newest EAGER_BODIES_MAX
 *   after       two full collects, so a transient is told apart from a retainer
 *
 * It measures the engine, the store and the mirror — the renderer's JavaScript. It does NOT
 * measure React, the DOM, the sandboxed body iframes or decoded images, so every figure here is a
 * FLOOR for what `WebKitWebProcess` is charged.
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { corpus as sharedCorpus, CORPUS_NOW, CORPUS_OWNER } from "./import-corpus.mjs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const POLICY = arg("policy", "windowed");
const DAYS = Number(arg("days", 90));
const MIN_ROWS = Number(arg("min-rows", 5000));
/** 0 = the field is ABSENT, which is the rc3 shape and must behave exactly as rc3 did. */
const MAX_ROWS = Number(arg("max-rows", 0));
const PAGE = Number(arg("page", 500));
const SAMPLE_EVERY = Number(arg("sample-every", 5));
const BODY_KB = Number(arg("body-kb", 12));
const SNAPSHOT = arg("snapshot", "");
/**
 * WHICH PHASE the snapshot is of. `import` is the one that matters: it fires on the LAST page that
 * still answers `hasMore: true` — the moment the mirror is whole and no prune has run — and then
 * exits, because a snapshot taken later is a picture of a different heap. `settled` and `after`
 * are the same heap two prunes and two collects on.
 */
const SNAPSHOT_AT = arg("snapshot-at", "after");
const JSON_OUT = arg("json", "");
const SCALE = Number(arg("scale", 1));
/**
 * ATTACH THE SHELL'S OWN REACTION. `useEngineVersion` is an unthrottled `useSyncExternalStore`
 * over `notify()`, and eighteen of AppShell's memos are keyed on that version — so one whole-mirror
 * partition and projection per bump is what the renderer actually pays. Without this the rig
 * measures the mirror and not the cost the mirror is multiplied by.
 */
const DERIVE = arg("derive", "0") !== "0";
/**
 * HOW THE IMPORT REACHES THE WINDOW. `0` is one uninterrupted backlog — every page answers
 * `hasMore: true` and the drain settles once at the end, which is what a mirror opening onto an
 * ALREADY-IMPORTED mailbox sees. Any other value is the FIRST-import shape: the sidecar is still
 * ingesting, so the door runs out of rows every few pages, the drain settles, and the shell fires
 * both the prune and the eager pass before the next poll. The two shapes put the mirror in
 * completely different places, so the rig measures whichever is asked for and names it.
 */
const SETTLE_EVERY = Number(arg("settle-every", 0));
/** `0` turns the eager body pass off, to attribute the peak between the mirror and the prefetch. */
const EAGER = arg("eager", "1") !== "0";
/** `asc` = oldest mail first (a since=0 log replay); `desc` = newest first (a snapshot-shaped walk). */
const ORDER = arg("order", "asc");
const DIST = arg("dist", "dist");

const dist = (m) => new URL(`../../${DIST}/${m}`, import.meta.url).href;
const { MemoryMirrorStore } = await import(dist("store.js"));
const { OhmailEngine, EAGER_BODIES_MAX } = await import(dist("engine.js"));
const { consentPartition, presentationReader } = await import(dist("consent-cutline.js"));

/** Fixed, so two arms of one comparison see the identical corpus. */
const NOW = CORPUS_NOW;
const OWN = [CORPUS_OWNER];
let kept = 0;
let drained = () => true;
const feedDrained = () => drained();

/**
 * THE CORPUS, measured from the rig maildir and now shared with the BROWSER rig, which
 * measures the same import under the real `AppShell`. One module, because the renderer's
 * classes are read by subtracting this rig's figure from the browser's and a distribution that
 * differed by a folder would land in the answer. `test/import-corpus-identity.test.ts` pins the
 * fingerprint the inline copy produced, so the move is proven rather than argued.
 */
const corpus = () => sharedCorpus({ scale: SCALE, order: ORDER, now: NOW });

/**
 * BODY BYTES THAT COST WHAT MAIL COSTS. Concatenating shared constants leaves the JS engine a cons-string
 * tree over one leaf and measures the rope, not the mail (§5 again) — so every body is derived
 * from its own hash.
 */
function bodyText(id) {
  const want = BODY_KB * 1024;
  let out = "";
  let i = 0;
  while (out.length < want) out += createHash("sha256").update(`${id}:${i++}`).digest("hex");
  return out.slice(0, want);
}

/**
 * A `/sync` that paginates honestly — `hasMore` true until the backlog is gone, as the door does.
 *
 * IT CONSUMES THE FEED. `splice` rather than `slice`, so the rig stops referencing every entity it
 * has already handed over: with the rig's own copy alive, a snapshot shows tens of thousands of element arrays
 * whatever the mirror holds, because the picture is of the RIG (the trap the previous measurement
 * recorded, and this rig walked into it once before this line existed — the settled arm read
 * far more per-message clusters than its mirror held rows).
 */
function adapterOf(messages, onPage) {
  const total = messages.length;
  drained = () => messages.length === 0;
  let served = 0;
  let seq = 0;
  let pageNo = 0;
  return {
    sync: async () => {
      const slice = messages.splice(0, PAGE);
      served += slice.length;
      pageNo += 1;
      const creates = slice.map((m) => ({
        type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
      }));
      // A settle every `SETTLE_EVERY` pages models a door that has run out of rows because the
      // import behind it is still running — the first-import shape.
      const hasMore = served < total
        && (SETTLE_EVERY <= 0 || pageNo % SETTLE_EVERY !== 0);
      if (onPage) await onPage(served, hasMore);
      return {
        changes: { creates, updates: [], moves: [], deletes: [] },
        cursor: String(seq), hasMore, serverTime: NOW.toISOString(),
      };
    },
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async (id) => ({ text: bodyText(id), html: null, loadedRemoteContent: false }),
    fetchBodies: async (ids) => ids.map((id) => ({
      messageId: id, text: bodyText(id), html: null, loadedRemoteContent: false,
    })),
  };
}

const mb = (n) => Math.round(n / (1024 * 1024));
const collect = () => { if (typeof global.gc === "function") { global.gc(); global.gc(); } };
const rss = () => process.memoryUsage().rss;
const heapUsed = () => process.memoryUsage().heapUsed;

const policy = POLICY === "full"
  ? { mode: "full" }
  : { mode: "windowed", days: DAYS, minRows: MIN_ROWS, ...(MAX_ROWS > 0 ? { maxRows: MAX_ROWS } : {}) };

const messages = corpus();
const corpusSize = messages.length;
/** How many of the corpus's messages are inside `days` — the settled window's size, before any ceiling. */
const inWindow = messages.reduce(
  (n, m) => (Date.parse(m.date) >= NOW.getTime() - DAYS * 86_400_000 ? n + 1 : n), 0);

const store = new MemoryMirrorStore();
const samples = [];
let peakRss = 0;
let peakRows = 0;
let pages = 0;

const engine = new OhmailEngine({
  adapter: adapterOf(messages, async (served, hasMore) => {
    pages += 1;
    const r = rss();
    if (r > peakRss) peakRss = r;
    if (SNAPSHOT && SNAPSHOT_AT === "import" && !hasMore) {
      // The LAST page of the backlog, before its own rows land and before the settle's prune:
      // `drain()` skips `pruneToPolicy` on every `hasMore` page, so the mirror is whole here and
      // nowhere later. Snapshot and exit — a picture taken after the prune is of another heap.
      const rowsAtPeak = store.entries("message").length;
      collect();
      const v8 = await import("node:v8");
      v8.writeHeapSnapshot(SNAPSHOT);
      console.log(JSON.stringify({ phase: "import", rowsAtPeak, rssMb: mb(rss()), heapMb: mb(heapUsed()), snapshot: SNAPSHOT }));
      process.exit(0);
    }
    if (pages % SAMPLE_EVERY === 0 || !hasMore) {
      // `entries()` is what every whole-mirror selector calls; one per bump is the shell's own
      // reaction shape, not an instrument the product does not have.
      const rows = store.entries("message").length;
      if (rows > peakRows) peakRows = rows;
      samples.push({ page: pages, served, rows, rssMb: mb(r), heapMb: mb(heapUsed()) });
    }
  }),
  store,
  now: () => NOW,
  storePolicy: policy,
  eagerBodies: EAGER,
});

// `start()` hydrates and drains; the first import happens inside it, so the clock starts before
// it and `syncOnce()` below is the belt for an embedder whose start does not drain.
const t0 = performance.now();
let derivations = 0;
let settles = 0;
if (DERIVE) {
  engine.subscribe(() => {
    derivations += 1;
    const pres = presentationReader(store, consentPartition(store, { now: NOW, ownAddresses: OWN }));
    // Read the projection the way the piles do, so the derivation is not dead-code-eliminated.
    kept += pres.list("message").length > 0 ? 1 : 0;
  });
}
await engine.start();
// One `syncOnce()` per settle, and the scheduler's eager kick after each — that is the shell's own
// loop (sync-scheduler.ts fires `prefetchRecentBodies()` from the one place that knows a drain
// settled cleanly), and running it here is what makes the first-import shape measurable at all.
for (;;) {
  await engine.syncOnce();
  settles += 1;
  if (SETTLE_EVERY > 0) {
    await engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();
  }
  const r = rss();
  if (r > peakRss) peakRss = r;
  const rows = store.entries("message").length;
  if (rows > peakRows) peakRows = rows;
  if (feedDrained()) break;
  if (settles > 1000) break;
}
const importMs = Math.round(performance.now() - t0);

const settledRows = store.entries("message").length;
const settledRss = rss();
if (settledRss > peakRss) peakRss = settledRss;

// THE NEXT POLL AFTER THE IMPORT. An empty drain that settles in one page — which is what the
// shell issues seconds later, and what tells the engine the catch-up is over. Without it the rig
// would report the eager pass as never having run, which is a fact about the rig's last call and
// not about the product.
await engine.syncOnce();
// The scheduler's pass, fired from the one place that knows a drain settled cleanly.
const t1 = performance.now();
await engine.prefetchRecentBodies();
await engine.eagerBodiesIdle();
const eagerMs = Math.round(performance.now() - t1);
const eagerRss = rss();
if (eagerRss > peakRss) peakRss = eagerRss;
const bodies = store.entries("message_body").length;

collect();
const afterRss = rss();
const afterHeap = heapUsed();

if (SNAPSHOT && SNAPSHOT_AT !== "import") {
  // ITS OWN RUN, never inside the sampling loop: `writeHeapSnapshot` in there put RSS at 29 GB in
  // one tail of the previous measurement (§5).
  const v8 = await import("node:v8");
  v8.writeHeapSnapshot(SNAPSHOT);
}

const report = {
  policy, corpus: corpusSize, inWindow, pages, pageSize: PAGE,
  eagerBodiesMax: EAGER_BODIES_MAX, bodiesHeld: bodies,
  importMs, eagerMs, derivations, derivedNonEmpty: kept, settles, settleEvery: SETTLE_EVERY, order: ORDER,
  peakRowsDuringImport: peakRows,
  settledRows,
  peakRssMb: mb(peakRss),
  settledRssMb: mb(settledRss),
  afterEagerRssMb: mb(eagerRss),
  afterCollectRssMb: mb(afterRss),
  afterCollectHeapMb: mb(afterHeap),
  samples,
};
console.log(JSON.stringify(report));
if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
