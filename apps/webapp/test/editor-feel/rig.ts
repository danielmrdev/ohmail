/**
 * The rig's hands and eyes. Hands: real keys through `page.keyboard`; the ONE non-key act is
 * placing the caret at a document position (`caretAt`), which stands for a click. Eyes: what the
 * next keystroke would carry (`storedMarks ?? $from.marks()`, ProseMirror's own rule), the marks
 * on the character just typed, the toolbar's pressed states, and the selection/focus facts the
 * one-caret rule is about. Every read goes through `window.__rte`, which the harness sets.
 */
import type { Page } from "@playwright/test";
import { resolve } from "node:path";

/** The built page; `EDITOR_FEEL_OUT` points a run at a bundle built elsewhere (a mutation arm's). */
export const HARNESS = resolve(__dirname, "../../../..", process.env.EDITOR_FEEL_OUT ?? "build/editor-feel", "harness.html");

export interface CaretState {
  /** The document as html, the editor's own serialisation. */
  html: string;
  /** Marks the next typed character carries, by ProseMirror's own rule. */
  next: string[];
  /** Marks on the character before the caret (what was just typed), or null at a block start. */
  before: string[] | null;
  /** Marks on the character after the caret, or null at a block end. */
  after: string[] | null;
  /** Whether stored marks are set (a toggle pressed with nothing selected). */
  stored: string[] | null;
  /** Toolbar buttons by label → aria-pressed ("true"/"false"/absent). */
  pressed: Record<string, string | null>;
  /** One-caret facts. */
  rangeCount: number;
  collapsed: boolean;
  activeIsSurface: boolean;
  editables: number;
  gapcursors: number;
  pos: number;
  parent: string;
}

export async function openHarness(page: Page, q: { frame?: string; height?: number } = {}): Promise<void> {
  const params = new URLSearchParams();
  if (q.frame) params.set("frame", q.frame);
  if (q.height) params.set("height", String(q.height));
  await page.goto(`file://${HARNESS}?${params.toString()}`);
  await page.waitForFunction(() => window.__rte?.editor != null);
  await page.locator(".rte-surface").click();
}

/**
 * Tiptap's `focus()` defers the real DOM focus to the next animation frame; a key sent inside
 * that frame reaches an editor whose focus is still on its way (measured: a Ctrl+K sent at once
 * opened the dialog and the deferred focus then blurred it shut). Two frames is the person's gap.
 */
async function focusLanded(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/**
 * ProseMirror learns a native caret move from `selectionchange`, an ordinary task that Chromium
 * runs AFTER any input events already queued — Playwright's keys arrive sub-millisecond apart, a
 * person's tens of milliseconds. After an arrow key, wait until the document's own selection has
 * caught up with the DOM's before the next key, as a person's cadence does by itself.
 */
export async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ed = window.__rte.editor!;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount !== 1) return true;
    try {
      const pos = ed.view.posAtDOM(sel.focusNode!, sel.focusOffset);
      return pos === ed.state.selection.head;
    } catch {
      return true;
    }
  });
}

/** Replace the document (as the shell's `setContent` would) and put the caret at `pos`. */
export async function setDoc(page: Page, html: string, pos?: number): Promise<void> {
  await page.evaluate(([h, p]) => {
    const ed = window.__rte.editor!;
    ed.commands.setContent(h as string);
    if (typeof p === "number") ed.commands.focus(p); else ed.commands.focus("end");
  }, [html, pos ?? null] as const);
  await focusLanded(page);
}

export async function caretAt(page: Page, pos: number): Promise<void> {
  await page.evaluate((p) => { window.__rte.editor!.commands.focus(p); }, pos);
  await focusLanded(page);
}

/** The position just after the first run of `text` in the document, or before it. */
export async function posOf(page: Page, text: string, side: "start" | "end" = "end"): Promise<number> {
  return page.evaluate(([t, s]) => {
    const ed = window.__rte.editor!;
    let found = -1;
    ed.state.doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (node.isText && node.text!.includes(t as string)) {
        const i = node.text!.indexOf(t as string);
        found = pos + i + (s === "end" ? (t as string).length : 0);
        return false;
      }
      return true;
    });
    if (found < 0) throw new Error(`no text ${JSON.stringify(t)} in ${ed.getHTML()}`);
    return found;
  }, [text, side] as const);
}

export async function read(page: Page): Promise<CaretState> {
  return page.evaluate(() => {
    const ed = window.__rte.editor!;
    const { state } = ed;
    const $from = state.selection.$from;
    const names = (ms: readonly { type: { name: string } }[]) => ms.map((m) => m.type.name).sort();
    const next = names(state.storedMarks ?? $from.marks());
    const before = $from.nodeBefore ? names($from.nodeBefore.marks) : null;
    const after = $from.nodeAfter ? names($from.nodeAfter.marks) : null;
    const pressed: Record<string, string | null> = {};
    for (const b of document.querySelectorAll<HTMLButtonElement>(".rte-b")) {
      pressed[b.getAttribute("aria-label") ?? "?"] = b.getAttribute("aria-pressed");
    }
    const sel = document.getSelection();
    return {
      html: ed.getHTML(),
      next,
      before,
      after,
      stored: state.storedMarks ? names(state.storedMarks) : null,
      pressed,
      rangeCount: sel ? sel.rangeCount : -1,
      collapsed: sel ? sel.isCollapsed : false,
      activeIsSurface: document.activeElement === ed.view.dom,
      editables: document.querySelectorAll('[contenteditable="true"]').length,
      gapcursors: document.querySelectorAll(".ProseMirror-gapcursor").length,
      pos: $from.pos,
      parent: $from.parent.type.name,
    };
  });
}

/** The marks on the character at document position `pos` (the char that starts there). */
export async function marksAt(page: Page, pos: number): Promise<string[]> {
  return page.evaluate((p) => {
    const ed = window.__rte.editor!;
    const $p = ed.state.doc.resolve(p);
    const n = $p.nodeAfter;
    return n ? n.marks.map((m) => m.type.name).sort() : [];
  }, pos);
}

export const MOD = process.platform === "darwin" ? "Meta" : "Control";
