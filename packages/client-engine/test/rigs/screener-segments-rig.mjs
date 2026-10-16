/**
 * WHAT THE SCREENER'S QUEUE COSTS THE WINDOW, over a real store and the real projection.
 *
 * A rig, not a test: it reports milliseconds, and a wall-clock assertion in a suite is a flake.
 * It drives the real `MemoryMirrorStore`, the real `consentPartition`/`presentationReader` and
 * the real `screenerSegments` from `dist` — the shell's own composition — so a figure here is the
 * renderer's JavaScript and nothing else (no React, no DOM). Every figure is a FLOOR for what the
 * window is charged.
 *
 *   node --expose-gc packages/client-engine/test/rigs/screener-segments-rig.mjs \
 *        --senders 400 --messages 5000 [--dist <dir>] [--json <path>]
 *
 * Run it from the repo root after `pnpm -r build`. It imports dist MODULES and not the barrel:
 * the package's exports map points at `src`, which a Node consumer cannot resolve (the documented
 * source-leaf hazard). `--dist` names a sibling build, which is how the two arms of a before/after
 * are measured in one process-pair rather than across a rebuild.
 *
 * THREE ARMS, because "one derivation" is three different questions:
 *   cold        the first derivation over a mailbox nothing has derived before
 *   incremental the derivation after a bump that touched k rows — the steady state of a drain
 *   same bump   a second caller on the same reader and version — what the version-keyed memo buys
 */
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const SENDERS = Number(arg("senders", 400));
const MESSAGES = Number(arg("messages", 5000));
const ZONE = arg("zone", "Europe/Zurich");
const LOCALE = arg("locale", "en");
const REPS = Number(arg("reps", 7));
const JSON_OUT = arg("json", "");
const PAGE = Number(arg("page", 500));
const BODIES = Number(arg("bodies", 1000));
/** How many rows one bump touches — a read-mark sweep, an arriving body batch, a moved page. */
const TOUCH = Number(arg("touch", 20));
/**
 * How much of the mailbox is AT THE GATE. The gap row's figure (a few hundred waiting senders over a
 * mailbox's presented messages) is this at 1: every presented message held by a waiting sender, which is
 * a mailbox whose backlog was never screened. The cost is carried by the HELD count, so this is
 * the knob the figure moves on.
 */
const GATE_SHARE = Number(arg("gate-share", 1));
const DIST = arg("dist", "dist");

const dist = (m) => new URL(`../../${DIST}/${m}`, import.meta.url).href;
const { MemoryMirrorStore } = await import(dist("store.js"));
const { consentPartition, presentationReader } = await import(dist("consent-cutline.js"));
const { screenerSegments } = await import(dist("selectors.js"));

/** Fixed, so two arms of one comparison see the identical corpus. */
const NOW = new Date("2026-09-12T09:00:00.000Z");
const DAY = 86_400_000;
const OWN = ["me@own.test"];

// ── the corpus ─────────────────────────────────────────────────────────────
/**
 * THE INCIDENT'S SHAPE, not a tidy one: `SENDERS` active undecided senders with mail at the gate
 * — those are the waiting rows — and a filler of senders a rule has already admitted, so the
 * partition PRESENTS them. (The trap in `DESKTOP-RENDERER-MAILBOX-SCALE.md` §5: an arm whose
 * cutline presents nothing measures an empty set, and reads four times faster for it.) Dates
 * spread over 80 days
 * so every stamp band is exercised. Deterministic from a fixed seed — `Math.random` would make
 * the two arms different mailboxes — and re-seeded per call, so a fresh corpus is byte-identical
 * data in FRESH entity objects, which is what makes a cold arm cold.
 */
