/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE NOTIFICATION PERMISSION — asked once, at the press, and said plainly when it is refused
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * On Android 13+ `POST_NOTIFICATIONS` starts DENIED. The organizer's foreground service reads
 * `areNotificationsEnabled()` and answers `false` before the system is asked to start anything, so
 * `background.ts` hands the mailbox back and the phone organizes only while the app is open —
 * nothing hidden, nothing killed, the app declining. Three device runs before this one granted the
 * permission with `pm grant` first and therefore measured the wiring and never the permission.
 *
 * The double fails the way the platform fails, BY API LEVEL: below 33 `POST_NOTIFICATIONS` does
 * not exist, so it reads `false` and `request` returns with no dialog whatever the switch says;
 * from 33 the permission and the switch are one fact. Every call is counted — a rule that asks
 * twice is only visible as a count.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import {
  answerLeavesNotificationsOff,
  markOrganizerNotificationAsked,
  notificationBacksOrganizing,
  notificationsOffHere,
  NOTIFICATION_PERMISSION_API,
  organizerNotificationEnabled,
  readNotificationsEnabled,
  recordLiveNotificationState,
  requestOrganizerNotification,
  shouldAskForOrganizerNotification,
  type NotificationAnswer,
  type NotificationPermissionHost,
} from "../src/engine/notification-permission";
import {
  forgetOrganizerSessionForTests,
  organizerNotificationsOffSaid,
  sayNotificationsOff,
  sayNotificationsOn,
} from "../src/engine/organizer-session";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8");

/* ── the double ───────────────────────────────────────────────────────────────────────────── */

interface HostLog {
  /** Reads of `POST_NOTIFICATIONS`, and of the service's own gate — counted apart. */
  permission: number;
  gate: number;
  requested: number;
  wrote: number;
  read: number;
}

function host(over: {
  platform?: string;
  /** Android's `SDK_INT`. 34 unless a case is about a level. */
  sdk?: number;
  /** The app's notification switch — what the service's gate reads on every level. */
  enabled?: boolean;
  asked?: boolean;
  answer?: NotificationAnswer;
  /** Every call throws — the arm where the platform cannot answer at all. */
  broken?: boolean;
  /** The organizer module is absent, so the service's gate cannot be asked. */
  noModule?: boolean;
} = {}): { host: NotificationPermissionHost; log: HostLog } {
  const log: HostLog = { permission: 0, gate: 0, requested: 0, wrote: 0, read: 0 };
  const platform = over.platform ?? "android";
  const sdk = platform === "android" ? over.sdk ?? 34 : 0;
  const hasPermission = sdk >= 33;
  let enabled = over.enabled ?? false;
  let asked = over.asked ?? false;
  const boom = (): never => { throw new Error("no such module"); };
  return {
    log,
    host: {
      platform,
      apiLevel: sdk,
      /* Below 33 the permission is undefined and `checkSelfPermission` answers DENIED. */
      permissionGranted: async () => {
        log.permission += 1;
        if (over.broken) boom();
        return hasPermission && enabled;
      },
      switchOn: async () => {
        log.gate += 1;
        if (over.broken) boom();
        return over.noModule ? null : enabled;
      },
      request: async () => {
        log.requested += 1;
        if (over.broken) boom();
        /* No dialog below 33: React Native resolves NEVER_ASK_AGAIN and nothing changes. */
        if (!hasPermission) return "blocked";
        const answer = over.answer ?? "denied";
        /* THE PLATFORM'S OWN CONSEQUENCE: a granted permission makes the next `enabled` true. A
           double whose two answers could disagree for ever would let a rule pass that the phone
           would refuse. */
        if (answer === "granted") enabled = true;
        return answer;
      },
      readAsked: async () => { log.read += 1; if (over.broken) boom(); return asked; },
      writeAsked: async () => { log.wrote += 1; if (over.broken) boom(); asked = true; },
    },
  };
}

