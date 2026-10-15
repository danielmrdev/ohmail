import { afterEach, describe, expect, it } from "vitest";
import { sayRefusal } from "../src/refusal";

import { readFileSync } from "node:fs";
import {
  canPin,
  hostPortOf,
  installPinning,
  isNotTls,
  unreachableClause,
  isPinFailure,
  pin,
  pinnedCount,
  unpin,
  type PinningNative,
} from "../src/net/host-pinning";
import { admitOrigin, connectProfile, probePairing, unreachableSaid } from "../src/net/pairing";
import { Copy, DECKS } from "../src/copy";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { pairThroughConfirm, sqlWorld } from "./helpers/pair-server";

/**
 * ═══ THE TRANSPORT GATE — what this phone will and will not talk to ══════════════════════════
 *
 * The defect these guards close: the desktop's same-network door served plain HTTP, and a
 * release build of this app refuses a cleartext socket before opening it, so the one client that
 * door existed for could never reach it. The door serves TLS now, with a self-signed key no
 * authority vouches for, and the trust comes from the pairing ceremony.
 *
 * This suite is the client half of that, and its shape is deliberate: EVERY assertion below is
 * about a refusal that has to happen, because the failure mode this whole change exists to avoid
 * is not "pairing does not work" — it is "pairing works, unpinned". A gate that fell through to
 * an unverified TLS connection would pass every functional test there is.
 */

/** A registry that records what the native half would have been told. */
function fakeNative(): PinningNative & { pins: Map<string, string> } {
  const pins = new Map<string, string>();
  return {
    pins,
    isInstalled: () => true,
    factoryUses: () => 1,
    setPin: (host, port, spki) => { pins.set(`${host}:${port}`, spki); return pins.size; },
    clearPin: (host, port) => { pins.delete(`${host}:${port}`); return pins.size; },
    clearAllPins: () => { pins.clear(); return 0; },
    pinnedCount: () => pins.size,
  };
}

const PIN_A = "k5PGuAY8E5LFpWM0zgqW20AuzK_KKxn8dKZsV6QmpWg";
const PIN_B = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE";

afterEach(() => installPinning(null));

describe("a build with no pinning registry cannot pin, and says so", () => {
  it("canPin is FALSE by default — a composition that forgot to install refuses, never falls through", () => {
    // The default matters more than it looks: if the absent registry meant "no pinning needed",
    // an app whose native module failed to link would pair over TLS nobody checked, and every
    // test in this file would still be green.
    expect(canPin()).toBe(false);
    expect(pin("https://192.168.1.10:6245", PIN_A)).toBe(false);
    expect(pinnedCount()).toBe(0);
  });

  it("refuses a same-network pairing naming the missing platform half, not the network", () => {
    const out = admitOrigin("https://192.168.1.10:6245", PIN_A);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(sayRefusal(out.reason)).toContain("not available in this build");
    expect(sayRefusal(out.reason)).toContain("Tailscale");
  });
});

describe("cleartext is refused by THIS app, before the platform refuses it obscurely", () => {
  it("http to a network address is refused with a sentence somebody can act on", () => {
    installPinning(fakeNative());
    const out = admitOrigin("http://192.168.1.10:6245", null);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The platform's own words are `UnknownServiceException: CLEARTEXT communication to
    // 192.168.1.10 not permitted by network security policy`, which reads as "the server is
    // down". This must not.
    expect(sayRefusal(out.reason)).toContain("unencrypted");
    expect(sayRefusal(out.reason)).toContain("Settings");
  });

  it("…and a PINNED http link does not buy its way past it", () => {
    // A pin authenticates a key. It does nothing about a connection that carries no key at all,
    // and a gate that checked the pin first would have accepted this.
    installPinning(fakeNative());
    expect(admitOrigin(`http://192.168.1.10:6245`, PIN_A).ok).toBe(false);
  });

  it("loopback http is admitted — there is no network path to protect", () => {
    installPinning(fakeNative());
    expect(admitOrigin("http://127.0.0.1:8931", null)).toEqual({ ok: true, enforcedPin: null });
    expect(admitOrigin("http://localhost:8931", null)).toEqual({ ok: true, enforcedPin: null });
  });
});

