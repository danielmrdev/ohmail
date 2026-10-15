/** @vitest-environment jsdom */
/**
 * THE FACE'S ACCOUNT HALF, THROUGH THE SHIPPED SHELL (OHMARCHY-PLAN.md §3a) — the pieces no
 * component test can prove:
 *
 *  · adoption: a `GET /consent` carrying `themeFace` re-skins this device and mirrors the
 *    answer for the next boot's pre-paint stamp (the AppShell effect, the real one);
 *  · the Settings row's two scopes: the segmented control writes the DEVICE pin only, and
 *    "Apply on all devices" is one `PATCH /consent/settings {themeFace}` whose ECHO — not
 *    whose argument — becomes the adopted account face, with the pin cleared;
 *  · the Option B offer on a Linux device: appears only while nothing is chosen anywhere,
 *    one tap goes account-wide, dismissal is remembered, and an explicit prior choice
 *    keeps it away entirely.
 *
 * Mounted via the live-walk fixture — the same providers the Cloud entry uses — because the
 * measured failure mode of consent-adjacent UI is exactly "the component that owns the string
 * passes while the shell never wires it" (the fixture's own header).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO,
  act,
  answerConsentWith,
  installShellEnv,
  mountShell,
  goTo,
  mailbox,
  teardownShellEnv,
  tick,
} from "./fixtures/live-walk-shell";

const LINUX_UA = "Mozilla/5.0 (X" + "11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

function stubPlatform(platform: string, ua: string): void {
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

/** Intercept `PATCH /consent/settings`, record bodies, answer with `echo`. */
function captureFacePatch(echo: string | null): { bodies: unknown[] } {
  const record: { bodies: unknown[] } = { bodies: [] };
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/consent/settings") && init?.method === "PATCH") {
      record.bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ themeFace: echo }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return inner(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
  return record;
}

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
  await tick(0);
};

const buttonByText = (container: HTMLElement, text: string): HTMLElement => {
  const hit = [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!hit) throw new Error(`no button reading "${text}"`);
  return hit;
};

beforeEach(() => {
  installShellEnv();
  stubPlatform("MacIntel", MAC_UA);
  window.localStorage.clear();
  delete document.documentElement.dataset.face;
});

afterEach(async () => {
  await teardownShellEnv();
  window.localStorage.clear();
  delete document.documentElement.dataset.face;
});

describe("account adoption", () => {
  it("a consent answer carrying themeFace re-skins the device and mirrors it for the next boot", async () => {
    answerConsentWith({ themeFace: "ohmarchy" });
    await mountShell([mailbox()]);
    await tick(10);
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
  });

  it("a device pin outranks the adopted account face — the 'only this device' promise", async () => {
    window.localStorage.setItem("ohmail.face", "paper");
    answerConsentWith({ themeFace: "ohmarchy" });
    await mountShell([mailbox()]);
    await tick(10);
    expect(document.documentElement.dataset.face).toBeUndefined();
    // adoption still mirrored — the pin masks it, it does not erase it
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
  });
});

describe("account adoption is LIVE-WIRE only", () => {
  it("a hung consent read leaves the device's mirror standing — the boot cache is not an answer about the face", async () => {
    // review-caught: the boot cache can make `consent.known` true while the face is still the
    // resting null; adopting THAT null wiped the mirror on every warm boot whose live read
    // was slow, and armed the offer over an account that may have chosen paper.
    //
    // A REAL warm boot, or the test is vacuous (its own first draft was — it seeded no cache,
    // `known` stayed false, and both gates looked identical): the `tf_owner` cookie names the
    // account and the consent boot cache exists for it, which is exactly the state that made
    // `known` true with the face still resting.
    document.cookie = "tf_owner=acct_live_1";
    window.localStorage.setItem(
      "ohmail.boot.consent.acct_live_1",
      JSON.stringify({ v: 1, seedConfirmedAt: ISO, dormancyDays: 60, screeningBaselineAt: null, foldersEnabledAt: null }),
    );
    window.localStorage.setItem("ohmail.face.account", "ohmarchy");
    stubPlatform("Linux x86_64", LINUX_UA);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/consent") && (init?.method ?? "GET") === "GET") {
        return new Promise<Response>(() => {}); // hangs for the life of the test
      }
      return inner(input as RequestInfo, init);
    }) as typeof globalThis.fetch;
    const container = await mountShell([mailbox()]);
    await tick(50);
    expect(window.localStorage.getItem("ohmail.face.account"),
      "the mirror was wiped by an answer nobody gave").toBe("ohmarchy");
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    // and the account-write affordances stay withheld — no offer without live knowledge
    expect(container.textContent).not.toContain("Go full Ohmarchy Theme");
  });
});

