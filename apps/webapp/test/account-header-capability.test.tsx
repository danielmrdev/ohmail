/** @vitest-environment jsdom */
/**
 * ═══ THE HEADER REQUIREMENT IS NEGOTIATED, AND WHERE IT CANNOT BE MET IT IS DISCLOSED ═════
 *
 * `api()` refuses an answer that does not name the account it was produced for. Applied
 * unconditionally that is right for the hosted product — the webapp and its API deploy together —
 * and it makes this client UNUSABLE against any server that predates the header: every
 * authenticated read refused, not degraded. That is the fail-closed-on-a-state-the-shell-cannot-
 * produce shape this lane has now produced twice, and the second time it refused every ordinary
 * sign-up.
 *
 * So the server says whether it names its answers and the client requires the header only where
 * it has been advertised — with the cost of NOT requiring it shown on screen, because a guard
 * that is off is a fact about somebody's install and not an implementation detail.
 *
 * ── THE THREE STATES, AND WHY THE THIRD IS NOT A BOOLEAN ──────────────────────────────────
 *
 *  · advertised, header absent      → refuses
 *  · NOT advertised, header absent  → admits, and the About pane says the check is off
 *  · advertised, header present     → admits, and the pane says nothing
 *
 * and `null` — nobody has asked, or `/hello` did not answer — admits and says nothing, because a
 * failed probe is not evidence about a server and a notice that appeared on a network blip would
 * teach people to ignore it.
 *
 * NEVER INFERRED FROM HAVING SEEN A HEADER. "We got one once, so require it from now on" makes
 * the requirement depend on the order requests happen to arrive in, and lets a single answer that
 * legitimately names nobody switch it off for the session. The last case here drives exactly that
 * sequence and asserts the requirement does not move.
 *
 * Driven through the REAL client and the REAL `/hello` read — no mock of the module under test —
 * because what is being asserted is that these two modules negotiate, and a stubbed capability
 * would assert only that a flag is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

process.env.NEXT_PUBLIC_API_BASE = "/api";

const A = "acct_A";

/** What `/hello` says about naming its answers, and whether responses carry the header. */
let advertises = false;
let sendsHeader = false;
let priorFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const json = (body: unknown, account?: string): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(account === undefined ? {} : { "X-Ohmail-Account": account }),
    },
  });

beforeEach(async () => {
  document.cookie = `tf_owner=${A}; Path=/`;
  advertises = false;
  sendsHeader = false;
  priorFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/hello")) {
      // `/hello` is anonymous and names no account — which is also the control for "the
      // negotiation is not the same thing as observing a header".
      return json({
        product: "ohmail", flavor: "managed", needsSetup: false,
        features: { staging: false, ai: false, pairing: false, ...(advertises ? { accountHeader: true } : {}) },
      });
    }
    if (url.includes("/mailboxes")) return json({ items: [] }, sendsHeader ? A : undefined);
    return json({ ok: true }, sendsHeader ? A : undefined);
  }) as unknown as typeof globalThis.fetch;

  const { bindApiOwner, setAccountHeaderCapability } = await import("../app/api-client.js");
  setAccountHeaderCapability(null);
  bindApiOwner(null);
});

afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  globalThis.fetch = priorFetch;
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  const { bindApiOwner, setAccountHeaderCapability } = await import("../app/api-client.js");
  setAccountHeaderCapability(null);
  bindApiOwner(null);
  vi.restoreAllMocks();
});

/** Ask the server what it is — the only thing that writes the capability. */
async function negotiate(): Promise<void> {
  const { serverHello } = await import("../app/hello.js");
  await serverHello();
}

/** The About pane, mounted on its own. The disclosure lives with the other facts about the install. */
async function mountAbout(): Promise<HTMLDivElement> {
  const { AboutSection } = await import("../app/(product)/mailbox/AboutSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(AboutSection),
    }));
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
  return host;
}

/** The disclosure's own words, from `en.json` — never a substring that other copy could match. */
const NOTICE = /does not name the account it answers for/i;

