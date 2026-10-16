import { describe, it, expect } from "vitest";
import { sayRefusal } from "../src/refusal";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  registerWake, forgetWake, dropWakeRow, dropWakeRowOrOwe, NO_DISTRIBUTOR,
  type UnifiedPushDistributor, type WakeRegistration, type WakeState,
} from "../src/net/push";
import { Copy } from "../src/copy";
import type { ConnectedSession } from "../src/net/pairing";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE WAKE REGISTRATION — where the endpoint goes, and what happens when there is nowhere
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Three properties, and the third is the one that is easy to get wrong by being helpful:
 *
 *  1. THE ENDPOINT GOES TO THE ACTIVE PROFILE'S SERVER AND NOWHERE ELSE. Every request is
 *     asserted for its full URL, so a hard-coded origin — anybody's, ours included — is red.
 *  2. A FORGET TAKES THE REGISTRATION DOWN SERVER-SIDE. A local-only forget would leave the
 *     server POSTing to a phone that has stopped listening.
 *  3. NO DISTRIBUTOR IS NOT AN ERROR. It is the ordinary state of most phones and of every
 *     iPhone, and the app must answer it with a sentence and no control — never a rejection, a
 *     retry loop or a toggle that cannot move.
 */

interface Call { url: string; method: string; body: string | null }

/**
 * A VAPID public key shaped exactly like a real one: base64url of a 65-byte uncompressed P-256
 * point, so 87 characters. The length is not decoration — the connector rejects anything else, and
 * a test that used `"KEY"` would pass while proving nothing about what a device will accept.
 */
const VAPID = "B".repeat(87);

/**
 * A session double: the ONLY transport, recording every call verbatim.
 *
 * `vapidKey` is what `GET /push/vapid-key` answers, because `registerWake` now asks for it before
 * anything else — `null` makes that route answer `{ publicKey: null }`, which is a real server
 * configuration and not a failure. `reply` handles everything else, so each test states only the
 * behaviour it is about.
 */
function fakeSession(
  origin: string, flavor: string, reply: (url: string, init: { method?: string }) => Response,
  vapidKey: string | null = VAPID,
  /* The PROFILE ID, which is the distributor instance a registration belongs to. Defaulted so no
     existing case moved; the two-pairing cases below name theirs, because the whole property they
     measure is that two pairings on one phone are two different registrations. */
  profileId = "p1",
  accountId = "a1",
): { session: ConnectedSession; calls: Call[]; posts: () => Call[] } {
  const calls: Call[] = [];
  const session = {
    profile: { id: profileId, origin, flavor, accountId, refreshToken: "r" },
    fetch: (url: string, init?: unknown) => {
      const i = (init ?? {}) as { method?: string; body?: string };
      calls.push({ url, method: i.method ?? "GET", body: i.body ?? null });
      if (url.endsWith("/push/vapid-key")) {
        return Promise.resolve(json(200, { publicKey: vapidKey }));
      }
      return Promise.resolve(reply(url, i));
    },
  } as unknown as ConnectedSession;
  // The key fetch is machinery every registration now performs; `posts()` is what the assertions
  // about the REGISTRATION itself read, so they stay about one request.
  return { session, calls, posts: () => calls.filter((c) => !c.url.endsWith("/push/vapid-key")) };
}

/**
 * A debt store, inspectable. `forgetWake` and `dropWakeRowOrOwe` take one because a row removal
 * that could not be retried is not a removal — see their headers. Recording the intent BEFORE the
 * attempt is what these tests are able to observe.
 */