function corpus() {
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };
  const messages = [];
  const rules = [];
  let n = 0;
  const mk = (id, from, folder, dayOffset, unread) => ({
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: from },
    to: [], cc: [],
    date: new Date(NOW.getTime() - dayOffset * DAY - Math.floor(rnd() * DAY)).toISOString(),
    folder,
    snippet: `snippet ${id} — a line of preview text the row renders`,
    unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: NOW.toISOString(),
  });

  const gateTotal = Math.round(MESSAGES * GATE_SHARE);
  // Uneven bags around the mean, so an off-by-one in the per-sender loop cannot pass for a
  // property: the bags run from 0.4× to 1.6× the mean.
  const meanBag = Math.max(1, gateTotal / SENDERS);
  for (let s = 0; s < SENDERS; s++) {
    const bag = Math.max(1, Math.round(meanBag * (0.4 + rnd() * 1.2)));
    for (let k = 0; k < bag; k++) {
      messages.push(mk(`w${s}-${k}`, `waiting${s}@senders.test`, "ohmail/Screener",
        Math.floor(rnd() * 40), k === 0));
    }
    n += bag;
  }
  // Decided senders on the other two shelves, so the screened/spam arms are not empty.
  const shelfSenders = Math.max(1, Math.floor(SENDERS / 10));
  for (let s = 0; s < shelfSenders; s++) {
    messages.push(mk(`so${s}`, `screened${s}@senders.test`, "ohmail/Screened", 10 + Math.floor(rnd() * 60), false));
    messages.push(mk(`sp${s}`, `spam${s}@senders.test`, "ohmail/Quarantine", 10 + Math.floor(rnd() * 60), false));
    n += 2;
  }
  const fillerFolders = ["INBOX", "ohmail/News", "ohmail/Receipts"];
  const fillerSenders = Math.max(1, Math.floor(Math.max(1, MESSAGES - n) / 12));
  for (let s = 0; s < fillerSenders; s++) {
    rules.push({
      id: `r${s}`, kind: "sender", match: `friend${s}@senders.test`, destination: "INBOX",
      priority: 0, provenance: "seeded-from-sent", enabled: true,
      stats: { hits: 0, lastHitAt: null, demotions: 0 },
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
  }
  let s = 0;
  while (n < MESSAGES) {
    messages.push(mk(`f${n}`, `friend${s % fillerSenders}@senders.test`, fillerFolders[n % 3],
      Math.floor(rnd() * 80), n % 7 === 0));
    n++; s++;
  }
  return { messages, rules };
}

async function mirrorOf({ messages, rules }) {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  const all = [
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
  ];
  // ONE PAGE PER DRAIN CALL, the way a real import arrives — a single applyChanges over the whole
  // mailbox leaves a one-row curve and reports one bump for a whole import.
  let pages = 0;
  for (let i = 0; i < all.length; i += PAGE) {
    await store.applyChanges(all.slice(i, i + PAGE));
    pages++;
  }
  return { store, pages, seq };
}

/**
 * THE EAGER PASS'S BODIES. `heldOf` reads one per held message (`bodyOf`), so a mirror with no
 * bodies measures the cheap branch of a function the product runs on the expensive one.
 */
async function hydrate(store, messages, count) {
  const newest = [...messages].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, count);
  for (const m of newest) {
    await store.putLocal("message_body", m.id, {
      state: "ready", text: `${m.snippet} — the whole message, as the reading pane renders it.`,
      html: `<div><p>${m.snippet}</p></div>`, loadedRemoteContent: false,
      unsubscribe: "no_header", unsubscribeUrl: null, withheld: null,
    });
  }
  return newest.length;
}

/** The shell's own composition: one partition, one projection, per bump. */
function presentOf(store) {
  return presentationReader(store, consentPartition(store, { now: NOW, ownAddresses: OWN }));
}
const derive = (reader) => screenerSegments(reader, NOW, LOCALE, ZONE, OWN);

const collect = () => { if (typeof global.gc === "function") { global.gc(); global.gc(); } };
const stat = (runs) => {
  const r = [...runs].sort((a, b) => a - b);
  return { min: r[0], median: r[Math.floor(r.length / 2)], max: r[r.length - 1] };
};
const fmt = (n) => (n < 1 ? n.toFixed(2) : n.toFixed(1));

