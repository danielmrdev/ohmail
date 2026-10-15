/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * "FILED AUTOMATICALLY" UNDER THE AUTO-APPLY SWITCH (row 140). The Screener's auto-apply files
 * obvious bulk and wrote its undo where nothing read it. The row states how many filings are still
 * in place, Review lists them, and Put back names exactly the messages pressed — one, or every one
 * shown — then re-reads, so what was put back leaves the list. No filings, no row.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as never;

interface Item { messageId: string; from: string; subject: string; to: string; filedAt: string }
let filed: Item[];
let undoBodies: unknown[];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  undoBodies = [];
  filed = [
    { messageId: "m1", from: "news@shop.test", subject: "Weekly deals", to: "ohmail/News", filedAt: "2026-09-28T10:00:00.000Z" },
    { messageId: "m2", from: "billing@shop.test", subject: "Your receipt", to: "ohmail/Receipts", filedAt: "2026-09-28T09:00:00.000Z" },
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, "");
    if (path === "/screener/auto-filed") return json({ items: filed, more: false, max: 100 });
    if (path === "/screener/auto-filed/undo") {
      const body = JSON.parse(String(init!.body)) as { messageIds: string[] };
      undoBodies.push(body);
      filed = filed.filter((i) => !body.messageIds.includes(i.messageId));
      return json({ putBack: body.messageIds, requested: [] });
    }
    return json({}, 404);
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };

async function mount(): Promise<void> {
  const { AutoFiledReview } = await import("../app/shell/AutoFiledReview.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, { storageKey: null, children: h(AutoFiledReview) }),
    }));
  });
  await flush();
}

const button = (label: string): HTMLButtonElement => {
  const hits = [...host!.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === label);
  if (hits.length !== 1) throw new Error(`${hits.length} buttons read "${label}"`);
  return hits[0] as HTMLButtonElement;
};
const press = async (b: HTMLElement) => { await act(async () => { b.click(); }); await flush(); };

describe("Filed automatically", () => {
  it("states the filings still in place and lists them on Review", async () => {
    await mount();
    expect(host!.textContent).toContain("2 messages filed out of your Screener for you.");
    expect(host!.querySelectorAll(".scn-autofiled-row")).toHaveLength(0);
    await press(button("Review"));
    const rows = [...host!.querySelectorAll(".scn-autofiled-row")].map((r) => r.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Weekly deals");
  });

  it("Put back names the one message pressed, and it leaves the list on the re-read", async () => {
    await mount();
    await press(button("Review"));
    await press(host!.querySelectorAll<HTMLElement>(".scn-autofiled-row button")[0]!);
    expect(undoBodies).toEqual([{ messageIds: ["m1"] }]);
    expect(host!.querySelectorAll(".scn-autofiled-row")).toHaveLength(1);
    expect(host!.textContent).toContain("1 message goes back to your Screener.");
  });

  it("Put back all names every message shown", async () => {
    await mount();
    await press(button("Review"));
    await press(button("Put back all 2"));
    expect(undoBodies).toEqual([{ messageIds: ["m1", "m2"] }]);
    expect(host!.querySelector(".set-row"), "nothing left, no row").toBeNull();
  });

  it("draws nothing when nothing was filed, or the door has no such read (the control)", async () => {
    filed = [];
    await mount();
    expect(host!.querySelector(".set-row")).toBeNull();
    globalThis.fetch = (async () => json({ error: { code: "not_found" } }, 404)) as typeof fetch;
    if (root) await act(async () => { root!.unmount(); });
    host?.remove();
    await mount();
    expect(host!.querySelector(".set-row")).toBeNull();
  });
});
