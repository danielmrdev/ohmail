/** @vitest-environment jsdom */
/**
 * ═══ NO SUBSCRIPTION PANE ON A SELF-HOST BUILD ═══
 *
 * `useManageOffer` used to read "does a subscription page exist" off `GET /account/access`'s
 * `metered`, and that premise died when the self-host route table declared its explicit mailbox
 * allowance (`routes/self-host.ts`): `accessFor` answers non-null there, `metered` reads true,
 * and a self-host install grew a Subscription tab with a Manage control over nothing (frame
 * s5-34). The managed/billing boundary lives in the private plane; no billing UI reaches a
 * self-host surface. The gate is the compiled flavor — the same `SELF_HOST_BUILD` every other
 * self-host branch reads — so the offer is dead code there no matter what the server answers.
 *
 * Two arms, deliberately: the self-host refusal AND the managed admit — a gate that refused
 * both would be the pane deleted, not bounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let calls: string[] = [];
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  // Every route this test's world has answers `metered: true` — the self-host arm must refuse
  // the offer WITHOUT the server's help, because the server's answer is what regressed.
  globalThis.fetch = vi.fn(async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ metered: true, canAddMailbox: true, mailboxes: 1, aiEnabled: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
});

/** Mount a probe around the hook AFTER the flavor is set — `hello.ts` reads it at import. */
async function probeOffer(): Promise<{ offered: () => boolean }> {
  vi.resetModules();
  const { useManageOffer } = await import("../app/(product)/mailbox/SubscriptionSection.js");
  let latest = false;
  function Probe() {
    const { manageOffered } = useManageOffer(false);
    latest = manageOffered;
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(Probe));
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { offered: () => latest };
}

describe("useManageOffer by flavor", () => {
  it("self-host: never offered, and the access read never leaves the hook", async () => {
    process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";
    const p = await probeOffer();
    expect(p.offered()).toBe(false);
    expect(calls.some((u) => u.includes("/account/access"))).toBe(false);
  });

  it("managed: the same metered answer still offers the pane (the admit arm)", async () => {
    process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "managed";
    const p = await probeOffer();
    expect(p.offered()).toBe(true);
    expect(calls.some((u) => u.includes("/account/access"))).toBe(true);
  });
});
