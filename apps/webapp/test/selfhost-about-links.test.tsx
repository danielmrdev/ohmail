/** @vitest-environment jsdom */
/**
 * ═══ SETTINGS → ABOUT, ON A SELF-HOST BUILD: NO LINK INTO A PAGE THIS BUILD REFUSES ═════════
 *
 * The self-host build does not serve the marketing or legal documents at all — they describe
 * the hosted service's controller, subprocessors and imprint, and on an origin its authors
 * neither run nor can see, each one is a false statement (`app/self-host-marketing.ts`).
 *
 * Refusing them turned every IN-APP link to one into a 404 on that build, and the signed-in app
 * had four. This pane held three of them. Caught by review, not by a suite — which is why the
 * behaviour is pinned here rather than left to the structural guard in
 * `selfhost-no-marketing.test.ts`: that guard reads the source and can only see that the flavor
 * is consulted, while this renders the real pane and reads the anchors that come out.
 *
 * ONE FLAVOR PER PROCESS, the same split `settings-devices-selfhost.test.tsx` uses: the flavor
 * is inlined at build time, so a file that needs the other arm is a different file. The managed
 * arm is asserted at the bottom by rendering the same component with the module graph reloaded
 * under no flavor — the pair is what makes this a gate rather than a deletion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
// THE FLAVOR, before any module under test loads — the test-side twin of the build inlining it.
process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // The pane asks for mailboxes on mount; an empty list is a fine install to render.
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
});

afterEach(() => {
  if (root) { const r = root; act(() => { r.unmount(); }); }
  host?.remove();
  root = null; host = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Mount a component under the providers the pane expects, and return the rendered anchors. */
async function anchorsOf(node: React.ReactElement): Promise<string[]> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  await act(async () => {
    /* `children` goes in the PROPS object, not as createElement's third argument: the
       provider's props type requires it, and the positional form does not satisfy the
       overload (webapp typechecks its tests, so this is a compile error, not a style note). */
    r.render(h(ThemeProvider, null, h(
      NextIntlClientProvider, { locale: "en", messages, children: node },
    )));
  });
  return [...host.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
}

/** The documents this build answers 404 for. A link to any of them is the defect. */
const REFUSED = ["/privacy", "/imprint", "/subprocessors", "/de"];

describe("SELF-HOST: the app never points at a document its own build refuses", () => {
  it("Settings → About drops the three legal links, and keeps the publisher facts", async () => {
    const { AboutSection } = await import("../app/(product)/mailbox/AboutSection");
    const hrefs = await anchorsOf(h(AboutSection));

    expect(hrefs.filter((href) => REFUSED.includes(href))).toEqual([]);

    // NOT a blanket deletion: who publishes the software is true on every deployment, and the
    // support address is the one way to reach them. Both stay, so the pane is still an About.
    expect(host!.textContent).toContain("TrafficFlow GmbH");
    expect(hrefs).toContain("mailto:support@ohmail.app");

    // The heading goes with the links — a section header over an empty block is its own lie.
    expect(host!.textContent).not.toContain(messages.about.yourMail);
  });

  it("MANAGED: the very same component keeps all three — this is a gate, not a removal", async () => {
    // Reload the graph with the flavor absent, exactly as the managed build compiles it.
    delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
    vi.resetModules();
    try {
      const { AboutSection } = await import("../app/(product)/mailbox/AboutSection");
      const hrefs = await anchorsOf(h(AboutSection));
      for (const route of ["/privacy", "/imprint", "/subprocessors"]) {
        expect(hrefs, `managed must still link ${route}`).toContain(route);
      }
      expect(host!.textContent).toContain(messages.about.yourMail);
    } finally {
      process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";
      vi.resetModules();
    }
  });
});