describe("an address no certificate can be issued for MUST carry a pin", () => {
  it("an IP literal with no pin is refused, and the sentence says to mint a fresh code", () => {
    installPinning(fakeNative());
    const out = admitOrigin("https://192.168.1.10:6245", null);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(sayRefusal(out.reason)).toContain("does not carry this computer's identity");
  });

  it("an IP literal WITH a pin is admitted, and the key is recorded against host and port", () => {
    const native = fakeNative();
    installPinning(native);
    /* ENFORCED, and it says so: only a key the TLS stack is actually checking may be reported,
       because only a reported key reaches the confirmation screen. */
    expect(admitOrigin("https://192.168.1.10:6245", PIN_A)).toEqual({ ok: true, enforcedPin: PIN_A });
    expect(native.pins.get("192.168.1.10:6245")).toBe(PIN_A);
    // Scoped: nothing else on the network gained anything.
    expect(native.pins.size).toBe(1);
  });

  it("a DNS-named https origin is admitted with NO pin and records nothing", () => {
    // The hosted service and a self-host box with a real certificate are judged by the platform's
    // own trust store, exactly as before. A pin here would add a way for the pairing to break on
    // certificate renewal and no security the trust store does not already provide.
    const native = fakeNative();
    installPinning(native);
    expect(admitOrigin("https://api.ohmail.app", null)).toEqual({ ok: true, enforcedPin: null });
    expect(admitOrigin("https://mail.example.com", null)).toEqual({ ok: true, enforcedPin: null });
    expect(native.pins.size).toBe(0);
  });
});

describe("rotation: a re-pair re-pins, and a forget drops it", () => {
  it("pairing the same host again REPLACES the key rather than adding a second accepted one", () => {
    // This is the whole rotation story. A registry that accumulated keys would mean a desktop's
    // OLD key stayed acceptable for ever — so an attacker who once had it keeps it.
    const native = fakeNative();
    installPinning(native);
    expect(admitOrigin("https://192.168.1.10:6245", PIN_A).ok).toBe(true);
    expect(admitOrigin("https://192.168.1.10:6245", PIN_B).ok).toBe(true);
    expect(native.pins.get("192.168.1.10:6245")).toBe(PIN_B);
    expect(native.pins.size).toBe(1);
  });

  it("unpin removes exactly that host and port", () => {
    const native = fakeNative();
    installPinning(native);
    pin("https://192.168.1.10:6245", PIN_A);
    pin("https://192.168.1.11:6245", PIN_B);
    unpin("https://192.168.1.10:6245");
    expect([...native.pins.keys()]).toEqual(["192.168.1.11:6245"]);
  });

  it("a changed key gets the HONEST sentence, never a silent failure and never 'try again'", () => {
    // A pin failure surfaces as an unreadable platform exception that is indistinguishable from
    // a dead network. Recognised by shape, because the wording differs by Android version.
    expect(isPinFailure(
      "javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: " +
      "Trust anchor for certification path not found.",
    )).toBe(true);
    expect(isPinFailure("javax.net.ssl.SSLPeerUnverifiedException: Hostname 10.0.2.2 not verified"))
      .toBe(true);
    // …and an ordinary dead network is NOT dressed up as a security event.
    expect(isPinFailure("TypeError: Network request failed")).toBe(false);
    expect(isPinFailure("java.net.ConnectException: failed to connect to /10.0.2.2 (port 6245)"))
      .toBe(false);
    // The sentence itself says what happened, what to do, and what it might mean if you did not
    // do it — never "try again", which is what a person does that makes this worse. It moved
    // out of the pinning module and into the copy deck when the phone gained a second language;
    // the regex above stayed, because a platform's own error text is not ours to translate.
    expect(Copy.pinChanged).toContain("pair this phone again");
    expect(Copy.pinChanged).toContain("something on your network is answering for it");
    expect(Copy.pinChanged).not.toMatch(/try again\b/i);
  });
});

describe("hostPortOf — what the registry is keyed on", () => {
  it("reads an explicit port and defaults the scheme's when there is none", () => {
    expect(hostPortOf("https://192.168.1.10:6245")).toEqual({ host: "192.168.1.10", port: 6245 });
    expect(hostPortOf("https://api.ohmail.app")).toEqual({ host: "api.ohmail.app", port: 443 });
    expect(hostPortOf("http://127.0.0.1")).toEqual({ host: "127.0.0.1", port: 80 });
    // Lower-cased, so one host is one key however the QR encoder spelled it.
    expect(hostPortOf("HTTPS://Desk.Example:8443")).toEqual({ host: "desk.example", port: 8443 });
  });

  it("answers null for what is not an origin, and pin() then records nothing", () => {
    const native = fakeNative();
    installPinning(native);
    expect(hostPortOf("https://h.example/pair#tok")).toBeNull();
    expect(hostPortOf("not a url")).toBeNull();
    expect(pin("not a url", PIN_A)).toBe(false);
    expect(native.pins.size).toBe(0);
  });
});

