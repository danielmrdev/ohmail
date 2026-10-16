/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { HttpAdapter } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { HeldUnsubscribe } from "../app/views/ScreenerView";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE PREVIEW SAYS WHAT THE LIST ANSWERED. The press goes through the real
 * `HttpAdapter` over the route's own wire: a list that refused reads as refused with the sender's
 * link and no press left; a list that failed, or a press that never reached ohmail, keeps its
 * button. Read from the rendered text and the rendered controls.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

type Answer = { status: number; body: unknown } | "offline";
const json = (status: number, body: unknown): Answer => ({ status, body });
const refusal = (code: string, retryable: boolean | undefined, details: Record<string, unknown>) =>
  json(409, { error: { code, message: "server English", details, ...(retryable === undefined ? {} : { retryable }) } });

async function mount(answers: Answer[]): Promise<{ calls: () => number }> {
  let calls = 0;
  const adapter = new HttpAdapter({
    baseUrl: "http://api.test",
    getCookie: () => null,
    fetch: async () => {
      const a = answers[Math.min(calls, answers.length - 1)]!;
      calls += 1;
      if (a === "offline") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en", messages: en,
        children: React.createElement(HeldUnsubscribe, {
          state: "one_click", url: null, onUnsubscribe: () => adapter.unsubscribe("m1"),
        }),
      }),
    );
  });
  return { calls: () => calls };
}

async function press(): Promise<void> {
  const button = host!.querySelector("button");
  expect(button, "a press must be on screen to press").not.toBeNull();
  await act(async () => { button!.click(); });
  await settleFirstPaint();
}

const S = en.screener;

describe("the Screened-out preview after a one-click press", () => {
  it("a list that refused reads as refused, offers the sender's site, and leaves no press", async () => {
    await mount([refusal("unsubscribe_list_refused", false, { status: 405, siteUrl: "https://list.example/leave?t=1" })]);
    await press();
    const text = host!.textContent ?? "";
    expect(text).toContain(S.unsubListRefused);
    expect(text, "a refused request may not read as done").not.toContain(S.unsubAlready);
    const link = host!.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://list.example/leave?t=1");
    expect(link?.textContent).toBe(S.unsubExternal);
    expect(host!.querySelector("button"), "the list answered; asking again changes nothing").toBeNull();
  });

  it("a link that is not https is never drawn", async () => {
    await mount([refusal("unsubscribe_list_refused", false, { status: 405, siteUrl: "javascript:alert(1)" })]);
    await press();
    expect(host!.textContent).toContain(S.unsubListRefused);
    expect(host!.querySelector("a")).toBeNull();
  });

  it("a list that failed says so and keeps its press, and the retry is a real second request", async () => {
    const m = await mount([
      refusal("unsubscribe_list_failed", true, { status: 500 }),
      json(200, { messageId: "m1", posted: true, status: 200, refusal: null, header: "one_click" }),
    ]);
    await press();
    expect(host!.textContent).toContain(S.unsubListFailed);
    await press();
    expect(m.calls()).toBe(2);
    expect(host!.textContent).toContain(S.unsubSent);
  });

  it("a press that never reached ohmail keeps its press", async () => {
    await mount(["offline"]);
    await press();
    expect(host!.textContent).toContain("Something went wrong. Please try again.");
    expect(host!.querySelector("button"), "a failed press keeps its button").not.toBeNull();
  });
});
