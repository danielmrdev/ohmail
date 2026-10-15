/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { ViewBoundary } from "../app/shell/ViewBoundary";
import { ViewFailCard } from "../app/shell/ViewFailCard";

/**
 * the in-pane error card carries what a report needs. Every recurring incident starts
 * with "it just shows an error": the card now shows the build id beside the view name and can
 * copy them with the error's CLASS in one press. Never the message — a thrown value can hold
 * whatever the view was rendering when it threw — and the clipboard write may be refused at
 * any time, so a denied or absent clipboard is a no-op, not a second throw.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const SECRET = "Subject: Anna's invoice — do not forward";

function Throws(): React.ReactElement {
  throw new TypeError(SECRET);
}

let roots: Root[] = [];

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() =>
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: node,
      } as React.ComponentProps<typeof NextIntlClientProvider>) as React.ReactElement,
    ),
  );
  return host;
}

const boundary = (): React.ReactElement =>
  h(ViewBoundary, {
    fallback: (error: unknown) => h(ViewFailCard, { view: "ohbox", error }),
    children: h(Throws),
  });

describe("the in-pane error card", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the build id and the view beside the sentence, and the reload stays", async () => {
    const host = await render(boundary());
    expect(host.textContent).toContain("This view didn't load.");
    expect(host.textContent).toContain("Reload");
    // NEXT_PUBLIC_BUILD is not inlined in tests, so `buildId()` truthfully answers "build dev".
    expect(host.querySelector(".page-fail-fact code")?.textContent).toBe("TypeError · build dev · view ohbox");
  });

  it("copies the error class, the build id and the view — and never the message", async () => {
    const written: string[] = [];
    const writeText = vi.fn(async (s: string) => { written.push(s); });
    vi.stubGlobal("navigator", { ...window.navigator, clipboard: { writeText } });

    const host = await render(boundary());
    const press = [...host.querySelectorAll("button")].find((b) => b.textContent === "Copy details");
    expect(press).toBeDefined();
    await act(async () => { press!.click(); });

    expect(written).toEqual(["TypeError · build dev · view ohbox"]);
    expect(written[0]).not.toContain(SECRET);
    expect(press!.textContent).toBe("Copied");
  });

  it("a clipboard this context refuses is a no-op, never a second throw", async () => {
    vi.stubGlobal("navigator", { ...window.navigator, clipboard: undefined });
    const host = await render(boundary());
    const press = [...host.querySelectorAll("button")].find((b) => b.textContent === "Copy details");
    await act(async () => { press!.click(); });
    // The card stands, the label did not lie about a copy that never happened.
    expect(press!.textContent).toBe("Copy details");
    expect(host.textContent).toContain("This view didn't load.");
  });

  it("a thrown string is named by type, its payload never rendered or copied", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", {
      ...window.navigator,
      clipboard: { writeText: vi.fn(async (s: string) => { written.push(s); }) },
    });
    function ThrowsString(): React.ReactElement {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the shape under test
      throw SECRET;
    }
    const host = await render(
      h(ViewBoundary, {
        fallback: (error: unknown) => h(ViewFailCard, { view: "reads", error }),
        children: h(ThrowsString),
      }),
    );
    expect(host.textContent).not.toContain(SECRET);
    const press = [...host.querySelectorAll("button")].find((b) => b.textContent === "Copy details");
    await act(async () => { press!.click(); });
    expect(written).toEqual(["string · build dev · view reads"]);
  });

  it("both catalogues carry the press's words", () => {
    const en = (messages as { viewError: Record<string, string> }).viewError;
    const deKeys = (de as { viewError: Record<string, string> }).viewError;
    expect(en.copyDetails).toBe("Copy details");
    expect(en.copied).toBe("Copied");
    expect(deKeys.copyDetails).toBe("Details kopieren");
    expect(deKeys.copied).toBe("Kopiert");
  });
});
