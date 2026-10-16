/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ESTIMATED_ROW_PX,
  FALLBACK_VIEWPORT_PX,
  FULL_RANGE_MAX_ROWS,
  MEASURED_FULL_RANGE_MAX_ROWS,
  useListWindow,
} from "../app/shell/list-window";

/**
 * WHICH FLOOR A LIST GETS. A list whose items carry `data-index` is measured row by row, so it
 * windows above MEASURED_FULL_RANGE_MAX_ROWS — a switch into a few hundred rows mounts a
 * screenful. A list that stamps none could only be priced at one height, so it keeps rendering
 * whole up to FULL_RANGE_MAX_ROWS, the 0.19.2 bound. jsdom has no layout: the window runs on its
 * own fallbacks, imported, so a changed estimate cannot pass here by accident.
 */

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The rows a window at the top mounts: the fallback viewport's span plus the overscan below. */
const ROWS_AT_TOP = Math.floor(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_PX) + 1 + 8;

function List({ count, stamp }: { count: number; stamp: boolean }): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef, count });
  return (
    <div ref={scrollerRef} className="scroller">
      {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
      {Array.from({ length: win.end - win.start }, (_, k) => (
        <div key={win.start + k} className="row" data-id={`r${win.start + k}`} {...(stamp ? { "data-index": win.start + k } : {})} />
      ))}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
    </div>
  );
}

let roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) await act(() => r.unmount());
  roots = [];
  document.body.innerHTML = "";
});

async function mountList(count: number, stamp: boolean): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => root.render(<List count={count} stamp={stamp} />));
  return host;
}
const rowsOf = async (count: number, stamp: boolean): Promise<number> =>
  (await mountList(count, stamp)).querySelectorAll(".row").length;

describe("the window's floor follows what the list measures", () => {
  it("a stamped list longer than its window mounts the window, not the list", async () => {
    expect(ROWS_AT_TOP).toBeLessThan(480);
    expect(await rowsOf(480, true)).toBe(ROWS_AT_TOP);
  });

  it("a list that stamps no index renders whole up to the old bound, and windows past it", async () => {
    expect(await rowsOf(480, false)).toBe(480);
    expect(await rowsOf(FULL_RANGE_MAX_ROWS, false)).toBe(FULL_RANGE_MAX_ROWS);
    expect(await rowsOf(FULL_RANGE_MAX_ROWS + 1, false)).toBe(ROWS_AT_TOP);
  });

  it(`a stamped list of ${MEASURED_FULL_RANGE_MAX_ROWS} rows renders whole, and a longer one windows`, async () => {
    expect(await rowsOf(MEASURED_FULL_RANGE_MAX_ROWS, true)).toBe(MEASURED_FULL_RANGE_MAX_ROWS);
    const over = await rowsOf(MEASURED_FULL_RANGE_MAX_ROWS + ROWS_AT_TOP, true);
    expect(over).toBe(ROWS_AT_TOP);
  });

  it("a measured list is the scroller's one anchor: the browser's own anchoring is off there", async () => {
    const anchorOf = async (stamp: boolean) =>
      ((await mountList(480, stamp)).querySelector(".scroller") as HTMLElement).style.overflowAnchor;
    expect(await anchorOf(true)).toBe("none");
    expect(await anchorOf(false), "a list that stamps nothing keeps the browser's anchoring").toBe("");
  });
});