describe("the pin is PERSISTED with the pairing and re-installed on every launch", () => {
  function memoryKV(): SecureKV {
    const map = new Map<string, string>();
    return {
      get: async (k) => map.get(k) ?? null,
      set: async (k, v) => void map.set(k, v),
      remove: async (k) => void map.delete(k),
    };
  }

  it("a cold connect re-pins from the stored profile BEFORE the first wire touch", async () => {
    // THE COLD-START DEFECT THIS CLOSES. The native registry is process-local and empty at
    // launch, so a pin held only in memory would pair perfectly and then, after one restart,
    // either fail every request or — far worse, if the gate fell through — connect unpinned to
    // a mailbox it had already copied. `buildSession` is the one place every session is built,
    // which is why the re-pin lives there and not at the three call sites.
    const native = fakeNative();
    installPinning(native);
    const world = sqlWorld();
    const profiles = new ServerProfileStore(memoryKV());
    const stored = await profiles.add({
      origin: "https://192.168.1.10:6245",
      flavor: "desktop-host",
      accountId: "acct-1",
      refreshToken: "refresh-1",
      pin: PIN_A,
    });
    expect(stored.pin).toBe(PIN_A);
    // Read back through the store, not from the object we just handed it: the pin has to survive
    // serialization, which is the half a held object would not prove.
    const reread = (await profiles.list())[0]!;
    expect(reread.pin).toBe(PIN_A);

    expect(native.pins.size).toBe(0);
    await connectProfile(
      {
        profiles,
        engineDeps: {
          openExecutor: world.open,
          deleteDatabase: world.drop,
          uuid: () => "00000000-0000-4000-8000-000000000000",
        },
      },
      reread,
    );
    // Whatever the boot then did with an unreachable address, the key was recorded first.
    expect(native.pins.get("192.168.1.10:6245")).toBe(PIN_A);
  });

  it("a stored profile whose pin is GONE refuses to boot rather than connecting unpinned", async () => {
    // The row shape allows `pin: null` (every origin the platform can verify needs none), so the
    // gate has to re-derive the REQUIREMENT from the origin at boot — not trust the row to carry
    // one. A downgrade by editing a stored value is exactly the shape this refuses.
    installPinning(fakeNative());
    const world = sqlWorld();
    const profiles = new ServerProfileStore(memoryKV());
    const stored = await profiles.add({
      origin: "https://192.168.1.10:6245",
      flavor: "desktop-host",
      accountId: "acct-1",
      refreshToken: "refresh-1",
      pin: null,
    });
    const out = await connectProfile(
      {
        profiles,
        engineDeps: {
          openExecutor: world.open,
          deleteDatabase: world.drop,
          uuid: () => "00000000-0000-4000-8000-000000000000",
        },
      },
      stored,
    );
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") return;
    expect(sayRefusal(out.reason)).toContain("does not carry this computer's identity");
  });
});

describe("a native half that LOADED but did not INSTALL is not 'can pin'", () => {
  it("refuses the pairing rather than recording a pin nothing will honour", () => {
    // MEASURED, not imagined. The first build of the native module returned early from its
    // install when React Native's context was not yet available. The module still loaded, so a
    // presence check answered "yes", the pin went into a registry the TLS stack never consulted,
    // and the handshake then failed the ordinary way — which this app reported as "this
    // computer's identity has changed", the one sentence that means somebody is impersonating
    // your desktop. A security mechanism that is absent must not be reportable as present.
    installPinning({ ...fakeNative(), isInstalled: () => false });
    expect(canPin()).toBe(false);
    const out = admitOrigin("https://192.168.1.10:6245", PIN_A);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(sayRefusal(out.reason)).toContain("not available in this build");
  });

  it("a native half that THROWS on the question is treated as absent", () => {
    installPinning({
      ...fakeNative(),
      isInstalled: () => { throw new Error("bridge gone"); },
    });
    expect(canPin()).toBe(false);
  });
});

describe("the SYNC path says the pin sentence too, not the platform's words", () => {
  it("a handshake failure on an established pairing is reported as a changed key", () => {
    // MEASURED on a real device: the desktop's key was moved aside and re-minted, and the
    // paired phone said "Sync failed — the mirror keeps what it has. MutationRejectedError:
    // network failure: … CertPathValidatorException: Trust anchor for certification path not
    // found." The behaviour was right (nothing trusted, mirror kept) and the sentence was
    // unreadable — and indistinguishable from bad wifi, which is the one thing it must not be.
    const platform =
      "MutationRejectedError: network failure: Error: fetch failed: " +
      "javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: " +
      "Trust anchor for certification path not found.";
    // `true` — a PINNED pairing, which is the only kind this sentence is true about. See the
    // unpinned case below for what the second argument decides and why it is not optional.
    const said = Copy.connectSyncFailed(platform, true);
    expect(said).toContain("pair this phone again");
    expect(said).not.toContain("CertPathValidatorException");
  });

  /**
   * THE SAME HANDSHAKE ON A PAIRING THAT HOLDS NO PIN MEANS SOMETHING ELSE.
   *
   * `PIN_CHANGED_SENTENCE` tells somebody a computer's key changed and to mint a fresh code from
   * that computer's Devices pane. On the hosted service, or on a self-hosted server reached by a
   * DNS name (`originNeedsPin` requires a pin only for an IP literal), there is no pinned key to
   * change and no such computer: the honest reading is that the certificate at that address is not
   * one this phone's trust store accepts — which is precisely the state an operator on a private
   * name is in, because this app trusts only the system's authorities (see `doorSelfCert`).
   *
   * This case is the one the self-hosted door created. Before it, every handshake shape on every
   * profile got the changed-key sentence, so the first self-hoster whose certificate was refused
   * would have been sent to look for a Devices pane on a computer they had never paired with.
   */
  it("…and the same handshake on an UNPINNED pairing names the certificate, not a changed key", () => {
    const platform =
      "MutationRejectedError: network failure: Error: fetch failed: " +
      "javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: " +
      "Trust anchor for certification path not found.";
    const said = Copy.connectSyncFailed(platform, false);
    expect(said).toContain("would not accept the certificate");
    expect(said).not.toContain("pair this phone again");
    expect(said).not.toContain("CertPathValidatorException");
  });

  it("…and an ordinary network failure keeps the detail it always had", () => {
    for (const pinned of [true, false]) {
      const said = Copy.connectSyncFailed("TypeError: Network request failed", pinned);
      expect(said).toContain("the mirror keeps what it has");
      expect(said).toContain("Network request failed");
      expect(said).not.toContain("pair this phone again");
      // Nor the certificate sentence: a dead network is not a trust event in either direction.
      expect(said).not.toContain("would not accept the certificate");
    }
  });
});