// ── the shape report, from one build ───────────────────────────────────────
const c0 = corpus();
const { store: s0, pages, seq: seq0 } = await mirrorOf(c0);
const hydrated = await hydrate(s0, c0.messages, BODIES);
const p0 = presentOf(s0);
const seg0 = derive(p0);
const heldTotal = [seg0.waiting, seg0.screenedOut, seg0.spam]
  .reduce((n, rows) => n + rows.reduce((k, w) => k + w.held.length, 0), 0);

// ── ARM 1: COLD ────────────────────────────────────────────────────────────
// A fresh store per rep, so the entities are fresh objects and nothing this process derived
// before can be reused. Same seed ⇒ byte-identical data.
const coldRuns = [];
for (let i = 0; i < REPS; i++) {
  const c = corpus();
  const { store } = await mirrorOf(c);
  await hydrate(store, c.messages, BODIES);
  const pres = presentOf(store);
  collect();
  const t = performance.now();
  derive(pres);
  coldRuns.push(performance.now() - t);
}

// ── ARM 2: INCREMENTAL — the derivation after a bump that touched TOUCH rows ─
// One warmed store; each rep marks TOUCH *different* held messages read (a real `/sync` update:
// a new entity object per touched id, every other row's object unchanged), rebuilds the
// partition and the projection the way the shell does, and derives.
const gateIds = c0.messages.filter((m) => m.folder === "ohmail/Screener").map((m) => m.id);
const byId = new Map(c0.messages.map((m) => [m.id, m]));
let seq = seq0;
const incRuns = [];
for (let i = 0; i < REPS; i++) {
  const slice = gateIds.slice(i * TOUCH, (i + 1) * TOUCH);
  await s0.applyChanges(slice.map((id) => ({
    type: "message", op: "update", id, seq: ++seq, updatedAt: NOW.toISOString(),
    entity: { ...byId.get(id), unread: false },
  })));
  const pres = presentOf(s0);
  collect();
  const t = performance.now();
  derive(pres);
  incRuns.push(performance.now() - t);
}

// ── ARM 3: SAME BUMP — a second caller on the same reader and version ───────
const presSame = presentOf(s0);
derive(presSame);
const sameRuns = [];
for (let i = 0; i < REPS; i++) {
  collect();
  const t = performance.now();
  derive(presSame);
  sameRuns.push(performance.now() - t);
}

const cold = stat(coldRuns), inc = stat(incRuns), same = stat(sameRuns);
const report = {
  dist: DIST, node: process.version, senders: SENDERS, messages: MESSAGES, gateShare: GATE_SHARE,
  zone: ZONE, locale: LOCALE, reps: REPS, touch: TOUCH,
  mirrorRows: s0.list("message").length,
  presentedRows: p0.list("message").length,
  waitingRows: seg0.waiting.length, screenedRows: seg0.screenedOut.length, spamRows: seg0.spam.length,
  heldTotal, hydratedBodies: hydrated, drainPages: pages, versionBumps: s0.version(),
  cold, incremental: inc, sameBump: same,
};
console.log([
  `dist              ${DIST}`,
  `corpus            ${report.mirrorRows} mirror rows · ${report.presentedRows} presented · ${seg0.waiting.length} waiting senders · ${heldTotal} held messages`,
  `drain             ${pages} pages · ${hydrated} hydrated bodies · ${report.versionBumps} version bumps`,
  `cold              min ${fmt(cold.min)} ms · median ${fmt(cold.median)} ms · max ${fmt(cold.max)} ms`,
  `incremental (${TOUCH})  min ${fmt(inc.min)} ms · median ${fmt(inc.median)} ms · max ${fmt(inc.max)} ms`,
  `same bump         min ${fmt(same.min)} ms · median ${fmt(same.median)} ms · max ${fmt(same.max)} ms`,
].join("\n"));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
