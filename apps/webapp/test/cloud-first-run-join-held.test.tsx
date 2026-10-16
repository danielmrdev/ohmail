/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * THE HOSTED DOOR'S `held` REACHES SETUP AS "held" (TAKEOVER-DOORS-CANNOT-REFUSE-HELD). A join over a
 * live holder answers `409 organized_elsewhere` with nothing written; the web host must hand setup
 * "held" so it re-reads and asks the claim question, as the desktop's local door already does. To
 * watch it fail: drop the 409 arm in `useCloudFirstRun`'s `organize`.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

class FakeApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const organizeMock = vi.fn();

vi.mock("../app/api-client", () => ({
  ApiError: FakeApiError,
  codeOf: () => null,
  messageOf: () => null,
  aiSettings: { get: async () => ({ aiEnabled: true, aiAnswered: true }), set: async () => ({ aiEnabled: true }) },
  consent: { completeOnboarding: async () => undefined },
  mailboxes: {
    probe: async () => ({}), create: async () => ({ id: "m" }), remove: async () => undefined,
    organize: (...args: unknown[]) => organizeMock(...args),
  },
}));
vi.mock("../app/hello", () => ({ SELF_HOST_BUILD: false, serverHello: async () => null }));
vi.mock("../app/(product)/mailbox/MailboxSection", () => ({ probeReasonOf: () => null }));

const { useCloudFirstRun } = await import("../app/(product)/mailbox/useCloudFirstRun");

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function host(): Promise<NonNullable<ReturnType<typeof useCloudFirstRun>>> {
  const box: { host?: ReturnType<typeof useCloudFirstRun> } = {};
  const Probe = () => { box.host = useCloudFirstRun(false); return null; };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => { root.render(h(Probe, null)); });
  if (!box.host) throw new Error("the hosted first-run host did not mount");
  return box.host;
}

describe("the web first-run host reads the hosted door's held refusal", () => {
  it("409 organized_elsewhere is \"held\"", async () => {
    organizeMock.mockRejectedValue(new FakeApiError(409, "organized_elsewhere"));
    const hostNow = await host();
    expect(await hostNow.organize("m", { intent: "join" })).toBe("held");
  });

  it("CONTROL: an authorized press is stored, and any other refusal still throws", async () => {
    organizeMock.mockResolvedValueOnce({ outcome: "authorized" });
    const hostNow = await host();
    expect(await hostNow.organize("m", { intent: "join" })).toBe("stored");
    organizeMock.mockRejectedValueOnce(new FakeApiError(403, "step_up_required"));
    await expect(hostNow.organize("m", { intent: "join" })).rejects.toBeInstanceOf(FakeApiError);
    organizeMock.mockRejectedValueOnce(new FakeApiError(409, "conflict"));
    await expect(hostNow.organize("m", { intent: "join" })).rejects.toBeInstanceOf(FakeApiError);
  });
});
