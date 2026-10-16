import { Profiler, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * A RENDER LOOP IN THE SHELL SURFACES AS A SUITE TIMEOUT NAMING NOTHING.
 *
 * Measured twice by that change (2026-09-20): a true update loop planted in the composer
 * ran the file past four minutes to the suite's timeout with no assertion reached, and a
 * render-counter tripwire placed inside the tree did not fire either — React's own "Maximum update
 * depth exceeded" lands in `ViewBoundary`, which is what that boundary is FOR, so the throw is
 * caught, the fallback paints, and the only thing a reader gets is a clock. The lane removed the
 * tripwire rather than ship a guard it had watched not fire, and filed the row.
 *
 * This one counts COMMITS at the RENDERER ROOT — above every `ViewBoundary` in the tree — and
 * throws from there, where no boundary is left to swallow it. The message names the component and
 * the count, so the reading is "<ComposeView> committed 51 times in one window" rather than a
 * timeout.
 */

/* ONE CONSTANT, above every reading this suite has taken and below any loop. The composer's
 * measured cost is 2 renders per publish and the walk that measured it plants 50 deltas, so
 * a few hundred commits is the worst honest window; a loop passes it in milliseconds. */
export const RENDER_COMMIT_CEILING = 100;

export class RenderLoopError extends Error {
  constructor(
    readonly component: string,
    readonly commits: number,
    readonly ceiling: number,
  ) {
    super(
      `render loop: <${component}> committed ${commits} times in one window (ceiling ${ceiling}) — ` +
        "a component is scheduling state from its own render or effect. This throw is raised at the " +
        "renderer root, ABOVE every ViewBoundary, because a boundary catches the loop and leaves a timeout.",
    );
    this.name = "RenderLoopError";
  }
}

const counts = new Map<string, number>();
/* WHAT THE WINDOW RAISED, recorded rather than only thrown: React runs commit-phase callbacks
 * inside its own try/catch, so a caller can meet the unwind without meeting the error. The count
 * is never cleared on the way out — a tripwire that reset itself would let the same loop start
 * again on React's next attempt. */
const tripped = new Map<string, RenderLoopError>();

/** The window a count belongs to. Call it before each `act()` a test means as one window. */
export function resetRenderTripwire(): void {
  counts.clear();
  tripped.clear();
}

/** What the tripwire has seen since the last reset — for an arm that wants the number itself. */
export function renderCommits(component: string): number {
  return counts.get(component) ?? 0;
}

/** The error the tripwire raised in this window, for a caller React did not hand it to. */
export function lastRenderLoopError(): RenderLoopError | null {
  const first = tripped.values().next();
  return first.done ? null : first.value;
}

/* A component's own name, so the failure reads like the file a person will open. An element whose
 * type carries neither is named by what the caller passed, never by a guess. */
function nameOf(node: ReactNode, fallback: string): string {
  const el = node as { type?: unknown } | null;
  if (el && typeof el === "object" && "type" in el) {
    const t = el.type;
    if (typeof t === "string") return t;
    if (typeof t === "function" || typeof t === "object") {
      const named = t as { displayName?: string; name?: string };
      if (named.displayName) return named.displayName;
      if (named.name) return named.name;
    }
  }
  return fallback;
}

/**
 * Wrap a tree in the tripwire. The Profiler sits at the ROOT of what is handed to the renderer, so
 * nothing in `children` — least of all a `ViewBoundary` — is above it.
 */
export function withRenderTripwire(
  children: ReactNode,
  opts?: { id?: string; ceiling?: number },
): ReactElement {
  const id = opts?.id ?? nameOf(children, "root");
  const ceiling = opts?.ceiling ?? RENDER_COMMIT_CEILING;
  return createElement(
    Profiler,
    {
      id,
      onRender: () => {
        const n = (counts.get(id) ?? 0) + 1;
        counts.set(id, n);
        if (n > ceiling) {
          const err = new RenderLoopError(id, n, ceiling);
          tripped.set(id, err);
          throw err;
        }
      },
    },
    children,
  );
}

/**
 * The drop-in for a test's own `createRoot`: same object, and `render` puts the tripwire at the
 * root every time. A test that adopts this changes one import and nothing else.
 */
export function createRootWithTripwire(
  container: Element | DocumentFragment,
  opts?: { id?: string; ceiling?: number },
): Root {
  const root = createRoot(container);
  const inner = root.render.bind(root);
  return Object.assign(root, {
    render(children: ReactNode) {
      resetRenderTripwire();
      inner(withRenderTripwire(children, opts));
    },
  });
}
