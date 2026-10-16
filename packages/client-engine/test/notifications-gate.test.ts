import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNELS,
  decideNotices,
  channelsAreLive,
  type NoticeSnapshot,
  type NotificationChannels,
} from "../src/notifications.js";

/**
 * THE GATE — the behavioural half of "fully off means no code path fires".
 *
 * The other half is the source census (`notifications-gate-census`), which asserts no surface
 * draws a notice without coming through here. This file asserts that coming through here with the
 * master off produces nothing to draw. Neither is sufficient alone: the census cannot tell whether
 * the gate's answer is right, and this cannot tell whether somebody added a fourth emitter that
 * skips it.
 */

const base: NoticeSnapshot = { ohboxUnread: 0, screenerWaiting: 0 };
const all = (over: Partial<NotificationChannels> = {}): NotificationChannels => ({
  ...DEFAULT_CHANNELS,
  ...over,
});

describe("the two absolute refusals", () => {
  it("draws NOTHING when the master is off, however much arrived", () => {
    const out = decideNotices(
      base,
      {
        ohboxUnread: 9,
        screenerWaiting: 4,
        scheduledOutcomes: [{ id: "s1", outcome: "failed", reason: "no connection" }],
        pairingEvents: [{ id: "p1", kind: "paired", device: "Pixel" }],
      },
      all({ master: false }),
      "granted",
    );
    expect(out, "the master switch did not silence every channel").toEqual([]);
  });

  it("draws NOTHING when the OS has not granted permission — for each non-granted state", () => {
    for (const p of ["denied", "default", "unsupported"] as const) {
      const out = decideNotices(base, { ohboxUnread: 5, screenerWaiting: 0 }, all(), p);
      expect(out, `a notice was produced while the OS said ${p}`).toEqual([]);
    }
  });

  it("the first sample seeds and never notifies — eleven unread is not eleven arrivals", () => {
    expect(decideNotices(null, { ohboxUnread: 11, screenerWaiting: 3 }, all(), "granted"))
      .toEqual([]);
  });
});

describe("each switch silences its own event and nothing else", () => {
  const busy: NoticeSnapshot = {
    ohboxUnread: 3,
    screenerWaiting: 2,
    scheduledOutcomes: [{ id: "s1", outcome: "sent" }],
    pairingEvents: [{ id: "p1", kind: "paired" }],
  };

  it("all four on ⇒ all four fire", () => {
    const events = decideNotices(base, busy, all(), "granted").map((n) => n.event);
    expect(new Set(events)).toEqual(new Set(["ohbox", "screener", "scheduled", "pairing"]));
  });

  for (const off of ["ohbox", "screener", "scheduled", "pairing"] as const) {
    it(`${off} off ⇒ no ${off} notice, and the other three still fire`, () => {
      const events = decideNotices(base, busy, all({ [off]: false }), "granted")
        .map((n) => n.event);
      expect(events, `${off} fired with its own switch off`).not.toContain(off);
      expect(events, `turning ${off} off silenced something else too`).toHaveLength(3);
    });
  }
});

describe("a rise is an event; a fall is somebody reading their mail", () => {
  it("notifies on a rise, with the DELTA and not the total", () => {
    const out = decideNotices({ ...base, ohboxUnread: 2 }, { ...base, ohboxUnread: 5 }, all(), "granted");
    expect(out).toEqual([{ event: "ohbox", count: 3 }]);
  });

  it("says nothing when the count falls or holds", () => {
    for (const now of [2, 0]) {
      expect(decideNotices({ ...base, ohboxUnread: 2 }, { ...base, ohboxUnread: now }, all(), "granted"))
        .toEqual([]);
    }
  });
});

describe("the content rule", () => {
  const arrival: NoticeSnapshot = {
    ohboxUnread: 1,
    screenerWaiting: 0,
    latestSender: "Petra Muhr",
    latestSubject: "Thursday",
  };

  it("omits sender and subject by DEFAULT, even when the snapshot carries them", () => {
    const [n] = decideNotices(base, arrival, all(), "granted");
    expect(DEFAULT_CHANNELS.showSenderAndSubject, "the identifying switch defaults ON").toBe(false);
    expect(n).toEqual({ event: "ohbox", count: 1 });
  });

  it("includes them only when the switch is on", () => {
    const [n] = decideNotices(base, arrival, all({ showSenderAndSubject: true }), "granted");
    expect(n).toEqual({ event: "ohbox", count: 1, sender: "Petra Muhr", subject: "Thursday" });
  });

  it("names nobody when SEVERAL arrived — one of six is an arbitrary pick", () => {
    const [n] = decideNotices(
      base,
      { ...arrival, ohboxUnread: 6 },
      all({ showSenderAndSubject: true }),
      "granted",
    );
    expect(n).toEqual({ event: "ohbox", count: 6 });
  });

  it("never names a Screener sender, even with the switch on — they are not admitted yet", () => {
    const [n] = decideNotices(
      base,
      { ohboxUnread: 0, screenerWaiting: 1, latestSender: "stranger@example.com" },
      all({ showSenderAndSubject: true }),
      "granted",
    );
    expect(n).toEqual({ event: "screener", count: 1 });
    expect(JSON.stringify(n)).not.toContain("stranger");
  });

  it("carries no body or snippet field on ANY spec, under any setting", () => {
    const out = decideNotices(
      base,
      {
        ohboxUnread: 1,
        screenerWaiting: 1,
        scheduledOutcomes: [{ id: "s", outcome: "failed", reason: "no connection", subject: "Re: hi" }],
        pairingEvents: [{ id: "p", kind: "revoked", device: "old laptop" }],
        latestSender: "A",
        latestSubject: "B",
      },
      all({ showSenderAndSubject: true }),
      "granted",
    );
    for (const spec of out) {
      for (const k of Object.keys(spec)) {
        expect(["body", "snippet", "preview", "text"], `${spec.event} carries ${k}`).not.toContain(k);
      }
    }
  });
});

describe("scheduled sends — both outcomes, because silence reports one of them wrongly", () => {
  it("reports a failure with its reason", () => {
    const out = decideNotices(
      base,
      { ...base, scheduledOutcomes: [{ id: "s1", outcome: "failed", reason: "no connection" }] },
      all(),
      "granted",
    );
    expect(out).toEqual([{ event: "scheduled", outcome: "failed", reason: "no connection" }]);
  });

  it("reports a success too", () => {
    const out = decideNotices(
      base,
      { ...base, scheduledOutcomes: [{ id: "s1", outcome: "sent" }] },
      all(),
      "granted",
    );
    expect(out).toEqual([{ event: "scheduled", outcome: "sent" }]);
  });
});

describe("pairing — a security event, so the device label is not gated on the content switch", () => {
  it("names the device with the content switch OFF", () => {
    const out = decideNotices(
      base,
      { ...base, pairingEvents: [{ id: "p1", kind: "paired", device: "Pixel 8" }] },
      all({ showSenderAndSubject: false }),
      "granted",
    );
    expect(out).toEqual([{ event: "pairing", kind: "paired", device: "Pixel 8" }]);
  });
});

describe("channelsAreLive — what the pane renders", () => {
  it("is false whenever the OS refuses, whatever the master says", () => {
    for (const p of ["denied", "default", "unsupported"] as const) {
      expect(channelsAreLive(all(), p)).toBe(false);
    }
  });
  it("is false when the master is off even on a granted OS", () => {
    expect(channelsAreLive(all({ master: false }), "granted")).toBe(false);
  });
  it("is true only when both agree", () => {
    expect(channelsAreLive(all(), "granted")).toBe(true);
  });
});