/**
 * ═══ AN ADDRESS THAT ANSWERS WITHOUT TLS — THE OTHER HALF OF A FAILED DIAL ═════════════════════
 *
 * `HANDSHAKE` recognises a certificate this phone will not accept. It does not recognise a peer
 * whose first bytes are not a TLS record, which is what an https address pointed at a plain-http
 * port produces — the likeliest self-hosting mistake. Unclassified, the platform's own exception
 * reached a screen after a full stop that had already said the wrong thing.
 */
/* THE EXACT STRINGS. The Android one is what a phone rendered. The iOS pair are the platform's
   documented shapes for the same dial — its own constant and the NSError description form — taken
   from the constants rather than from a device, the same honesty the iOS pinning half is written
   with. Both are asserted, so a regex that stops matching either goes red. At module scope because
   the third classifier's disjointness case is asserted against these same strings, and two copies
   of one fixture is two things to keep in step. */
const ANDROID_NOT_TLS = "javax.net.ssl.SSLException: Unable to parse TLS packet header";
const IOS_NOT_TLS = [
  'Error Domain=NSURLErrorDomain Code=-1200 "An SSL error has occurred and a secure '
  + 'connection to the server cannot be made."',
  "NSURLErrorSecureConnectionFailed",
];

describe("an address that answers WITHOUT TLS gets a sentence, not the platform's exception", () => {
  const ANDROID = ANDROID_NOT_TLS;
  const IOS = IOS_NOT_TLS;
  const PIN_FAILURES = [
    "javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: "
    + "Trust anchor for certification path not found.",
    "javax.net.ssl.SSLPeerUnverifiedException: Hostname 10.0.2.2 not verified",
  ];
  const DEAD_NETWORK = [
    "TypeError: Network request failed",
    "java.net.ConnectException: failed to connect to /10.0.2.2 (port 6245)",
  ];

  it("recognises the shape on both platforms, and nothing else", () => {
    expect(isNotTls(ANDROID)).toBe(true);
    for (const s of IOS) expect(isNotTls(s), s).toBe(true);
    for (const s of [...PIN_FAILURES, ...DEAD_NETWORK]) expect(isNotTls(s), s).toBe(false);
  });

  it("is DISJOINT from a pin failure — no string may mean both", () => {
    // Two classifications claiming one string is how a changed key would be reported as a
    // cleartext port, and it is asserted rather than read off the two regexes.
    for (const s of [ANDROID, ...IOS]) expect(isPinFailure(s), s).toBe(false);
    for (const s of PIN_FAILURES) expect(isNotTls(s), s).toBe(false);
  });

  it("says what stopped it and what to do, in both languages, with none of the platform's words", () => {
    for (const [lang, deck] of Object.entries(DECKS)) {
      expect(deck.notEncrypted, lang).toMatch(/https/);
      expect(deck.notEncrypted, lang).not.toMatch(/SSL|TLS|NSURL|javax/);
      expect(deck.notEncrypted, lang).not.toMatch(/try again|versuch/i);
    }
    // The cause is NAMED and not asserted: iOS's own wording for this does not tell a cleartext
    // port apart from a cipher mismatch, so "usual reason" is the strongest true form.
    expect(DECKS.en.notEncrypted).toContain("usual reason is a server answering plain http");
    expect(DECKS.de.notEncrypted).toContain("Meist antwortet der Server");
  });

  it("the pairing ceremony renders the sentence instead of the exception", async () => {
    // The PRODUCER, driven: `admitOrigin` admits an https name with no pin (the self-hoster's
    // case), `/hello` then throws the platform's string, and the refusal is what a person reads.
    // `/hello` belongs to the PROBE now that the ceremony has a confirmation in it, so the whole
    // sequence a screen performs is driven through `pairThroughConfirm` — the same route the
    // suite's other redeem sites take. The token is never reached, which is the point.
    const world = sqlWorld();
    for (const detail of [ANDROID, ...IOS]) {
      const out = await pairThroughConfirm(
        {
          profiles: new ServerProfileStore(kvOf()),
          engineDeps: {
            openExecutor: world.open,
            deleteDatabase: world.drop,
            uuid: () => "00000000-0000-4000-8000-000000000000",
          },
          fetchImpl: () => Promise.reject(new Error(detail)),
        },
        { origin: "https://mail.example.com", token: "tok-1" },
      );
      expect(out.kind, detail).toBe("refused");
      if (out.kind !== "refused") return;
      const said = sayRefusal(out.reason);
      expect(said, detail).toBe(Copy.notEncrypted);
      // …and specifically NOT the old rendering: the exception nested in a reachability claim.
      expect(said, detail).not.toContain("SSL");
      expect(said, detail).not.toMatch(/could not reach/i);
    }
  });

  it("the door's unreachable arm consults the classifier — it is the second producer", () => {
    /* A SHAPE CHECK, and it is the only kind available here: `sentenceFor` lives in `Doors.tsx`,
       which imports react-native, and an Expo package's Flow-typed JavaScript cannot be loaded by
       this runner at all. `unsaved-changes.test.ts` reads a `.tsx` for the same reason. */
    const src = readFileSync(new URL("../src/ui/Doors.tsx", import.meta.url), "utf8");
    expect(src).toContain("isNotTls(n.detail)");
    expect(src).toContain('refuse("notEncrypted")');
    expect(src).toContain('isNotTls } from "../net/host-pinning"');
  });
});