describe("Settings → General → Look", () => {
  it("the segmented control flips THIS DEVICE only; 'Apply on all devices' PATCHes and clears the pin", async () => {
    const record = captureFacePatch("ohmarchy");
    const container = await mountShell([mailbox()]);
    await goTo("settings");
    await tick(10);

    // Device flip: instant, local, no wire.
    await click(buttonByText(container, "ohmarchy"));
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face")).toBe("ohmarchy");
    expect(record.bodies.length).toBe(0);
    expect(container.textContent).toContain("Applies on this device only.");

    // Account-wide: one PATCH, echo adopted, pin cleared.
    await click(buttonByText(container, "Apply on all devices"));
    expect(record.bodies).toEqual([{ themeFace: "ohmarchy" }]);
    expect(window.localStorage.getItem("ohmail.face")).toBeNull();
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(container.textContent).toContain("Applies on all your devices.");
  });

  it("a refused account write moves nothing and says so", async () => {
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/consent/settings") && init?.method === "PATCH") {
        return new Response("{}", { status: 500 });
      }
      return inner(input as RequestInfo, init);
    }) as typeof globalThis.fetch;
    const container = await mountShell([mailbox()]);
    await goTo("settings");
    await tick(10);
    await click(buttonByText(container, "ohmarchy"));
    await click(buttonByText(container, "Apply on all devices"));
    // the pin stands (the write failed), the mirror was never written, the sentence is said
    expect(window.localStorage.getItem("ohmail.face")).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face.account")).toBeNull();
    expect(container.textContent).toContain("Couldn't save that");
  });
});

describe("the Option B offer (Linux device)", () => {
  it("appears when nothing is chosen anywhere; one tap applies account-wide and never re-offers", async () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    const record = captureFacePatch("ohmarchy");
    const container = await mountShell([mailbox()]);
    await tick(10);
    // the detection default, device-only
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(container.textContent).toContain("Go full Ohmarchy Theme on all your devices");

    await click(buttonByText(container, "Go full Ohmarchy Theme on all your devices"));
    expect(record.bodies).toEqual([{ themeFace: "ohmarchy" }]);
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.faceOffer")).toBe("done");
    expect(container.textContent).not.toContain("Go full Ohmarchy Theme on all your devices");
  });

  it("dismissal keeps the device default, is remembered, and the next mount stays quiet", async () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    const container = await mountShell([mailbox()]);
    await tick(10);
    await click(buttonByText(container, "Not now"));
    expect(container.textContent).not.toContain("Go full Ohmarchy Theme");
    // the dismissal answers the OFFER, not the detection — this device stays ohmarchy
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.faceOffer")).toBe("done");

    const second = await mountShell([mailbox()]);
    await tick(10);
    expect(second.textContent).not.toContain("Go full Ohmarchy Theme");
  });

  it("an explicit prior choice wins over detection — no offer, no ohmarchy", async () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    window.localStorage.setItem("ohmail.face", "paper");
    const container = await mountShell([mailbox()]);
    await tick(10);
    expect(document.documentElement.dataset.face).toBeUndefined();
    expect(container.textContent).not.toContain("Go full Ohmarchy Theme");
  });

  it("never on a non-Linux device", async () => {
    const container = await mountShell([mailbox()]);
    await tick(10);
    expect(container.textContent).not.toContain("Go full Ohmarchy Theme");
  });
});