beforeEach(() => { forgetOrganizerSessionForTests(); });

/* ── who is asked at all ──────────────────────────────────────────────────────────────────── */

describe("the platform decides whether there is anything to ask for", () => {
  it("asks on Android and nowhere else — iOS shows no organizer notification", () => {
    /**
     * `nativeBackgroundService()` answers `null` on iOS, `expo-notifications` is banned from this
     * build and there is no `UIBackgroundModes` entry: an iPhone posts no organizer notification,
     * so there is no permission to ask for and no state to render. The default arm is the iOS one
     * — a platform this app has not met must not be asked for a permission it may not have.
     */
    expect(notificationBacksOrganizing("android")).toBe(true);
    expect(notificationBacksOrganizing("ios")).toBe(false);
    expect(notificationBacksOrganizing("web")).toBe(false);
  });

  it("never asks on iOS, whatever the OS would answer", async () => {
    const ios = host({ platform: "ios", enabled: false, asked: false });
    expect(await shouldAskForOrganizerNotification(ios.host)).toBe(false);
    expect(ios.log.permission + ios.log.gate, "iOS was asked about a notification it does not have")
      .toBe(0);
    expect(await readNotificationsEnabled(ios.host)).toBeNull();
  });
});

/* ── the one ask ──────────────────────────────────────────────────────────────────────────── */

describe("the ask fires exactly once, and only where it is owed", () => {
  it("a first install with the permission denied is asked", async () => {
    const h = host({ enabled: false, asked: false });
    expect(await shouldAskForOrganizerNotification(h.host)).toBe(true);
  });

  it("an install that already holds the permission is NOT prompted", async () => {
    /* The already-granted arm — a `pm grant`ed rig, a re-install on a phone that kept the grant,
       or somebody who said yes the first time. A prompt here is a dialog about nothing. */
    const h = host({ enabled: true, asked: false });
    expect(await shouldAskForOrganizerNotification(h.host)).toBe(false);
    expect(h.log.requested).toBe(0);
  });

  it("a refusal is not asked again — the re-prompt loop, which would be invisible", async () => {
    /**
     * Android refuses to show the dialog again after a denial, so a second request would put OUR
     * sentence on screen in front of a system prompt that never appears. The record is what stops
     * it, and it is spent whatever the person did with the sheet.
     */
    const h = host({ enabled: false, asked: false });
    expect(await shouldAskForOrganizerNotification(h.host)).toBe(true);
    await markOrganizerNotificationAsked(h.host);
    expect(await shouldAskForOrganizerNotification(h.host)).toBe(false);
    expect(await shouldAskForOrganizerNotification(h.host), "a third press asked again").toBe(false);
    expect(h.log.wrote).toBe(1);
  });

  it("the record is spent by the sentence going up, not by a pressed Continue", async () => {
    /* A dismissal is an answer. If only a pressed Continue wrote the record, the sheet would come
       back at every later start press — the same loop wearing our own sheet. */
    const h = host({ enabled: false, asked: false });
    await markOrganizerNotificationAsked(h.host);
    expect(h.log.requested, "the record write called the system prompt").toBe(0);
    expect(await shouldAskForOrganizerNotification(h.host)).toBe(false);
  });

  it("carries Android's three answers through, and only `granted` clears the state", async () => {
    for (const answer of ["granted", "denied", "blocked"] as const) {
      const h = host({ enabled: false, answer });
      expect(await requestOrganizerNotification(h.host)).toBe(answer);
      expect(answerLeavesNotificationsOff(answer)).toBe(answer !== "granted");
    }
  });

  it("a granted permission ends the ask for good — the OS answers the next press", async () => {
    const h = host({ enabled: false, asked: false, answer: "granted" });
    expect(await shouldAskForOrganizerNotification(h.host)).toBe(true);
    await markOrganizerNotificationAsked(h.host);
    expect(await requestOrganizerNotification(h.host)).toBe("granted");
    /* Both halves now refuse: the record, and the permission the phone actually holds. */
    expect(await shouldAskForOrganizerNotification(h.host)).toBe(false);
    expect(await readNotificationsEnabled(h.host)).toBe(true);
  });

  it("a platform that cannot answer asks for nothing and throws nothing", async () => {
    const h = host({ broken: true });
    expect(await shouldAskForOrganizerNotification(h.host)).toBe(false);
    expect(await requestOrganizerNotification(h.host)).toBe("denied");
    await expect(markOrganizerNotificationAsked(h.host)).resolves.toBeUndefined();
    expect(await readNotificationsEnabled(h.host)).toBeNull();
  });
});