/**
 * ═══ A DIAL THAT REACHED NOTHING SAYS SO IN OUR WORDS, NOT THE PLATFORM'S ═════════════
 *
 * Read on a device at 0.19.6: "Your own server" → an address that does not resolve → Continue
 * rendered **"Could not reach that address. Error: fetch failed: java.net.UnknownHostException:
 * Unable to resolve host …: No address associated with hostname"**. `faultDetail(err)` returns
 * `String(err)` and `Copy.unreachable(detail)` appended it verbatim. The refusal DID render a
 * sentence — the hard rule was met — and half of that sentence was an internal exception class.
 *
 * `notEncrypted` above is the already-cleaned twin of exactly this: the same dial, the same
 * complaint ("the words after the full stop are the platform's, not anybody's"), classified by
 * shape into a sentence. This is the arm that was left uncleaned, done the same way.
 */
describe("an unreachable address is classified, never quoted", () => {
  /* The Android string the device rendered, with the host taken out; then the same three causes
     as both platforms state them. iOS's are its documented `NSURLError` constants and the NSError
     description form that carries the code. */
  const DNS = [
    "TypeError: Network request failed: java.net.UnknownHostException: Unable to resolve host "
    + '"srv.invalid": No address associated with hostname',
    "NSURLErrorCannotFindHost",
    'Error Domain=NSURLErrorDomain Code=-1003 "A server with the specified hostname could not be found."',
  ];
  const REFUSED = [
    "java.net.ConnectException: failed to connect to /10.0.2.2 (port 6245)",
    "Error: connect ECONNREFUSED 127.0.0.1:6245",
    'Error Domain=NSURLErrorDomain Code=-1004 "Could not connect to the server."',
  ];
  const TIMEOUT = [
    "java.net.SocketTimeoutException: timeout",
    'Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."',
  ];
  /** A fault this build cannot name — the arm that must produce NO clause at all. */
  const UNNAMED = "TypeError: Network request failed";
  /** Every word of the platform's that must not reach a person. */
  const PLATFORM_WORDS = /java\.|Exception|fetch failed|NSURL|Error:|Code=-/;

  it("names the three causes a person can act on differently, and nothing else", () => {
    for (const s of DNS) expect(unreachableClause(s), s).toBe("unreachableDns");
    for (const s of REFUSED) expect(unreachableClause(s), s).toBe("unreachableRefused");
    for (const s of TIMEOUT) expect(unreachableClause(s), s).toBe("unreachableTimeout");
    /* THE CONTROL, and it is the one that decides the design: an unclassified fault answers null,
       so the sentence ends at the full stop rather than reaching for the platform's words. */
    expect(unreachableClause(UNNAMED)).toBeNull();
    /* AND THE MAPPER THE TWO PRODUCERS USE carries each key through unchanged — the classifier
       answers a key because a `refuse` in that module would close a real import cycle
       (`copy.en.ts` imports `isPinFailure`), so the two halves are asserted against each other. */
    expect(unreachableSaid(DNS[0]!)?.say).toBe("unreachableDns");
    expect(unreachableSaid(REFUSED[0]!)?.say).toBe("unreachableRefused");
    expect(unreachableSaid(TIMEOUT[0]!)?.say).toBe("unreachableTimeout");
    expect(unreachableSaid(UNNAMED)).toBeNull();
  });

  it("is DISJOINT from the TLS classifications — no string may mean both", () => {
    /* The rule the cleartext/pin pair keeps, extended to the third classifier: a handshake that
       failed the pin must not also read as a dead name, or a changed key is reported as a typo. */
    for (const s of [...DNS, ...REFUSED, ...TIMEOUT]) expect(isNotTls(s), s).toBe(false);
    for (const s of [ANDROID_NOT_TLS, ...IOS_NOT_TLS]) expect(unreachableClause(s), s).toBeNull();
  });

  it("renders a person's sentence with none of the platform's words, in both languages", () => {
    for (const [lang, deck] of Object.entries(DECKS)) {
      for (const key of ["unreachable", "pairUnreachable", "unreachableDns",
                         "unreachableRefused", "unreachableTimeout"] as const) {
        expect(deck[key], `${lang}/${key}`).not.toMatch(PLATFORM_WORDS);
      }
      /* And both whole sentences, assembled the way their two producers assemble them. */
      expect(deck.unreachableWhy(deck.unreachableDns), lang).not.toMatch(PLATFORM_WORDS);
      expect(deck.pairUnreachableWhy(deck.unreachableTimeout), lang).not.toMatch(PLATFORM_WORDS);
    }
    /* THE UNCLASSIFIED SENTENCE STOPS AT THE FULL STOP — no trailing separator left behind by a
       clause that was never supplied, which is the shape an optional hole produces. */
    expect(DECKS.en.unreachable).toBe("Could not reach that address.");
    expect(DECKS.en.unreachable.trimEnd()).toBe(DECKS.en.unreachable);
    expect(DECKS.de.unreachable.trimEnd()).toBe(DECKS.de.unreachable);
  });

  it("the pairing ceremony renders the named sentence for the exception the device showed", async () => {
    /* THE PRODUCER, DRIVEN — the same sequence the cleartext case above drives, one classifier
       over: `/hello` throws the platform's string and the refusal is what a person reads. */
    const world = sqlWorld();
    for (const [detail, clause] of [
      [DNS[0]!, "unreachableDns"], [REFUSED[0]!, "unreachableRefused"], [TIMEOUT[0]!, "unreachableTimeout"],
    ] as const) {
      const out = await pairThroughConfirm(
        {
          profiles: new ServerProfileStore(kvOf()),
          engineDeps: {
            openExecutor: world.open,
            deleteDatabase: world.drop,
            uuid: () => "00000000-0000-4000-8000-000000000000",
          },
          fetchImpl: () => Promise.reject(new Error(detail)),
        },
        { origin: "https://mail.example.com", token: "tok-1" },
      );
      expect(out.kind, detail).toBe("refused");
      if (out.kind !== "refused") return;
      const said = sayRefusal(out.reason);
      expect(said, detail).toBe(Copy.pairUnreachableWhy(Copy[clause]));
      /* …and specifically NOT the old rendering: the exception quoted into the sentence. */
      expect(said, detail).not.toMatch(PLATFORM_WORDS);
    }
  });

  it("gives an unclassified fault the sentence alone, never the platform's words", async () => {
    const world = sqlWorld();
    const out = await pairThroughConfirm(
      {
        profiles: new ServerProfileStore(kvOf()),
        engineDeps: {
          openExecutor: world.open,
          deleteDatabase: world.drop,
          uuid: () => "00000000-0000-4000-8000-000000000000",
        },
        fetchImpl: () => Promise.reject(new Error(UNNAMED)),
      },
      { origin: "https://mail.example.com", token: "tok-1" },
    );
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") return;
    expect(sayRefusal(out.reason)).toBe(Copy.pairUnreachable);
    expect(sayRefusal(out.reason)).not.toContain("Network request failed");
  });

  it("the CLAUSE follows a language switch, because it is nested and not rendered early", async () => {
    /* The nesting is the whole reason the clause is a refusal and not a string: built as
       `refuse("outer", sayRefusal(inner))` the outer sentence would follow a switch and the
       clause inside it would stay in the language the dial failed in. */
    const world = sqlWorld();
    try {
      resetLocaleRegisterForTests();
      const out = await pairThroughConfirm(
        {
          profiles: new ServerProfileStore(kvOf()),
          engineDeps: {
            openExecutor: world.open,
            deleteDatabase: world.drop,
            uuid: () => "00000000-0000-4000-8000-000000000000",
          },
          fetchImpl: () => Promise.reject(new Error(DNS[0]!)),
        },
        { origin: "https://mail.example.com", token: "tok-1" },
      );
      if (out.kind !== "refused") throw new Error("the probe was not refused");
      expect(sayRefusal(out.reason)).toBe(DECKS.en.pairUnreachableWhy(DECKS.en.unreachableDns));
      setActiveLocale("de");
      expect(sayRefusal(out.reason), "the clause inside the sentence stayed English")
        .toBe(DECKS.de.pairUnreachableWhy(DECKS.de.unreachableDns));
    } finally {
      resetLocaleRegisterForTests();
    }
  });

  it("the door's unreachable arm consults the classifier too — it is the second producer", () => {
    /* A SHAPE CHECK, for the reason the cleartext case states: `sentenceFor` lives in `Doors.tsx`,
       which imports react-native, and an Expo package's Flow-typed JavaScript cannot be loaded by
       this runner at all. The probe above is the driven half of the same pair. */
    const src = readFileSync(new URL("../src/ui/Doors.tsx", import.meta.url), "utf8");
    expect(src).toContain("const clause = unreachableSaid(n.detail);");
    expect(src).toContain('return clause === null ? refuse("unreachable") : refuse("unreachableWhy", clause);');
    expect(src, "the door quotes the transport into the sentence again")
      .not.toContain('refuse("unreachable", n.detail)');
    /* AND THE MAPPER IS THE ONE THE PROBE ABOVE DROVE — one table of clauses, two producers. */
    expect(src).toContain('unreachableSaid } from "../net/pairing"');
  });
});