describe("a server that names its answers is required to; one that does not is disclosed", () => {
  it("ADVERTISED and absent — refuses", async () => {
    advertises = true;
    sendsHeader = false;
    await negotiate();
    const { api, bindApiOwner, ApiError } = await import("../app/api-client.js");
    bindApiOwner(A);
    await expect(api("/mailboxes"), "an unattributed answer was applied by a server that promised to attribute it")
      .rejects.toBeInstanceOf(ApiError);
  });

  it("NOT advertised and absent — admits, and the pane says the check is off", async () => {
    advertises = false;
    sendsHeader = false;
    await negotiate();
    const { api, bindApiOwner, accountHeaderCapability } = await import("../app/api-client.js");
    expect(accountHeaderCapability(), "an answering server that said nothing was read as not having answered")
      .toBe(false);
    bindApiOwner(A);
    await expect(api("/mailboxes"), "every authenticated read was refused against a server that predates the header")
      .resolves.toBeTruthy();

    const c = await mountAbout();
    expect(c.textContent, "the guard is off and nothing on screen says so").toMatch(NOTICE);
  });

  it("ADVERTISED, header present, same account — admits, and the pane says nothing", async () => {
    advertises = true;
    sendsHeader = true;
    await negotiate();
    const { api, bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(A);
    await expect(api("/mailboxes"), "an answer naming this very account was refused").resolves.toBeTruthy();

    const c = await mountAbout();
    expect(c.textContent, "a server that DOES name its answers was reported as not naming them")
      .not.toMatch(NOTICE);
  });

  it("nobody has asked — admits, and says nothing, because a failed probe is not evidence", async () => {
    // No `negotiate()` at all: this is a tab whose `/hello` has not landed, or did not answer.
    const { api, bindApiOwner, accountHeaderCapability } = await import("../app/api-client.js");
    expect(accountHeaderCapability()).toBeNull();
    bindApiOwner(A);
    await expect(api("/mailboxes")).resolves.toBeTruthy();
    const c = await mountAbout();
    // …and the mount's own `/hello` answers "not advertised", so the row appears from THAT — the
    // assertion is about the api-client's behaviour before any answer, above.
    expect(c.textContent).toMatch(NOTICE);
  });

  it("seeing a header does NOT create the requirement", async () => {
    /* The inference this must never make. The server does not advertise, and then answers one
       request with a header anyway — a proxy adding it, a route ahead of its own deployment. If
       "we have seen one" set the requirement, the NEXT answer without one would be refused, and a
       server that never promised anything would have broken itself by being generous. */
    advertises = false;
    await negotiate();
    const { api, bindApiOwner, accountHeaderCapability } = await import("../app/api-client.js");
    bindApiOwner(A);

    sendsHeader = true;
    await expect(api("/mailboxes")).resolves.toBeTruthy();
    expect(accountHeaderCapability(), "an observed header was read as an advertisement").toBe(false);

    sendsHeader = false;
    await expect(api("/mailboxes"), "one generous answer turned the requirement on for the session")
      .resolves.toBeTruthy();
  });
});

/**
 * ═══ THE THREE CLAIMS THE NEGOTIATION MAKES THAT HAD NO CASE BEHIND THEM ══════════════════
 *
 * Round nine read the implementation, agreed it follows the three-state rule, and then named the
 * parts of that rule nothing could have caught going wrong. All three are the same shape: a
 * sentence in a comment doing the work a case should.
 */
describe("the negotiation's own claims, each with a case", () => {
  it("a FAILED /hello leaves the previous answer alone — a blip does not switch the rule off", async () => {
    advertises = true;
    await negotiate();
    const { accountHeaderCapability } = await import("../app/api-client.js");
    expect(accountHeaderCapability(), "the control never advertised, so nothing below proves anything")
      .toBe(true);

    /* The network goes. `serverHello()` answers null — which is "we could not ask", not "the
       server said no" — and must not be allowed to relax a requirement that was advertised. */
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw new TypeError("network"); }) as unknown as typeof globalThis.fetch;
    try {
      await negotiate();
      expect(accountHeaderCapability(), "a failed probe switched the requirement off")
        .toBe(true);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("a WRONG account refuses even where the header was never advertised", async () => {
    /* The negotiation governs ABSENCE only. Every other case in this lane that drives a wrong
       name does it with the capability advertised, so nothing held this half of the rule. */
    const { api, bindApiOwner, ApiError, accountHeaderCapability } = await import("../app/api-client.js");
    expect(accountHeaderCapability(), "the capability is set, so this measures the wrong thing")
      .toBeNull();
    bindApiOwner(A);
    sendsHeader = true;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      json({ items: [] }, "acct_OTHER")) as unknown as typeof globalThis.fetch;
    try {
      await expect(api("/mailboxes"), "an answer produced for another account was applied because the server never promised to name them")
        .rejects.toBeInstanceOf(ApiError);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("the About pane says nothing while its own probe is still in flight", async () => {
    /* THE INITIAL STATE, ISOLATED. The case below fails the probe, so the effect settles and
       writes `null` over whatever the pane started with — which left a mutation that seeds the
       state as "not advertised" completely green. Here `/hello` never answers, the effect never
       resolves, and what is on screen IS the initial value.
       This is a real frame, not a contrivance: the pane renders immediately and the probe is a
       round trip, so every open of Settings → About passes through it. */
    const { accountHeaderCapability } = await import("../app/api-client.js");
    expect(accountHeaderCapability()).toBeNull();
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input).includes("/hello")) return new Promise<Response>(() => {});
      return json({ items: [] });
    }) as unknown as typeof globalThis.fetch;
    try {
      const c = await mountAbout();
      expect(c.textContent, "the pane accused the server before it had answered").not.toMatch(NOTICE);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("the About pane says nothing when its probe could not reach the server", async () => {
    /* The earlier "nobody has asked" case could not see this: mounting About runs its own
       `/hello`, which answered and moved the value to `false` before the DOM was read. So the
       server is unreachable here — the pane's probe fails, the value stays null, and the notice
       must stay away. A notice raised by a network blip teaches people to ignore notices. */
    const { accountHeaderCapability } = await import("../app/api-client.js");
    expect(accountHeaderCapability()).toBeNull();
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input).includes("/hello")) throw new TypeError("network");
      return json({ items: [] });
    }) as unknown as typeof globalThis.fetch;
    try {
      const c = await mountAbout();
      expect(accountHeaderCapability(), "a failed probe was recorded as an answer").toBeNull();
      expect(c.textContent, "the pane accused a server it could not reach").not.toMatch(NOTICE);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});

/**
 * ═══ AND THE ONE REFUSAL THAT IS NOT AN `ApiError` ════════════════════════════════════════
 *
 * `SessionBusyError` carries the only sentence a person can act on — another tab is finishing a
 * sign-in, try again in a moment — and every surface renders through `messageOf`, which dropped
 * it to the generic fallback. The published note for the lock change promised that sentence, so
 * the claim was false as well as unhelpful.
 */
describe("a lock refusal keeps the sentence somebody can act on", () => {
  it("messageOf renders it rather than the generic fallback", async () => {
    const { messageOf } = await import("../app/api-client.js");
    const { SessionBusyError } = await import("../app/session-refresh.js");
    const said = messageOf(new SessionBusyError());
    expect(said, "the one refusal that clears by itself was reported as an unknown failure")
      .not.toBe("Something went wrong. Please try again.");
    expect(said, "the sentence does not say what happened or that it will pass")
      .toMatch(/another tab/i);
  });

  it("…and an ordinary unknown error still gets the honest fallback", async () => {
    /* The control: recognising one class must not turn every stray error into a claim about
       tabs. `messageOf`'s fallback is deliberately vague because reaching it means we do not
       know. */
    const { messageOf } = await import("../app/api-client.js");
    expect(messageOf(new Error("boom")), "an unknown failure was described as a lock refusal")
      .toBe("Something went wrong. Please try again.");
  });
});

/**
 * ═══ AND A REFUSAL DOES NOT PROMISE WORK NOTHING STARTS ═══════════════════════════════════
 *
 * The response-owner refusal said "Checking who is signed in." `reResolveApiOwner` withdraws the
 * confirmation and starts nothing; the next confirm comes from the shell's own ladder, on its own
 * schedule, and on a surface without one it never comes.
 */
describe("the response refusal describes what happened", () => {
  it("says the answer was discarded, and does not claim a check is running", async () => {
    const { api, bindApiOwner, apiOwnerBinding, messageOf } = await import("../app/api-client.js");
    bindApiOwner(A);
    sendsHeader = true;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      json({ items: [] }, "acct_OTHER")) as unknown as typeof globalThis.fetch;
    try {
      const said = await api("/mailboxes").then(() => "", (e: unknown) => messageOf(e));
      expect(said, "the refusal does not say the answer was thrown away").toMatch(/discarded/i);
      expect(said, "it promises a check that nothing starts").not.toMatch(/checking/i);
      expect(apiOwnerBinding(), "the confirmation stood after an answer that could not prove itself")
        .toEqual({ kind: "pending", owner: A });
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