function debts() {
  const held: Array<{ profileId: string; subscriptionId: string }> = [];
  return {
    held,
    store: {
      markPendingWakeDrop: async (profileId: string, subscriptionId: string) => {
        held.push({ profileId, subscriptionId });
      },
      clearPendingWakeDrop: async (subscriptionId: string) => {
        const i = held.findIndex((d) => d.subscriptionId === subscriptionId);
        if (i >= 0) held.splice(i, 1);
      },
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A distributor that hands back a fixed registration, recording the key AND THE INSTANCE it was
 * registered with — and which instances were dropped.
 *
 * The instance halves are not decoration. This double read `(vapid: string)` and `()`, which
 * TypeScript accepts against a two-parameter port (a function may ignore arguments), so the
 * compiler had nothing to say when registrations became per-pairing and this kept measuring
 * nothing about which pairing. A double has to be able to see the property under test.
 */
function distributor(reg: WakeRegistration | null): UnifiedPushDistributor & {
  forgotten: () => number; keysUsed: () => string[];
  registered: () => string[]; dropped: () => string[];
} {
  let forgotten = 0;
  const keysUsed: string[] = [];
  const registered: string[] = [];
  const dropped: string[] = [];
  return {
    available: () => true,
    register: async (vapid: string, instance: string) => {
      keysUsed.push(vapid);
      registered.push(instance);
      return reg;
    },
    unregister: async (instance: string) => { forgotten += 1; dropped.push(instance); },
    forgotten: () => forgotten,
    keysUsed: () => keysUsed,
    registered: () => registered,
    dropped: () => dropped,
  };
}

describe("the wake endpoint goes to the ACTIVE profile's server", () => {
  it("POSTs to the paired origin, with the transport and the endpoint and nothing else", async () => {
    const { session, calls, posts } = fakeSession(
      "https://self.example.net", "selfhost", () => json(201, { id: "sub-1" }),
    );
    const state = await registerWake(session, distributor({ endpoint: "https://ntfy.sh/upABC" }));

    expect(state).toEqual({ k: "on", id: "sub-1" });
    expect(posts()).toHaveLength(1);
    // THE FULL URL. A hard-coded origin anywhere in the module fails this equality.
    expect(posts()[0]!.url).toBe("https://self.example.net/push/subscriptions");
    expect(posts()[0]!.method).toBe("POST");
    // And the key fetch went to the SAME origin — never to an origin of this module's own.
    expect(calls[0]!.url).toBe("https://self.example.net/push/vapid-key");
    expect(calls[0]!.method).toBe("GET");
    const sent = JSON.parse(posts()[0]!.body!) as Record<string, unknown>;
    expect(sent).toEqual({ transport: "unifiedpush", endpoint: "https://ntfy.sh/upABC" });
  });

  it("goes to a MANAGED profile's origin just as readily — one mechanism, both flavors", async () => {
    const { session, posts } = fakeSession(
      "https://api.ohmail.app", "managed", () => json(201, { id: "sub-2" }),
    );
    await registerWake(session, distributor({ endpoint: "https://ntfy.sh/upXYZ" }));
    expect(posts()[0]!.url).toBe("https://api.ohmail.app/push/subscriptions");
  });

  it("forwards the distributor's keys WHEN IT HAS THEM, and omits them when it does not", async () => {
    const withKeys = fakeSession("https://s.example", "selfhost", () => json(201, { id: "k" }));
    await registerWake(withKeys.session, distributor({
      endpoint: "https://ntfy.sh/up1", keys: { p256dh: "BPUB", auth: "AUTH" },
    }));
    expect(JSON.parse(withKeys.posts()[0]!.body!)).toEqual({
      transport: "unifiedpush", endpoint: "https://ntfy.sh/up1", p256dh: "BPUB", auth: "AUTH",
    });

    const without = fakeSession("https://s.example", "selfhost", () => json(201, { id: "k" }));
    await registerWake(without.session, distributor({ endpoint: "https://ntfy.sh/up2" }));
    expect(Object.keys(JSON.parse(without.posts()[0]!.body!) as object).sort())
      .toEqual(["endpoint", "transport"]);
  });

  it("names NO origin of its own — the module has no URL literal in it", () => {
    /**
     * The structural half of property 1. The app's privacy census admits this file to the network
     * seam, and the terms of that admission are exactly this: it holds no origin. Every request is
     * built from the session's own base (`requestBase`, which is the profile's measured API base or
     * its origin), so the set of servers it can reach is the set the user paired with. The read
     * moved from the origin to that resolver when a prefixed self-host deployment was measured
     * serving these routes an HTML 404; what it asserts — this file names no server — is unchanged.
     */
    const src = readFileSync(fileURLToPath(new URL("../src/net/push.ts", import.meta.url)), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/["'`]https?:\/\//);
    expect(code).toMatch(/requestBase\(session\)/);
  });
});

describe("the server's VAPID key is fetched FIRST, and its absence is a refusal", () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  WHY THE ORDER IS ASSERTED AND NOT JUST THE OUTCOME
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * A registration made with the wrong key, or with no key, is INDISTINGUISHABLE from a working one
   * everywhere this app can see: the distributor mints an endpoint either way, the server stores it
   * either way, and the Settings pane would say "on". The only place it fails is on the phone, when
   * a wake arrives and the connector cannot verify it — silently, with no status code anywhere.
   *
   * So the key is obtained before the distributor is touched, and that ordering is the property
   * under test rather than an implementation detail.
   */

  it("asks the paired server for its key BEFORE asking the distributor for an endpoint", async () => {
    /**
     * ONE ordered log of every step, whichever layer performed it. Recording the requests and the
     * distributor's turn into the same array is what makes the ORDER assertable — two separate
     * counters could each be right while the sequence was wrong.
     */
    const order: string[] = [];
    const session = {
      profile: { id: "p1", origin: "https://s.example", flavor: "selfhost", accountId: "a1", refreshToken: "r" },
      fetch: (url: string, init?: unknown) => {
        const i = (init ?? {}) as { method?: string };
        order.push(`${i.method ?? "GET"} ${new URL(url).pathname}`);
        if (url.endsWith("/push/vapid-key")) return Promise.resolve(json(200, { publicKey: VAPID }));
        return Promise.resolve(json(201, { id: "sub" }));
      },
    } as unknown as ConnectedSession;
    const d: UnifiedPushDistributor = {
      available: () => true,
      register: async () => {
        order.push("distributor.register");
        return { endpoint: "https://ntfy.sh/up" };
      },
      unregister: async () => { /* unused */ },
    };

    expect(await registerWake(session, d)).toEqual({ k: "on", id: "sub" });
    expect(order).toEqual([
      "GET /push/vapid-key",
      "distributor.register",
      "POST /push/subscriptions",
    ]);
  });

  it("hands the distributor EXACTLY the key the server answered", async () => {
    const { session } = fakeSession("https://s.example", "selfhost", () => json(201, { id: "k" }));
    const d = distributor({ endpoint: "https://ntfy.sh/up" });
    await registerWake(session, d);
    // Not "a key" — THE key. A registration against a different one is the silent failure above.
    expect(d.keysUsed()).toEqual([VAPID]);
  });

  it("a server with NO keypair is its own state, and nothing is registered", async () => {
    /**
     * `{ publicKey: null }` is a real, supported configuration — a self-host whose operator has not
     * generated a keypair — so it must not read as an error. It gets its own state because the fix
     * belongs to whoever runs the server, and "wake notifications could not be set up" would not
     * tell them that.
     */
    const { session, posts } = fakeSession(
      "https://s.example", "selfhost", () => json(201, { id: "k" }), null,
    );
    const d = distributor({ endpoint: "https://ntfy.sh/up" });
    expect(await registerWake(session, d)).toEqual({ k: "server_has_no_key" });
    // The distributor was never asked, and no registration was attempted.
    expect(d.keysUsed()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("an empty-string key is treated as no key, not handed on", async () => {
    // An empty key reaches `registerDevice` as a rejection, so collapsing it here is what turns a
    // server misconfiguration into a sentence rather than a thrown promise.
    const { session, posts } = fakeSession(
      "https://s.example", "selfhost", () => json(201, { id: "k" }), "   ",
    );
    const d = distributor({ endpoint: "https://ntfy.sh/up" });
    expect(await registerWake(session, d)).toEqual({ k: "server_has_no_key" });
    expect(posts()).toEqual([]);
  });

  it("a key route that 404s or fails is the same refusal — never a registration", async () => {
    for (const answer of [
      () => new Response(null, { status: 404 }),
      () => new Response("not json", { status: 200 }),
      () => { throw new Error("network down"); },
    ]) {
      const calls: Call[] = [];
      const session = {
        profile: { id: "p", origin: "https://s.example", flavor: "selfhost", accountId: "a", refreshToken: "r" },
        fetch: (url: string, init?: unknown) => {
          const i = (init ?? {}) as { method?: string; body?: string };
          calls.push({ url, method: i.method ?? "GET", body: i.body ?? null });
          if (url.endsWith("/push/vapid-key")) {
            try {
              return Promise.resolve(answer());
            } catch (e) {
              return Promise.reject(e as Error);
            }
          }
          return Promise.resolve(json(201, { id: "k" }));
        },
      } as unknown as ConnectedSession;
      const d = distributor({ endpoint: "https://ntfy.sh/up" });
      expect(await registerWake(session, d)).toEqual({ k: "server_has_no_key" });
      expect(d.keysUsed()).toEqual([]);
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    }
  });

  it("a REJECTING subscription POST is a state, never a rejected promise", async () => {
    /**
     * ══════════════════════════════════════════════════════════════════════════════════════
     *  EVERY OTHER FAILURE IN THIS FUNCTION IS A STATE. THESE TWO WERE EXCEPTIONS.
     * ══════════════════════════════════════════════════════════════════════════════════════
     *
     * The key fetch and the distributor call are both wrapped; the subscription POST and the JSON
     * parse of its response were not. So a phone that lost signal between registering with its
     * distributor and telling the server about it got a REJECTED PROMISE out of `registerWake` —
     * and both callers in `state/wake.ts` invoke it as `void attempt(...)` with no terminal catch,
     * which in React Native is an unhandled rejection and a Settings pane frozen on its old state.
     *
     * Found by review. The fix belongs here rather than in the caller: this function's entire
     * contract is "every outcome is a `WakeState`", and one path that threw instead made that
     * contract a near-truth. The caller gained a terminal catch as well, because a contract worth
     * having is worth not depending on.
     */
    const cases: [string, () => Response][] = [
      ["the POST rejects outright", () => { throw new Error("network down"); }],
      ["the POST answers 200 with malformed JSON", () => new Response("not json", {
        status: 200, headers: { "content-type": "application/json" },
      })],
      ["the POST answers 201 with malformed JSON", () => new Response("<html>", { status: 201 })],
    ];
    /**
     * VALID JSON that is not an object. `null` is the one that mattered: it parses fine, so the
     * `catch` around the parse never fires, and the property read on it throws a TypeError — the
     * same rejection this test was written to prevent, one line further down. A cast is not a check.
     * The others are here because they are the same mistake in different clothes.
     */
    const wellFormedButNotAnObject: [string, string][] = [
      ["a 200 whose body is literally null", "null"],
      ["a 200 whose body is a bare number", "42"],
      ["a 200 whose body is a string", '"ok"'],
      ["a 200 whose body is an array", "[]"],
    ];
    for (const [what, answer] of cases) {
      const session = {
        profile: { id: "p", origin: "https://s.example", flavor: "selfhost", accountId: "a", refreshToken: "r" },
        fetch: (url: string) => {
          if (url.endsWith("/push/vapid-key")) return Promise.resolve(json(200, { publicKey: VAPID }));
          try {
            return Promise.resolve(answer());
          } catch (e) {
            return Promise.reject(e as Error);
          }
        },
      } as unknown as ConnectedSession;
      const state = await registerWake(session, distributor({ endpoint: "https://ntfy.sh/up" }));
      // A state, not a throw — and specifically the one that says "we could not reach the server",
      // because that is what actually happened.
      expect(state, what).toEqual({ k: "off", reason: "server_unavailable" });
    }

    for (const [what, body] of wellFormedButNotAnObject) {
      const session = {
        profile: { id: "p", origin: "https://s.example", flavor: "selfhost", accountId: "a", refreshToken: "r" },
        fetch: (url: string) => Promise.resolve(url.endsWith("/push/vapid-key")
          ? json(200, { publicKey: VAPID })
          : new Response(body, { status: 200, headers: { "content-type": "application/json" } })),
      } as unknown as ConnectedSession;
      const state = await registerWake(session, distributor({ endpoint: "https://ntfy.sh/up" }));
      // Parsed fine, so it is not "unavailable" — the server answered, and said something this
      // build cannot use. That distinction is what the two reasons exist for.
      expect(state, what).toEqual({ k: "off", reason: "server_answer_unrecognised" });
    }

    // And an object whose `id` is present but not a usable string is the same answer, not a crash
    // and not a registration with an `id` of `undefined`.
    for (const bad of [{ id: 42 }, { id: null }, { id: "" }, {}]) {
      const session = {
        profile: { id: "p", origin: "https://s.example", flavor: "selfhost", accountId: "a", refreshToken: "r" },
        fetch: (url: string) => Promise.resolve(url.endsWith("/push/vapid-key")
          ? json(200, { publicKey: VAPID })
          : json(201, bad)),
      } as unknown as ConnectedSession;
      expect(await registerWake(session, distributor({ endpoint: "https://ntfy.sh/up" })), JSON.stringify(bad))
        .toEqual({ k: "off", reason: "server_answer_unrecognised" });
    }
  });

  it("a desktop-host profile still refuses BEFORE the key fetch — no request at all", async () => {
    // The local questions stay local. A desktop host has no `push_subscriptions` and no keypair
    // route, so asking would be a 404 the app already knows the answer to.
    const { session, calls } = fakeSession("http://desktop.local:7777", "desktop", () => json(201, { id: "x" }));
    expect(await registerWake(session, distributor({ endpoint: "https://ntfy.sh/up" })))
      .toEqual({ k: "not_supported_here" });
    expect(calls).toHaveLength(0);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE REGISTRATION PER PAIRING — two accounts on one phone, and a forget that stays local
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The shipped shape: `register(vapid)` with no instance, so the connector held ONE endpoint for
 * the whole app and every paired server stored its own row against it. What followed, in order of
 * how much it costs a person:
 *
 *  · **A forget took everybody's wakes down.** `forgetWake` ends with `distributor.unregister()`,
 *    and there was one registration to unregister — so signing out of a work account stopped the
 *    personal one being woken, silently, with Settings still saying wakes were on.
 *  · **A switch left the other server dialling this phone.** Two servers POSTing to one endpoint
 *    means the app answers A's wake by syncing B.
 *  · **A wake named no pairing**, so it could only mean "sync whatever is live".
 *
 * The instance is `ServerProfile.id` — locally minted, opaque, and deliberately not the account
 * id, because the value is handed to a third-party distributor app.
 */
describe("the wake registration is bound to the PAIRING, not to the phone", () => {
  it("two pairings on one phone register TWO instances, each with its own server's key", async () => {
    const work = fakeSession("https://work.example", "selfhost", () => json(201, { id: "sub-work" }),
      VAPID, "p-work", "acct-work");
    const home = fakeSession("https://home.example", "selfhost", () => json(201, { id: "sub-home" }),
      "C".repeat(87), "p-home", "acct-home");
    const d = distributor({ endpoint: "https://dist.example/e1" });

    expect(await registerWake(work.session, d)).toEqual({ k: "on", id: "sub-work" });
    expect(await registerWake(home.session, d)).toEqual({ k: "on", id: "sub-home" });

    // TWO INSTANCES, in order, each named by its own profile — never one shared registration.
    expect(d.registered()).toEqual(["p-work", "p-home"]);
    // …and each against ITS OWN server's key. The pair is what matters: a single instance would
    // have rebound the app's one registration to whichever server answered last.
    expect(d.keysUsed()).toEqual([VAPID, "C".repeat(87)]);
    // The account id is not what reaches the distributor — the profile's own opaque id is.
    expect(d.registered().some((i) => i.includes("acct"))).toBe(false);
  });

  it("forgetting ONE pairing drops exactly its own registration — the other is untouched", async () => {
    const work = fakeSession("https://work.example", "selfhost",
      (url, i) => (i.method === "DELETE" ? json(200, { ok: true }) : json(201, { id: "sub-work" })),
      VAPID, "p-work", "acct-work");
    const home = fakeSession("https://home.example", "selfhost",
      (url, i) => (i.method === "DELETE" ? json(200, { ok: true }) : json(201, { id: "sub-home" })),
      VAPID, "p-home", "acct-home");
    const d = distributor({ endpoint: "https://dist.example/e1" });
    const { store } = debts();

    // Both paired and registered.
    await registerWake(work.session, d);
    await registerWake(home.session, d);
    expect(d.registered()).toEqual(["p-work", "p-home"]);

    // Forget the work pairing. Its server row goes, and its instance goes with it.
    const dropped = await forgetWake(work.session, d, "sub-work", store);
    expect(dropped).toEqual({ ok: true });
    expect(d.dropped(), "a forget must name the pairing it is forgetting").toEqual(["p-work"]);

    // THE OTHER PAIRING IS STILL REGISTERED. This is the assertion the shipped build could not
    // make: `unregister()` with no instance dropped the one shared registration, so this list
    // would have held "p-home" too and the personal account would have gone quiet.
    expect(d.dropped()).not.toContain("p-home");
    // The positive control on the other direction: forgetting the home pairing drops ITS one.
    await forgetWake(home.session, d, "sub-home", store);
    expect(d.dropped()).toEqual(["p-work", "p-home"]);
  });

  it("a forget whose SERVER row survives still drops only its own instance", async () => {
    // The refusal path, because it is the one where a caller might be tempted to sweep: the row
    // is still there, the verdict says so, and the OTHER pairing is still none of this forget's
    // business.
    const work = fakeSession("https://work.example", "selfhost", () => json(500, { error: "boom" }),
      VAPID, "p-work", "acct-work");
    const d = distributor({ endpoint: "https://dist.example/e1" });
    const { store } = debts();
    const dropped = await forgetWake(work.session, d, "sub-work", store);
    expect(dropped.ok).toBe(false);
    expect(d.dropped()).toEqual(["p-work"]);
  });
});

describe("a forget takes the registration down SERVER-SIDE", () => {
  it("DELETEs the subscription, then unregisters the distributor", async () => {
    const { session, calls } = fakeSession(
      "https://s.example", "selfhost", () => new Response(null, { status: 204 }),
    );
    const d = distributor({ endpoint: "https://ntfy.sh/up" });
    await forgetWake(session, d, "sub-9", debts().store);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://s.example/push/subscriptions/sub-9");
    expect(calls[0]!.method).toBe("DELETE");
    expect(d.forgotten()).toBe(1);
  });

  it("still clears locally when the server is unreachable — a forget may not fail in your face", async () => {
    const session = {
      profile: { id: "p", origin: "https://s.example", flavor: "selfhost", accountId: "a", refreshToken: null },
      fetch: () => Promise.reject(new Error("network down")),
    } as unknown as ConnectedSession;
    const d = distributor({ endpoint: "https://ntfy.sh/up" });
    expect(await forgetWake(session, d, "sub-9", debts().store)).toEqual({ ok: false, reason: "server_unavailable" });
    expect(d.forgotten()).toBe(1);
  });

  it("with no id there is nothing to DELETE, and the distributor is still told", async () => {
    const { session, calls } = fakeSession("https://s.example", "selfhost", () => new Response(null, { status: 204 }));
    const d = distributor(null);
    await forgetWake(session, d, null, debts().store);
    expect(calls).toHaveLength(0);
    expect(d.forgotten()).toBe(1);
  });

  /**
   * A PROFILE SWITCH IS A TAKE-BACK TOO, and it is the one the distributor must survive.
   *
   * This build holds ONE UnifiedPush registration for the whole app, and each paired server
   * keeps its own `push_subscriptions` row against that single endpoint. So leaving profile A's
   * row up when the phone moves to B is not a dormant record: A's server keeps POSTing wakes to
   * a phone that no longer syncs A, and the app answers each of them by syncing B. Taking the
   * endpoint down instead would silently turn B's wakes off — which is why the switch path uses
   * `dropWakeRow` and not `forgetWake`.
   */
  it("dropWakeRow takes the ROW down and leaves the shared endpoint registered", async () => {
    const { session, calls } = fakeSession(
      "https://a.example", "selfhost", () => new Response(null, { status: 204 }),
    );
    const d = distributor({ endpoint: "https://ntfy.sh/up" });
    await dropWakeRow(session, "sub-A");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://a.example/push/subscriptions/sub-A");
    expect(calls[0]!.method).toBe("DELETE");
    // The load-bearing assertion, and the whole reason this is not `forgetWake`: the next
    // profile's registration rides the SAME endpoint, so unregistering here would end its wakes.
    expect(d.forgotten()).toBe(0);
  });

  /**
   * THE STATUS WAS NEVER READ, so a 401, a 500 and a dead network all reported a removal.
   * The Settings pane then rendered "removes the registration from your server" over a row the
   * server had kept. 404 is the one non-2xx that IS success: the row this call exists to remove
   * is absent, which is the whole thing being asked for.
   */
  it("dropWakeRow reads the STATUS: 2xx and 404 are gone, everything else is still there", async () => {
    for (const status of [200, 204, 404]) {
      const { session } = fakeSession("https://a.example", "selfhost", () => new Response(null, { status }));
      expect(await dropWakeRow(session, "sub-A"), `status ${status}`).toEqual({ ok: true });
    }
    for (const [status, reason] of [[401, "refused"], [403, "refused"], [500, "server_unavailable"]] as const) {
      const { session } = fakeSession("https://a.example", "selfhost", () => new Response(null, { status }));
      expect(await dropWakeRow(session, "sub-A"), `status ${status}`).toEqual({ ok: false, reason });
    }
  });

  it("forgetWake carries that verdict out, and still unregisters the distributor either way", async () => {
    // The DISTRIBUTOR half stays best-effort — a take-back the person asked for must not fail in
    // their face — but the claim about the SERVER now comes from the server.
    const { session } = fakeSession("https://a.example", "selfhost", () => new Response(null, { status: 500 }));
    const d = distributor({ endpoint: "https://ntfy.sh/up" });
    expect(await forgetWake(session, d, "sub-9", debts().store)).toEqual({ ok: false, reason: "server_unavailable" });
    expect(d.forgotten()).toBe(1);
  });

  it("the debt is written BEFORE the DELETE, and cleared only on a confirmed removal", async () => {
    // Recording it afterwards made the durability conditional on the thing that was failing: the
    // callers discard the in-memory id the moment they call this, so a kill between the request
    // going out and the debt landing left NOTHING holding the only id that can remove the row.
    const refusing = fakeSession("https://a.example", "selfhost", () => new Response(null, { status: 500 }));
    const owedA = debts();
    expect(await dropWakeRowOrOwe(refusing.session, "sub-A", owedA.store))
      .toEqual({ ok: false, reason: "server_unavailable" });
    expect(owedA.held).toEqual([{ profileId: "p1", subscriptionId: "sub-A" }]);

    // A confirmed removal clears it, so the queue cannot grow over successful take-backs.
    const ok = fakeSession("https://a.example", "selfhost", () => new Response(null, { status: 204 }));
    const owedB = debts();
    expect((await dropWakeRowOrOwe(ok.session, "sub-B", owedB.store)).ok).toBe(true);
    expect(owedB.held).toEqual([]);
  });

  it("a debt that cannot be RECORDED refuses the attempt rather than dressing it as done", async () => {
    // A delete that might fail and might not be retryable must not be reported as a removal.
    const { session, calls } = fakeSession("https://a.example", "selfhost", () => new Response(null, { status: 204 }));
    const broken = {
      markPendingWakeDrop: async () => { throw new Error("the queue is full"); },
      clearPendingWakeDrop: async () => undefined,
    };
    const out = await dropWakeRowOrOwe(session, "sub-C", broken);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/could_not_record_debt/);
    // …and nothing was sent, so the id the caller is about to discard still names a live row
    // that the refusal tells it about.
    expect(calls).toHaveLength(0);
  });

  it("turning wakes off goes through the SAME durable path", async () => {
    // This was the one row removal that did not: a refused delete lived only in the live
    // provider, one restart lost the id, and the next launch said nothing wakes this app over a
    // row the server was still dialling.
    const { session } = fakeSession("https://a.example", "selfhost", () => new Response(null, { status: 401 }));
    const d = distributor({ endpoint: "https://ntfy.sh/up" });
    const owed = debts();
    const out = await forgetWake(session, d, "sub-9", owed.store);
    expect(out.ok).toBe(false);
    expect(owed.held).toEqual([{ profileId: "p1", subscriptionId: "sub-9" }]);
    // The distributor half stays best-effort and still runs — the person asked for it.
    expect(d.forgotten()).toBe(1);
  });

  it("dropWakeRow never throws, and with no id it makes no request at all", async () => {
    const dead = {
      profile: { id: "p", origin: "https://a.example", flavor: "selfhost", accountId: "a", refreshToken: null },
      fetch: () => Promise.reject(new Error("network down")),
    } as unknown as ConnectedSession;
    expect(await dropWakeRow(dead, "sub-A")).toEqual({ ok: false, reason: "server_unavailable" });

    const { session, calls } = fakeSession("https://a.example", "selfhost", () => new Response(null, { status: 204 }));
    await dropWakeRow(session, null);
    expect(calls).toHaveLength(0);
  });
});

describe("no distributor is a SENTENCE, never an error", () => {
  it("this build ships NO_DISTRIBUTOR, and it answers 'unavailable' rather than throwing", async () => {
    expect(NO_DISTRIBUTOR.available()).toBe(false);
    await expect(NO_DISTRIBUTOR.register(VAPID, "p-1")).resolves.toBeNull();
    await expect(NO_DISTRIBUTOR.unregister("p-1")).resolves.toBeUndefined();
  });

  it("registration with no distributor makes NO request and reports no_distributor", async () => {
    const { session, calls } = fakeSession("https://s.example", "selfhost", () => json(201, { id: "x" }));
    const state = await registerWake(session, NO_DISTRIBUTOR);
    expect(state).toEqual({ k: "no_distributor" });
    // The local question is answered locally: nothing was asked of the server — not even the key.
    expect(calls).toHaveLength(0);
  });

  it("a desktop-host profile is refused BEFORE a request — that server has no such table", async () => {
    const { session, calls } = fakeSession("http://desktop.local:7777", "desktop", () => json(201, { id: "x" }));
    const state = await registerWake(session, distributor({ endpoint: "https://ntfy.sh/up" }));
    expect(state).toEqual({ k: "not_supported_here" });
    expect(calls).toHaveLength(0);
  });

  it("a distributor that declines is 'off' with a reason, not a throw", async () => {
    const { session } = fakeSession("https://s.example", "selfhost", () => json(201, { id: "x" }));
    const declines: UnifiedPushDistributor = {
      available: () => true,
      register: async () => null,
      unregister: async () => { /* nothing */ },
    };
    expect(await registerWake(session, declines)).toEqual({ k: "off", reason: "distributor_refused" });

    const throws: UnifiedPushDistributor = {
      available: () => true,
      register: () => Promise.reject(new Error("no distributor service")),
      unregister: async () => { /* nothing */ },
    };
    expect(await registerWake(session, throws)).toEqual({ k: "off", reason: "distributor_refused" });
  });

  it("the SERVER's SSRF refusal is reported as its own reason, not as a generic failure", async () => {
    // A 400 from `/push/subscriptions` is the endpoint gate refusing to dial the distributor's
    // address. Distinguishing it is what lets the copy say something true.
    const { session } = fakeSession("https://s.example", "selfhost", () => json(400, {
      error: "validation_failed", message: "endpoint is not a permitted url: host is not public",
    }));
    expect(await registerWake(session, distributor({ endpoint: "http://192.168.1.9/up" })))
      .toEqual({ k: "off", reason: "endpoint_refused" });
  });

  it("a server with no push table (404/501) is 'not supported here', not 'off'", async () => {
    for (const status of [404, 501]) {
      const { session } = fakeSession("https://s.example", "selfhost", () => json(status, {}));
      expect(await registerWake(session, distributor({ endpoint: "https://ntfy.sh/up" })))
        .toEqual({ k: "not_supported_here" });
    }
  });
});

describe("the copy for every wake state exists and claims nothing this build cannot do", () => {
  const states: WakeState[] = [
    { k: "no_distributor" },
    { k: "not_supported_here" },
    { k: "server_has_no_key" },
    { k: "on", id: "x" },
    { k: "off", reason: "endpoint_refused" },
    { k: "off", reason: "server_unavailable" },
  ];

  it("every state has a non-empty sentence", () => {
    const sentence = (s: WakeState): string => {
      switch (s.k) {
        case "no_distributor": return Copy.wakeNoDistributor;
        case "not_supported_here": return Copy.wakeDesktopHost;
        case "server_has_no_key": return Copy.wakeServerNoKey;
        case "on": return Copy.wakeOn;
        case "off": return Copy.wakeOff(s.reason);
      }
    };
    for (const s of states) expect(sentence(s).length).toBeGreaterThan(20);
  });

  it("the no-distributor and desktop sentences both say what happens INSTEAD", () => {
    // The rule this enforces: never tell someone a feature is unavailable without telling them how
    // mail reaches them anyway. Both arms fall back to foreground sync and pull-to-refresh.
    for (const s of [
      Copy.wakeNoDistributor, Copy.wakeDesktopHost, Copy.wakeServerNoKey, Copy.wakeOff("x"),
    ]) {
      expect(s.toLowerCase()).toMatch(/pull to refresh/);
    }
  });

  it("no sentence promises a notification with mail in it", () => {
    const all = [
      Copy.wakeNoDistributor, Copy.wakeDesktopHost, Copy.wakeServerNoKey, Copy.wakeOn,
      Copy.wakeOff("x"),
    ].join("\n").toLowerCase();
    // The wake carries no subject, no sender and no count, so no sentence may imply a preview.
    expect(all).not.toMatch(/\bpreview\b|shows the subject|who it.s from/);
    // And the "on" sentence must state the absence positively rather than leaving it unsaid.
    expect(Copy.wakeOn.toLowerCase()).toMatch(/no subject/);
  });

  it("names no push provider — the whole point is that there is no Google or Apple in the path", () => {
    const all = [
      Copy.wakeNoDistributor, Copy.wakeDesktopHost, Copy.wakeServerNoKey, Copy.wakeOn,
    ].join("\n");
    expect(all).not.toMatch(/\bFCM\b|Firebase|\bAPNs\b/);
    // The no-distributor sentence says so out loud, because that is the reason anyone would care.
    expect(Copy.wakeNoDistributor).toMatch(/no Google or Apple push service/);
  });
});
