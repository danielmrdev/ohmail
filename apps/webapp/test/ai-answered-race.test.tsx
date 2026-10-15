/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * ═══ TWO WAYS THE AI QUESTION COMES BACK AFTER IT WAS ANSWERED ══════════════════════════════
 *
 * Both found by the rationed max review of that change, and both are regressions that commit
 * introduced rather than pre-existing defects — which is why they are driven here rather than
 * pinned in source. They are the same shape as the re-run loop this lane opened with: a write
 * lands, the posture re-derives to `unset`, and the flow returns to the question it just asked.
 *
 *  1. **A PRE-0084 API.** The PATCH succeeds and omits `aiAnswered`, so reading the echo strictly
 *     stored `false`. After a first-run "Yes" the cursor clears, the posture re-derives `unset`,
 *     and the AI screen comes back — indefinitely. The old client did not have this: its posture
 *     read `aiEnabled ? "on" : "unset"`, so "Yes" walked past. A SUCCESSFUL WRITE IS ITSELF THE
 *     ANSWER for the run it happened in, whatever the server can store.
 *  2. **THE BOOT READ, STILL IN THE AIR.** `aiSettings.get()` can have been issued before the
 *     press and resolve after the PATCH, carrying `aiAnswered: false` from before the write. Its
 *     setter was unconditional, so it overwrote the answer and reopened the question. This is the
 *     folders flag's own user-always-wins rule (`apps/mobile/src/state/folders-flag.ts`), which
 *     exists for exactly this settle-order race; the write marks itself BEFORE it leaves.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

/** Deferred so a test decides WHEN the boot read settles relative to the write. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const getMock = vi.fn();
const setMock = vi.fn();

vi.mock("../app/api-client", () => ({
  ApiError: class ApiError extends Error {},
  messageOf: () => null,
  aiSettings: { get: () => getMock(), set: (v: boolean) => setMock(v) },
  consent: { completeOnboarding: async () => undefined },
  mailboxes: { probe: async () => ({}), create: async () => ({ id: "m" }), organize: async () => ({ outcome: "authorized" }), remove: async () => undefined },
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

/** Mount the hook and expose its live posture plus its write verb. */
async function mount(): Promise<{ ai: () => string | undefined; write: (on: boolean) => Promise<void> }> {
  let host: ReturnType<typeof useCloudFirstRun>;
  const Probe = () => { host = useCloudFirstRun(false); return null; };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => { root.render(h(Probe, null)); });
  return {
    ai: () => host?.ai,
    write: async (on: boolean) => {
      await act(async () => { await host!.setAiEnabled!(on); });
    },
  };
}

describe("a pre-0084 API — the PATCH succeeds and cannot say it stamped anything", () => {
  it('"YES" IS AN ANSWER even when the server has nowhere to record it', async () => {
    // The old wire: both calls answer without `aiAnswered`.
    getMock.mockResolvedValue({ aiEnabled: true });
    setMock.mockResolvedValue({ aiEnabled: true, changed: false });
    const s = await mount();
    // Nobody has been asked yet: the switch rests `true` and that is not an answer.
    expect(s.ai()).toBe("unset");

    await s.write(true);
    // Reading the echo strictly stored `false` here, so the posture went back to `unset` and the
    // flow returned to the AI screen it had just left. For ever.
    expect(s.ai(), "a successful write left the posture unanswered").not.toBe("unset");
    expect(s.ai()).toBe("on");
  });

  it('…and so is "NO", which the same bug turned into a loop once the import finished', async () => {
    getMock.mockResolvedValue({ aiEnabled: true });
    setMock.mockResolvedValue({ aiEnabled: false, changed: true });
    const s = await mount();
    await s.write(false);
    expect(s.ai()).toBe("off");
  });

  it("CONTROL: a 0084 API is unaffected — the echo agrees with the write", async () => {
    getMock.mockResolvedValue({ aiEnabled: true, aiAnswered: false });
    setMock.mockResolvedValue({ aiEnabled: false, changed: true, aiAnswered: true });
    const s = await mount();
    expect(s.ai()).toBe("unset");
    await s.write(false);
    expect(s.ai()).toBe("off");
  });
});

describe("the boot read, still in the air when the answer is given", () => {
  it("A LATE `aiAnswered: false` MAY NOT REOPEN THE QUESTION", async () => {
    // The GET was issued at mount, read the account BEFORE the write, and settles after it.
    const boot = deferred<{ aiEnabled: boolean; aiAnswered: boolean }>();
    getMock.mockReturnValue(boot.promise);
    setMock.mockResolvedValue({ aiEnabled: false, changed: true, aiAnswered: true });
    const s = await mount();

    await s.write(false);
    expect(s.ai()).toBe("off");

    // …and NOW the boot read lands, carrying the state from before the press.
    await act(async () => {
      boot.resolve({ aiEnabled: true, aiAnswered: false });
      await Promise.resolve();
    });
    expect(s.ai(), "a read from before the write overwrote the answer").toBe("off");
  });

  it("CONTROL: with no write in flight the boot read still applies — it is not simply ignored", async () => {
    // Which is what says the guard is about ORDER and not about discarding the read.
    const boot = deferred<{ aiEnabled: boolean; aiAnswered: boolean }>();
    getMock.mockReturnValue(boot.promise);
    const s = await mount();
    expect(s.ai()).toBe("unset");
    await act(async () => {
      boot.resolve({ aiEnabled: false, aiAnswered: true });
      await Promise.resolve();
    });
    expect(s.ai(), "the boot read was discarded when nothing superseded it").toBe("off");
  });
});
