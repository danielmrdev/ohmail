/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * WHAT A PERSON SEES WHEN THE APP THROWS — the three boundaries, rendered.
 *
 * Before them a throw above `ViewBoundary` — shell chrome, a provider, a route group's root
 * layout — unwound to Next's own "Application error": a blank tab with no sentence, no build
 * number and no way out, which is the admin-blank incident class. Each boundary owes the same
 * four things and they are asserted one by one: the mail is not lost, a way back, which build
 * this is, and the reference Next gave the reader to quote.
 */

// Set BEFORE the dynamic imports below: `app/build-id.ts` reads these at module load, exactly as
// the bundle does, so planting them here is what makes the rendered line a real reading.
process.env.NEXT_PUBLIC_APP_VERSION = "9.9.9";
process.env.NEXT_PUBLIC_BUILD = "abc1234";
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // React logs a caught render error loudly; the rendering is what is under test, not the log.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  document.cookie = "tf_owner=; Max-Age=0; path=/";
  vi.restoreAllMocks();
});

const text = (): string => host.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll("button")];
const labels = (): string[] => buttons().map((b) => b.textContent ?? "");

/* The element tree the boundary returns, read as markup: React 19 binds `<html>` and `<body>` to
   the document's own singletons, so a root inside a `div` shows neither element. */
const documentOf = (node: React.ReactElement): string => renderToStaticMarkup(node);

async function mountBare(node: React.ReactNode): Promise<void> {
  await act(async () => { root.render(node as React.ReactElement); });
}

async function mountInApp(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, children: h(ThemeProvider, { children: node }),
    }));
  });
}

const thrown = (digest?: string): Error & { digest?: string } =>
  Object.assign(new Error("a subject line nobody may read"), digest ? { digest } : {});

const NOOP = (): void => {};

describe("app/global-error.tsx — the last resort", () => {
  it("states that nothing is lost, offers a reload, and names the build", async () => {
    const { default: GlobalError } = await import("../app/global-error");
    await mountBare(h(GlobalError, { error: thrown("d19e57"), reset: NOOP }));

    expect(text()).toContain("ohmail hit an error.");
    expect(text()).toContain("Nothing is lost");
    expect(text()).toContain("your mail is on your mail server");
    // Both languages, because the thing that would have chosen one is what failed.
    expect(text()).toContain("Nichts ist verloren");
    expect(labels().some((l) => l.includes("Reload"))).toBe(true);
    expect(text()).toContain("9.9.9 · build abc1234");
  });

  it("writes its own document — it REPLACES the root layout when it fires", async () => {
    const { default: GlobalError } = await import("../app/global-error");
    const markup = documentOf(h(GlobalError, { error: thrown(), reset: NOOP }));
    expect(markup).toMatch(/^<html[\s>]/);
    expect(markup).toMatch(/<body[\s>]/);
  });

  it("renders the digest when there is one, and never the thrown message", async () => {
    const { default: GlobalError } = await import("../app/global-error");
    await mountBare(h(GlobalError, { error: thrown("d19e57"), reset: NOOP }));
    expect(text()).toContain("d19e57");
    expect(text()).toContain("Error reference");
    // THE REDACTION RULE. A thrown value can carry whatever the app had in hand.
    expect(text()).not.toContain("a subject line nobody may read");
  });

  it("with no digest it offers no reference at all, rather than an empty one", async () => {
    const { default: GlobalError } = await import("../app/global-error");
    await mountBare(h(GlobalError, { error: thrown(), reset: NOOP }));
    expect(text()).not.toContain("Error reference");
    // Still a sentence and still a way out — the digest is the only optional half.
    expect(text()).toContain("ohmail hit an error.");
    expect(labels().some((l) => l.includes("Reload"))).toBe(true);
  });
});

describe("app/error.tsx — a route group's root layout threw", () => {
  it("says the same four things with no layout, stylesheet or catalogue around it", async () => {
    const { default: RootError } = await import("../app/error");
    await mountBare(h(RootError, { error: thrown("f00d"), reset: NOOP }));

    expect(text()).toContain("ohmail hit an error.");
    expect(text()).toContain("Nichts ist verloren");
    expect(labels().some((l) => l.includes("Reload"))).toBe(true);
    expect(text()).toContain("9.9.9 · build abc1234");
    expect(text()).toContain("f00d");
    expect(text()).not.toContain("a subject line nobody may read");
  });

  it("carries its own stylesheet, because none reaches it", async () => {
    const { default: RootError } = await import("../app/error");
    await mountBare(h(RootError, { error: thrown(), reset: NOOP }));
    const style = host.querySelector("style");
    expect(style, "no <style>: this page renders above every layout that links one").not.toBeNull();
    expect(style!.textContent ?? "").toContain("prefers-color-scheme: dark");
  });

  /**
   * THE CASE THAT WAS MEASURED FAILING IN A REAL BROWSER. With no `app/layout.tsx` this boundary
   * renders at DOCUMENT level, and a document holds one element: returning a bare `<div>` threw
   * `HierarchyRequestError: Only one element on document allowed`, the report reached the console
   * and the tab stayed blank — the defect these files remove, arriving by another door. A build
   * cannot see it (rc 0 both ways) and neither can a test that only reads the text.
   */
  it("writes its own document, or the browser refuses to mount it at all", async () => {
    const { default: RootError } = await import("../app/error");
    const markup = documentOf(h(RootError, { error: thrown(), reset: NOOP }));
    expect(markup).toMatch(/^<html[\s>]/);
    expect(markup).toMatch(/<body[\s>]/);
  });
});

describe("app/(product)/error.tsx — the mail client's own", () => {
  it("takes its words from the catalogue and names the build", async () => {
    const { default: ProductError } = await import("../app/(product)/error");
    await mountInApp(h(ProductError, { error: thrown("beef01"), reset: NOOP }));

    expect(text()).toContain(messages.appError.title);
    expect(text()).toContain("your mail is on your mail server");
    expect(labels()).toContain(messages.appError.reload);
    expect(text()).toContain("9.9.9 · build abc1234");
    expect(text()).toContain("beef01");
    expect(text()).not.toContain("a subject line nobody may read");
  });

  /**
   * Two mounts and two ROOTS, not one root rendered twice: the marker is read in a mount effect
   * — it is invisible to the server, and reading it during a render would paint a control the
   * server's HTML did not have — and a second render into a live root never re-runs that effect.
   */
  it("offers no sign-out when this browser holds no session", async () => {
    const { default: ProductError } = await import("../app/(product)/error");
    await mountInApp(h(ProductError, { error: thrown(), reset: NOOP }));
    expect(labels()).not.toContain(messages.appError.signOut);
    expect(labels()).toContain(messages.appError.reload);
  });

  it("offers it when it does", async () => {
    document.cookie = "tf_owner=acct-1; path=/";
    const { default: ProductError } = await import("../app/(product)/error");
    await mountInApp(h(ProductError, { error: thrown(), reset: NOOP }));
    expect(labels()).toContain(messages.appError.signOut);
  });
});

describe("which build the page states", () => {
  it("names the release beside the sha, and invents NO release when none was inlined", async () => {
    vi.resetModules();
    const before = process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    try {
      const { buildId } = await import("../app/build-id");
      // NOT "dev · build abc1234": a wrong version number is worse than a missing one, because
      // it is quietly believed in the one moment somebody is reporting what they are running.
      expect(buildId()).toBe("build abc1234");
    } finally {
      process.env.NEXT_PUBLIC_APP_VERSION = before;
      vi.resetModules();
    }
  });
});