/**
 * ═══ ONE FAULT, ONE CLASS — EVERY ARM OF THE PIN PATH, ON BOTH PLATFORMS ════════════════════
 *
 * `HANDSHAKE` held the bare word `hostname`, and BOTH platforms' DNS failures end in it: Android
 * "…: No address associated with hostname", iOS `Code=-1003 "A server with the specified hostname
 * could not be found."`. So a mistyped or dead address was reported as "this computer's key has
 * changed — pair this phone again", sending somebody to spend a fresh pairing code over a name
 * that never answered. Every cause a person can be in, in each platform's own words, asserted to
 * land in EXACTLY one class — which is the property the bare word broke, not any single arm.
 */
/**
 * A cause, EVERY wording each platform states it in, and the one class all of them may land in.
 * Several per platform on purpose: OkHttp's mismatch carries a `certificate:` dump, so a table
 * holding only that string measures the `certificate` alternative and reports it as the pin
 * arm — a mutation that removed both mismatch alternatives left this case GREEN. The bare forms
 * beside it are what a truncated `String(err)` and a version without the dump produce, and they
 * are the only strings that reach the alternative they are here to measure.
 */
const PIN_PATH: readonly {
  cause: string;
  android: readonly string[];
  ios: readonly string[];
  pin: boolean;
  clause: "unreachableDns" | "unreachableRefused" | "unreachableTimeout" | null;
}[] = [
  {
    cause: "a name that does not resolve",
    android: ['TypeError: Network request failed: java.net.UnknownHostException: Unable to resolve '
      + 'host "srv.invalid": No address associated with hostname'],
    ios: [
      'Error Domain=NSURLErrorDomain Code=-1003 "A server with the specified hostname could not '
      + 'be found."',
      "NSURLErrorCannotFindHost",
    ],
    pin: false,
    clause: "unreachableDns",
  },
  {
    cause: "a port that refuses",
    android: ["java.net.ConnectException: failed to connect to /10.0.2.2 (port 6245)"],
    ios: [
      'Error Domain=NSURLErrorDomain Code=-1004 "Could not connect to the server."',
      "NSURLErrorCannotConnectToHost",
    ],
    pin: false,
    clause: "unreachableRefused",
  },
  {
    cause: "a dial that hangs",
    android: ["java.net.SocketTimeoutException: timeout"],
    ios: [
      'Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."',
      "NSURLErrorTimedOut",
    ],
    pin: false,
    clause: "unreachableTimeout",
  },
  {
    /* A certificate the trust store will not have: the desktop door's self-signed key judged by
       the platform — what a phone that did not pin sees, and what a pinned phone sees once the
       key it pinned is gone. iOS's second form carries the CODE and no description, which is the
       only string here that reaches the documented-constant alternative. */
    cause: "a certificate nothing vouches for",
    android: ["javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: "
      + "Trust anchor for certification path not found."],
    ios: [
      'Error Domain=NSURLErrorDomain Code=-1202 "The certificate for this server is invalid."',
      "Error Domain=NSURLErrorDomain Code=-1203",
    ],
    pin: true,
    clause: null,
  },
  {
    /* THE PIN MISMATCH ITSELF — OkHttp's words when `PinnedHosts.hostnameVerifier` returns false,
       the one shape meaning the key moved rather than the network died. First as it is emitted,
       then without the dump and then the phrase alone: only the last two reach the mismatch
       alternatives. iOS is EMPTY — there is no iOS pinning half (the case below measures that). */
    cause: "a pinned host presenting another key",
    android: [
      "javax.net.ssl.SSLPeerUnverifiedException: Hostname 10.0.2.2 not verified:\n"
      + "    certificate: sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "javax.net.ssl.SSLPeerUnverifiedException: Hostname 10.0.2.2 not verified",
      "Hostname 10.0.2.2 not verified",
    ],
    ios: [],
    pin: true,
    clause: null,
  },
];