/* ── the state the panel renders ──────────────────────────────────────────────────────────── */

describe("the off-state", () => {
  it("has three answers, and `not read yet` is not `off`", () => {
    /* `null` is the value before the panel's first read settles. Read as "off" it would put
       "Notifications are off" under the chip a second after Settings opened. */
    expect(notificationsOffHere("android", false)).toBe(true);
    expect(notificationsOffHere("android", true)).toBe(false);
    expect(notificationsOffHere("android", null)).toBe(false);
    expect(notificationsOffHere("ios", false), "an iPhone was told its notifications are off")
      .toBe(false);
  });

  it("is recorded, and CLEARED when the permission comes back", () => {
    /**
     * The permission can be given back in system settings at any moment and nothing inside the app
     * is told. A record that could only be set would keep the sentence on screen over a phone that
     * had just been given the notification — the false-state class this design exists to prevent.
     */
    expect(organizerNotificationsOffSaid()).toBe(false);
    sayNotificationsOff();
    expect(organizerNotificationsOffSaid()).toBe(true);
    sayNotificationsOn();
    expect(organizerNotificationsOffSaid(), "the refusal outlived the permission").toBe(false);
  });
});

/* ── by API level: one answer for the sentence, the press and the service ─────────────────── */

describe("one answer on every Android level — the sentence, the press and the service's gate", () => {
  /** minSdk is 24; 32 is the last level without the permission, 33 the first with it. */
  const LEVELS = [24, 32, 33, 36] as const;
  const say = { off: sayNotificationsOff, on: sayNotificationsOn };

  it("the panel's record is what the service's gate answers, in every cell", async () => {
    /**
     * `OrganizerService.canPostNotification` is what `start` refuses on, so it decides whether the
     * phone organizes behind a notification. The record starts in the WRONG state for each cell,
     * so a read that never moved it cannot pass.
     */
    for (const sdk of LEVELS) {
      for (const on of [true, false]) {
        forgetOrganizerSessionForTests();
        if (on) sayNotificationsOff();
        const h = host({ sdk, enabled: on });
        const serviceStarts = await h.host.switchOn();
        await recordLiveNotificationState(h.host, say);
        expect(organizerNotificationsOffSaid(), `API ${sdk}, switch ${on ? "on" : "off"}`)
          .toBe(!serviceStarts);
      }
    }
  });

  it("API 32 with the switch on: the service runs, so the sentence is not shown", async () => {
    /* The false state this fixes: the permission read answered `false` on every Android 7-12 phone
       and Settings said notifications were off over a service that was running. */
    const h = host({ sdk: 32, enabled: true });
    expect(await readNotificationsEnabled(h.host)).toBe(true);
    await recordLiveNotificationState(h.host, say);
    expect(organizerNotificationsOffSaid(), "notifications 'off' over a running service").toBe(false);
  });

  it("reads the gate on every level — alone below 33, after the permission from 33", async () => {
    /* The gate also reads the `organizing` channel (FIX-026 row 93), which the permission cannot
       see, so from 33 it follows the permission rather than being skipped. */
    for (const sdk of LEVELS) {
      const h = host({ sdk, enabled: true });
      await readNotificationsEnabled(h.host);
      const below = sdk < NOTIFICATION_PERMISSION_API;
      expect(h.log.gate, `API ${sdk} gate reads`).toBe(1);
      expect(h.log.permission, `API ${sdk} permission reads`).toBe(below ? 0 : 1);
    }
  });

  it("from 33 a granted permission over a closed gate is off — the channel turned off", async () => {
    forgetOrganizerSessionForTests();
    expect(organizerNotificationsOffSaid(), "control: the record starts on").toBe(false);
    const h = host({ sdk: 34, enabled: true });
    h.host.switchOn = async () => { h.log.gate += 1; return false; };
    expect(await organizerNotificationEnabled(h.host), "the permission alone answered for a gate that refuses")
      .toBe(false);
    await recordLiveNotificationState(h.host, say);
    expect(organizerNotificationsOffSaid(), "the panel stayed silent over a hidden notification").toBe(true);
    /* A refused permission answers without asking further, and a missing module keeps its answer. */
    const refused = host({ sdk: 34, enabled: false });
    expect(await organizerNotificationEnabled(refused.host)).toBe(false);
    expect(refused.log.gate).toBe(0);
    expect(await organizerNotificationEnabled(host({ sdk: 34, enabled: true, noModule: true }).host)).toBe(true);
  });

  it("below 33 with no module to ask, the answer is 'could not ask' — never off", async () => {
    const h = host({ sdk: 32, enabled: true, noModule: true });
    expect(await readNotificationsEnabled(h.host)).toBeNull();
    await recordLiveNotificationState(h.host, say);
    expect(organizerNotificationsOffSaid()).toBe(false);
    expect(await shouldAskForOrganizerNotification(h.host)).toBe(false);
  });

  it("the sheet is shown only where a system prompt exists — API 33 and up", async () => {
    /**
     * Below 33 the sheet's Continue led to no dialog and recorded "off" again. The ask is not
     * spent there either, so the same install is still asked once the phone reaches 13.
     */
    for (const sdk of [24, 32]) {
      const h = host({ sdk, enabled: false, asked: false });
      expect(await shouldAskForOrganizerNotification(h.host), `API ${sdk} asked`).toBe(false);
      expect(h.log.requested).toBe(0);
      expect(h.log.wrote).toBe(0);
    }
    for (const sdk of [33, 36]) {
      expect(await shouldAskForOrganizerNotification(host({ sdk, enabled: false }).host)).toBe(true);
      expect(await shouldAskForOrganizerNotification(host({ sdk, enabled: true }).host)).toBe(false);
    }
  });

  it("the switch JS reads IS the gate `start` refuses on — one Kotlin function, three readers", () => {
    /* The one mapping the node suite cannot drive: the native twin's `switchOn` reaches the
       module's `canPostNotification`, whose body is the function `start` answers `false` from. */
    const twin = withoutComments(read("src/engine/notification-permission-native.ts"));
    const switchAt = twin.indexOf("switchOn:");
    expect(switchAt, "no switchOn in the native twin").toBeGreaterThan(-1);
    const switchBody = twin.slice(switchAt, twin.indexOf("request:", switchAt));
    expect(switchBody).toContain("organizerCanPostNotification()");
    expect(switchBody).not.toContain("PermissionsAndroid");

    const bg = withoutComments(read("src/engine/background-native.ts"));
    const fnAt = bg.indexOf("export function organizerCanPostNotification()");
    expect(fnAt).toBeGreaterThan(-1);
    const fnBody = bg.slice(fnAt, bg.indexOf("\n}", fnAt));
    expect(fnBody).toContain("mod.canPostNotification()");

    const kt = withoutComments(read(
      "modules/organizer-service/android/src/main/java/app/ohmail/organizer/OrganizerServiceModule.kt",
    ));
    const gate = /Function\("canPostNotification"\) \{([^}]*)\}/.exec(kt);
    expect(gate, "the module exposes no canPostNotification").not.toBeNull();
    expect(gate![1]!.trim()).toBe("OrganizerService.canPostNotification(context)");
    const start = kt.slice(kt.indexOf('AsyncFunction("start")'), kt.indexOf('AsyncFunction("stop")'));
    expect(start).toContain("if (!OrganizerService.canPostNotification(context)) return@AsyncFunction false");
  });

  it("iOS reads neither fact at any level — kept equal by having nothing to ask", async () => {
    const ios = host({ platform: "ios", enabled: false });
    expect(await readNotificationsEnabled(ios.host)).toBeNull();
    await recordLiveNotificationState(ios.host, say);
    expect(organizerNotificationsOffSaid()).toBe(false);
    expect(ios.log.permission + ios.log.gate + ios.log.requested).toBe(0);
  });
});

