/**
 * Where a German screen addresses its reader as "Sie": a capitalised Sie, Ihr… or Ihnen that does
 * not open a sentence. Inside a sentence the third person is lower-case, so a capital there is the
 * formal "you"; one that opens a sentence is left alone, because it is as often "it" or "their".
 * Reads the rendered text node by node, so the end of one paragraph is a sentence boundary.
 */
export function formalAddress(root: Node): string[] {
  const doc = root.ownerDocument ?? (root as Document);
  const walk = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const parts: string[] = [];
  for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) parts.push(n.textContent ?? "");
  const text = parts.join("\n");
  const found: string[] = [];
  for (const m of text.matchAll(/\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres|Ihnen)\b/g)) {
    const at = m.index ?? 0;
    const before = text.slice(0, at).replace(/[ \t„“"»«(]+$/u, "");
    if (before === "" || /[.!?:—–\n]$/u.test(before)) continue;
    found.push(text.slice(Math.max(0, at - 24), at + m[0].length + 24));
  }
  return found;
}