describe("every arm of the pin path lands in exactly one class, on both platforms", () => {
  it("classifies each cause, in each platform's own words, and never twice", () => {
    for (const row of PIN_PATH) {
      for (const [platform, texts] of [["android", row.android], ["ios", row.ios]] as const) {
        for (const text of texts) {
        const where = `${platform}/${row.cause}/${text.slice(0, 28)}`;
        expect(isPinFailure(text), where).toBe(row.pin);
        expect(unreachableClause(text), where).toBe(row.clause);
        /* None of the five is a peer answering without TLS — that dial has its own two arms
           above, and a string meaning two things is how a changed key becomes a typo. */
        expect(isNotTls(text), where).toBe(false);
        const classes = [row.pin, row.clause !== null, isNotTls(text)].filter(Boolean).length;
        expect(classes, `${where} lands in ${classes} classes`).toBe(1);
        }
      }
    }
  });

  it("the sync sentence follows the classifier — a dead name keeps its detail on a PINNED profile", () => {
    /* THE THIRD CONSUMER, and the one no `pin !== null` gate protects: `connectSyncFailed` asks
       the classifier itself. On a pinned profile the DNS text used to produce "pair this phone
       again" — the changed-key sentence, over a name that never answered. */
    const dns = PIN_PATH[0]!.android[0]!;
    for (const pinned of [true, false]) {
      const said = Copy.connectSyncFailed(dns, pinned);
      expect(said, String(pinned)).toContain("the mirror keeps what it has");
      expect(said, String(pinned)).not.toContain("pair this phone again");
      expect(said, String(pinned)).not.toContain("would not accept the certificate");
    }
    /* …and the key that really did change still gets the changed-key sentence. */
    expect(Copy.connectSyncFailed(PIN_PATH[4]!.android[1]!, true)).toContain("pair this phone again");
  });

  it("the PROBE renders the cause, not a changed key — the pin !== null site, driven", async () => {
    /* THE PRODUCER at `pin !== null && isPinFailure(negotiated.detail)`. An IP literal needs a
       pin (`originNeedsPin`), so the fake registry is installed to make `canPin()` true and the
       admission real; `/hello` then throws each platform string and the refusal is what a person
       reads. Without a stored profile a genuine mismatch is `pairKeyMismatch`, not `pinChanged` —
       first contact, where "pair again with a fresh code" walks somebody into it a second time. */
    installPinning(fakeNative());
    const world = sqlWorld();
    for (const row of PIN_PATH) {
      for (const text of [...row.android, ...row.ios]) {
        const out = await probePairing(
          {
            profiles: new ServerProfileStore(kvOf()),
            engineDeps: {
              openExecutor: world.open,
              deleteDatabase: world.drop,
              uuid: () => "00000000-0000-4000-8000-000000000000",
            },
            fetchImpl: () => Promise.reject(new Error(text)),
          },
          { origin: "https://192.168.1.10:6245", pin: PIN_A },
        );
        expect(out.kind, text).toBe("refused");
        if (out.kind !== "refused") return;
        const said = sayRefusal(out.reason);
        expect(said, text).toBe(
          row.clause === null ? Copy.pairKeyMismatch : Copy.pairUnreachableWhy(Copy[row.clause]),
        );
        /* And never the platform's own words, whichever arm answered. */
        expect(said, text).not.toMatch(/java\.|Exception|NSURL|Code=-/);
      }
    }
  });

  it("iOS CANNOT reach a pin mismatch, so its phrase is NOT MEASURED — and this says when it can", () => {
    /* The honest half of the row above. There is no iOS pinning module, so `canPin()` is false
       there and `admitOrigin` refuses a pinned pairing before anything dials: no iOS pin-mismatch
       string exists to take. This case reads the module's own platform list, so the day iOS is
       added it goes RED — which is the day the phrase must be measured on a device and added. */
    const cfg = JSON.parse(readFileSync(
      new URL("../modules/host-pinning/expo-module.config.json", import.meta.url), "utf8",
    )) as { platforms: string[] };
    expect(cfg.platforms, "an iOS pinning half exists — measure its mismatch phrase").toEqual(["android"]);
    expect(PIN_PATH[4]!.ios, "the iOS mismatch wording is now measurable and must be taken").toEqual([]);
  });
});

/** The keystore double the cases above need — the same map-backed shape used higher up. */
function kvOf(): SecureKV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}