/* ── where the ask is wired, read as source ───────────────────────────────────────────────── */

describe("the two presses, and the launch that is not one", () => {
  it("the door asks AFTER the mailbox is open and BEFORE the Ohbox", () => {
    /**
     * Before the dial it would spend the one ask on a press the mail server may still refuse;
     * after the navigation there would be no screen left to carry the sheet. Ordered against the
     * adopt, which is the moment organizing has actually begun on this phone.
     */
    const src = read("app/standalone.tsx");
    const adopted = src.indexOf("const adopted = await conn.openStandalone(outcome.door);");
    const gate = src.indexOf("await notify.gate();");
    const nav = src.indexOf('router.replace("/");');
    expect(adopted).toBeGreaterThan(-1);
    expect(gate, "the door never asks for the notification").toBeGreaterThan(adopted);
    expect(gate, "the ask is after the screen is replaced").toBeLessThan(nav);
    expect(src).toContain("<NotifyPermission open={notify.open} onAnswer={notify.answer} />");
  });

  it("the panel asks only where the start actually started", () => {
    const src = read("app/settings.tsx");
    expect(src).toContain('if (outcome === "started") await notify.gate();');
    expect(src).toContain("<NotifyPermission open={notify.open} onAnswer={notify.answer} />");
  });

  it("NOTHING on the launch path asks — a relaunch raises a session with no press behind it", () => {
    /**
     * `reopenWithBackground` starts an organizer session on every relaunch that adopts a stored
     * standalone row, so a request inside `startOrganizerSession` — or anywhere it reaches — would
     * be a permission dialog in front of somebody who only opened their mail.
     */
    for (const file of [
      "src/net/connection.tsx",
      "src/engine/organizer-session.ts",
      "src/engine/organizer-session-native.ts",
      "src/engine/background.ts",
      "src/engine/background-native.ts",
    ]) {
      expect(read(file), `${file} asks for the notification permission`)
        .not.toMatch(/notify\.gate|requestOrganizerNotification|shouldAskForOrganizerNotification/);
    }
  });

  it("the sequence lives in ONE hook, so the two presses cannot drift", () => {
    const hook = read("src/ui/useNotifyPermission.ts");
    /* Decide, spend, show — in that order, and read from `gate`'s OWN BODY: an `indexOf` over the
       whole file finds the import block, where the order is alphabetical and means nothing. */
    const body = hook.slice(hook.indexOf("const gate = useCallback"));
    const decide = body.indexOf("shouldAskForOrganizerNotification");
    const spend = body.indexOf("markOrganizerNotificationAsked");
    const show = body.indexOf("setOpen(true)");
    expect(decide).toBeGreaterThan(-1);
    expect(spend, "the ask is spent before it is decided").toBeGreaterThan(decide);
    expect(show, "the sheet opens before the ask is spent").toBeGreaterThan(spend);
    expect(hook).toContain("requestOrganizerNotification");
    expect(hook).toContain("sayNotificationsOff");
    expect(hook).toContain("sayNotificationsOn");
  });

  it("does NOT borrow the wake notice's request, which lies on an emulator", () => {
    /**
     * `expo-unified-push` short-circuits `requestPermissions()` to `"denied"` and
     * `checkPermissions()` to `false` whenever it detects an emulator, with no dialog. Borrowed
     * here it would record a permanent refusal on every emulator — including the rig this has to
     * be measured on — for a permission the device may well hold.
     */
    /* COMMENTS STRIPPED: the file's own header names the module it refuses to use, and a needle
       that a comment satisfies measures the prose rather than the code. */
    const native = read("src/engine/notification-permission-native.ts")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
    expect(native, "the stripper ate the file").toContain("nativeNotificationPermission");
    expect(native).not.toContain("unified-push");
    expect(native).toContain("PermissionsAndroid");
    expect(native).toContain("POST_NOTIFICATIONS");
    /* And the way back, because the app cannot grant it: Android never re-asks after a refusal. */
    expect(native).toContain("Linking.openSettings()");
  });

  it("the app declares the permission in its own right", () => {
    /**
     * It reached the merged manifest only through `expo-unified-push`'s own manifest, so the
     * organizer's permission depended on a push module staying installed. Additive by
     * construction — `@expo/config-plugins` adds a permission that is not already requested and
     * removes none — so this changes nothing but who owns the declaration.
     */
    const appJson = JSON.parse(read("app.json")) as {
      expo: { android: { permissions?: string[] } };
    };
    expect(appJson.expo.android.permissions).toContain("android.permission.POST_NOTIFICATIONS");
  });
});

