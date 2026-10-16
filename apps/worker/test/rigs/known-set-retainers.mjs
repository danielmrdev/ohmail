/**
 * WHO HOLDS THE LOCATORS — read forward from every `KnownSetCache` in a heap snapshot.
 *
 *   node --max-old-space-size=8192 apps/worker/test/rigs/known-set-retainers.mjs <file>
 *
 * The class table in the desktop renderer's heap rig walks BACKWARDS to a root
 * and answers "what is keeping this alive". This is the other direction and the one the locator
 * budget's before/after needs: for each memo in the process, does it hold a projection, how long
 * is it, and what do the memo's own edges weigh. A bound is accepted on that — the retainer chain
 * before and after — never on a slope.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("known-set-retainers: pass the snapshot path");

const snap = JSON.parse(readFileSync(file, "utf8"));
const { node_fields: NFs, node_types: NTs, edge_fields: EFs, edge_types: ETs } = snap.snapshot.meta;
const NF = NFs.length, EF = EFs.length;
const nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
const fType = NFs.indexOf("type"), fName = NFs.indexOf("name");
const fSelf = NFs.indexOf("self_size"), fEdges = NFs.indexOf("edge_count");
const eType = EFs.indexOf("type"), eName = EFs.indexOf("name_or_index"), eTo = EFs.indexOf("to_node");
const count = nodes.length / NF;
const typeOf = (i) => NTs[0][nodes[i * NF + fType]];
const nameOf = (i) => strings[nodes[i * NF + fName]] ?? "";
const selfOf = (i) => nodes[i * NF + fSelf];

const start = new Uint32Array(count + 1);
for (let i = 0, acc = 0; i < count; i++) { start[i] = acc; acc += nodes[i * NF + fEdges]; start[i + 1] = acc; }

/** The named property edges of one node, as `{ name, to }`. */
function props(i) {
  const out = [];
  for (let e = start[i]; e < start[i + 1]; e++) {
    const t = ETs[0][edges[e * EF + eType]];
    if (t !== "property" && t !== "internal") continue;
    out.push({ name: strings[edges[e * EF + eName]] ?? "", to: edges[e * EF + eTo] / NF });
  }
  return out;
}
/** Every element of an array node, summed by self size — the projection's own weight. */
function arrayWeight(i) {
  let n = 0, bytes = selfOf(i);
  for (let e = start[i]; e < start[i + 1]; e++) {
    if (ETs[0][edges[e * EF + eType]] !== "element") continue;
    n++; bytes += selfOf(edges[e * EF + eTo] / NF);
  }
  return { elements: n, selfBytes: bytes };
}

const memos = [];
for (let i = 0; i < count; i++) {
  if (typeOf(i) !== "object" || nameOf(i) !== "KnownSetCache") continue;
  const p = props(i);
  const entries = p.find((x) => x.name === "entries");
  const index = p.find((x) => x.name === "tupleIndex");
  const holds = entries && typeOf(entries.to) === "object" && nameOf(entries.to).includes("Array");
  memos.push({
    self: selfOf(i),
    entries: holds ? arrayWeight(entries.to) : null,
    tupleIndex: index && typeOf(index.to) === "object" ? nameOf(index.to) : null,
  });
}

const warm = memos.filter((m) => m.entries !== null);
console.log(JSON.stringify({
  file,
  memos: memos.length,
  warm: warm.length,
  cold: memos.length - warm.length,
  locatorsHeld: warm.reduce((a, m) => a + m.entries.elements, 0),
  locatorSelfMib: Math.round(warm.reduce((a, m) => a + m.entries.selfBytes, 0) / 1048576 * 100) / 100,
  perMemo: memos.map((m) => (m.entries ? { entries: m.entries.elements, index: m.tupleIndex } : { entries: null })),
}, null, 1));
