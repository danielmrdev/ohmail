import { createHash } from "node:crypto";

/**
 * The seeded MIME tree generator the section corpus is cut from: a port of the dependency
 * advisory's measurement generator, every random draw and counter step in its original order, so
 * seed 2026 rebuilds the same 400 trees. Each leaf carries distinct deterministic bytes, so a
 * section is identified by its sha256. Synthetic: example.com and example.org only.
 */

export type GenNode =
  | { kind: "leaf"; leaf: LeafKind; head: string[]; body: string }
  | { kind: "multi"; sub: string; boundary: string; parts: GenNode[] }
  | { kind: "rfc822"; disp: string; inner: GenNode };
export type LeafKind = "text" | "html" | "pdf" | "zip" | "png-att" | "png-cid";

export interface GenTree { index: number; root: GenNode; raw: Buffer }

/** The trees for `seed`, in generation order. */
export function generateTrees(seed: number, count: number): GenTree[] {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  let uniq = 0;
  const bytes = (n: number): Buffer => {
    const label = `leaf-${++uniq}`;
    const out = Buffer.alloc(n);
    let h = createHash("sha256").update(label).digest();
    for (let i = 0; i < n; i += 32) { h.copy(out, i, 0, Math.min(32, n - i)); h = createHash("sha256").update(h).digest(); }
    return out;
  };
  const b64 = (buf: Buffer): string => buf.toString("base64").replace(/.{1,76}/g, (l) => `${l}\r\n`);
  const FILES: Record<string, [string, (id: number) => string, (id: number) => string[], string]> = {
    pdf: ["application/pdf", (id) => `f${id}.pdf`, () => [], "attachment"],
    zip: ["application/zip", (id) => `f${id}.zip`, () => [], "attachment"],
    "png-att": ["image/png", (id) => `f${id}.png`, () => [], "attachment"],
    "png-cid": ["image/png", (id) => `c${id}.png`, (id) => [`Content-ID: <c${id}@gen>`], "inline"],
  };
  const genLeaf = (): GenNode => {
    const k = pick(["text", "html", "pdf", "pdf", "zip", "png-att", "png-cid"] as const);
    const id = ++uniq;
    if (k === "text") return { kind: "leaf", leaf: k, head: ["Content-Type: text/plain; charset=utf-8"], body: `text ${id}\r\n` };
    if (k === "html") return { kind: "leaf", leaf: k, head: ["Content-Type: text/html; charset=utf-8"], body: `<p>html ${id}</p>\r\n` };
    const [type, name, extra, disp] = FILES[k]!;
    const head = [`Content-Type: ${type}; name="${name(id)}"`, "Content-Transfer-Encoding: base64", ...extra(id), `Content-Disposition: ${disp}; filename="${name(id)}"`];
    const size = 200 + Math.floor(rnd() * 600);
    return { kind: "leaf", leaf: k, head, body: b64(bytes(size)) };
  };
  const genMulti = (depth: number, sub?: string): GenNode => {
    const n = 1 + Math.floor(rnd() * 4);
    const subtype = sub ?? pick(["mixed", "mixed", "alternative", "related"]);
    const boundary = `b${++uniq}x`;
    return { kind: "multi", sub: subtype, boundary, parts: Array.from({ length: n }, () => genNode(depth + 1)) };
  };
  const genRfc822 = (depth: number): GenNode => {
    const disp = pick(["attachment", "attachment", "inline", "inline", "none"]);
    const inner = rnd() < 0.4 ? genLeaf() : genMulti(depth + 1);
    return { kind: "rfc822", disp, inner };
  };
  const genNode = (depth: number): GenNode => {
    const r = rnd();
    if (depth >= 4 || r < 0.55) return genLeaf();
    if (r < 0.85) return genMulti(depth);
    return genRfc822(depth);
  };
  const HEAD = (id: string | number): string[] => [
    "From: Alice <alice@example.com>", "To: Bob <bob@example.org>", `Subject: gen ${id}`,
    "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <gen${id}@deps026.test>`, "MIME-Version: 1.0",
  ];
  const render = (node: GenNode): string => {
    if (node.kind === "leaf") return [...node.head, "", node.body].join("\r\n");
    if (node.kind === "multi") {
      return [`Content-Type: multipart/${node.sub}; boundary="${node.boundary}"`, "",
        ...node.parts.map((p) => `--${node.boundary}\r\n${render(p)}`), `--${node.boundary}--`, ""].join("\r\n");
    }
    const h = ["Content-Type: message/rfc822", "Content-Transfer-Encoding: 7bit", ...(node.disp === "none" ? [] : [`Content-Disposition: ${node.disp}`])];
    return [...h, "", `${HEAD(`r${++uniq}`).join("\r\n")}\r\n${render(node.inner)}`].join("\r\n");
  };
  const out: GenTree[] = [];
  for (let i = 0; i < count; i += 1) {
    const root = rnd() < 0.1 ? genLeaf() : genMulti(0, pick(["mixed", "mixed", "mixed", "related", "alternative"]));
    out.push({ index: i, root, raw: Buffer.from(`${HEAD(i).join("\r\n")}\r\n${render(root)}`.replace(/\r?\n/g, "\r\n")) });
  }
  return out;
}

/** A tree's shape class: structure, rfc822 dispositions, and each leaf as body text, file or cid. */
export function shapeClass(node: GenNode): string {
  if (node.kind === "leaf") return node.leaf === "text" || node.leaf === "html" ? "t" : node.leaf === "png-cid" ? "c" : "f";
  if (node.kind === "multi") return `${node.sub}(${node.parts.map(shapeClass).join(",")})`;
  return `R${node.disp}[${shapeClass(node.inner)}]`;
}

/** Does the tree carry an inline 7bit rfc822 — the one mailparser descends into? */
export function hasDescendedRfc822(node: GenNode): boolean {
  if (node.kind === "leaf") return false;
  if (node.kind === "multi") return node.parts.some(hasDescendedRfc822);
  return node.disp === "inline" || hasDescendedRfc822(node.inner);
}