/* ── the words ────────────────────────────────────────────────────────────────────────────── */

describe("the sentences, in both languages", () => {
  it("both decks carry every key this change adds", () => {
    for (const deck of [EN, DE]) {
      for (const key of [
        "organizerNotifyTitle", "organizerNotifyWhy", "organizerNotifyGo",
        "organizerNotifyNotNow", "organizerNotificationsOff", "organizerNotificationsSettings",
      ] as const) {
        expect(deck[key].length, `${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("the rationale states the consequence, which is what the build actually does", () => {
    /**
     * Measured: with the permission denied, `OrganizerServiceModule.start` answers `false` before
     * `startForegroundService` is called, `background.ts` declines and hands the mailbox back. So
     * "organizing stops when you leave the app" is the true half of the sentence, not a warning.
     */
    expect(EN.organizerNotifyWhy).toMatch(/notification/i);
    expect(EN.organizerNotifyWhy).toMatch(/stops when you leave the app/);
    expect(DE.organizerNotifyWhy).toMatch(/Benachrichtigung/);
    expect(DE.organizerNotifyWhy).toMatch(/verlässt/);
  });

  it("the off-state names what is off AND what still happens — never only the loss", () => {
    expect(EN.organizerNotificationsOff).toMatch(/[Nn]otifications are off/);
    expect(EN.organizerNotificationsOff).toMatch(/while the app is open/);
    expect(DE.organizerNotificationsOff).toMatch(/Benachrichtigungen sind aus/);
    expect(DE.organizerNotificationsOff).toMatch(/offen ist/);
  });

  it("the off-state is NOT the battery-saver sentence — the lie this change removes", () => {
    /**
     * Both declines reached `announceRestricted`, whose sentence names battery saver. On an
     * Android 13+ first install the cause is the notification permission and that sentence is
     * false; the panel said it anyway, and it was the only thing it said.
     */
    for (const deck of [EN, DE]) {
      expect(deck.organizerNotificationsOff).not.toBe(deck.organizerRestricted);
      expect(deck.organizerNotificationsOff.toLowerCase())
        .not.toMatch(/battery saver|energiesparmodus/);
    }
  });

  it("no sentence promises a notification on a platform that has none", () => {
    /* The `platformRuleLine` rule: an iPhone shows no organizer notification, so a per-platform
       sentence that named one would be false on half the installs this deck serves. */
    for (const deck of [EN, DE]) {
      expect(deck.organizerNotificationsOff.toLowerCase()).not.toMatch(/iphone|android/);
      expect(deck.organizerNotifyWhy.toLowerCase()).not.toMatch(/iphone|android/);
    }
  });
});
