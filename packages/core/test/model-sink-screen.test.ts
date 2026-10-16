import { describe, expect, it } from "vitest";
import {
  screenModelInput, screenOutboundText, MODEL_SINK_REFUSAL_SENTENCE,
} from "../src/sensitive.js";

/**
 * THE DOOR EVERY MODEL SINK PASSES THROUGH — and the defect it closes.
 *
 * The per-field ingest flags screen each column on its own. A credential written across two of
 * them satisfies every one of those flags and is a credential again the moment the sink joins the
 * columns into a payload. Each fixture below is checked FIELD BY FIELD first, so a case cannot
 * quietly become one the old per-field screen would also have caught.
 */

/** Invented, in the shape providers use. Nothing here is anybody's real credential. */
const SPLIT = { subject: "Your passphrase", snippet: "It is 481920, on the label." };
const ORDINARY = {
  subject: "Lunch on Thursday",
  snippet: "Can we move it to 1pm at the usual place? I will book the table.",
  from: "lena@example.test",
};

describe("the split a per-field screen cannot see", () => {
  it("passes every field on its own and refuses the join", () => {
    expect(screenOutboundText(SPLIT.subject).safe, "the subject alone").toBe(true);
    expect(screenOutboundText(SPLIT.snippet).safe, "the snippet alone").toBe(true);

    const v = screenModelInput([{ label: "incoming", fields: [SPLIT.subject, SPLIT.snippet] }]);
    expect(v.admitted).toBe(false);
    expect(v.reason).toBe("credential_shape");
    expect(v.where).toBe("incoming");
  });

  it("refuses a split that lands in the vocabulary class, and names that class", () => {
    const subject = "Your verification";
    const snippet = "code is ready, tap the button below to continue.";
    expect(screenOutboundText(subject).safe).toBe(true);
    expect(screenOutboundText(snippet).safe).toBe(true);

    const v = screenModelInput([{ label: "incoming", fields: [subject, snippet] }]);
    expect(v.admitted).toBe(false);
    expect(v.reason).toBe("vocabulary");
    expect(v.category).toBe("otp");
  });

  it("admits an ordinary message — the control without which every case above passes for a door that refuses everything", () => {
    const v = screenModelInput([
      { label: "incoming", fields: [ORDINARY.subject, ORDINARY.snippet, ORDINARY.from] },
      { label: "kb", fields: ["Refund policy", "We refund within 30 days of delivery."] },
      { label: "thread", fields: ["Sounds good, see you then.", "sam@example.test"] },
    ]);
    expect(v).toEqual({ admitted: true, reason: null, category: null, where: null });
  });
});

describe("the field order is load-bearing, not a style", () => {
  /**
   * The screen's cue-to-code window is 40 characters. A `From:` set BETWEEN the subject and the
   * snippet pushes the two halves out of each other's window, and the join answers safe — so the
   * sinks put prose halves next to each other and the address last.
   */
  const from = "no-reply@notifications.vendor.example";

  it("catches the split when the prose halves are adjacent", () => {
    const v = screenModelInput([{ label: "incoming", fields: [SPLIT.subject, SPLIT.snippet, from] }]);
    expect(v.admitted).toBe(false);
  });

  it("misses it when an address is wedged between them — why the order is what it is", () => {
    const v = screenModelInput([{ label: "incoming", fields: [SPLIT.subject, from, SPLIT.snippet] }]);
    expect(v.admitted, "the detector's proximity limit, named rather than hidden").toBe(true);
  });
});

describe("the unit is the document, not the whole payload", () => {
  it("does not refuse a code in one document and a credential word in an unrelated other", () => {
    const v = screenModelInput([
      { label: "incoming", fields: ["Order shipped", "Your parcel 481920 is on its way."] },
      { label: "kb", fields: ["Passphrase policy", "Everyone picks their own; we never store one."] },
    ]);
    expect(v.admitted, "joining two documents would refuse ordinary mail").toBe(true);
  });

  it("refuses when one document carries both halves, and names WHICH", () => {
    const v = screenModelInput([
      { label: "incoming", fields: [ORDINARY.subject, ORDINARY.snippet] },
      { label: "kb", fields: [SPLIT.subject, SPLIT.snippet] },
    ]);
    expect(v.admitted).toBe(false);
    expect(v.where).toBe("kb");
  });

  it("skips empty and absent fields without taking them for a document", () => {
    expect(screenModelInput([{ label: "incoming", fields: [null, undefined, ""] }]).admitted).toBe(true);
  });
});

describe("the reason class is a sentence a person can read", () => {
  it("has one plain sentence per class, and none of them is jargon or a field name", () => {
    const classes = ["vocabulary", "credential_shape", "auth_url_token"] as const;
    expect(Object.keys(MODEL_SINK_REFUSAL_SENTENCE).sort()).toEqual([...classes].sort());
    for (const c of classes) {
      const s = MODEL_SINK_REFUSAL_SENTENCE[c];
      expect(s.length).toBeGreaterThan(20);
      expect(s, "a class name in the sentence is the class leaking, not an explanation").not.toContain("_");
      expect(s.startsWith("this message"), s).toBe(true);
    }
  });

  it("every refusal names a class the sentence map answers", () => {
    for (const fields of [
      [SPLIT.subject, SPLIT.snippet],
      ["Your verification", "code is ready, tap the button below to continue."],
      ["Finish signing in", "https://accounts.example.test/auth/verify?token=Hh3kQ2mZ8vA1pR7xTt0wLcNbYe4Uf6Sj"],
    ]) {
      const v = screenModelInput([{ label: "incoming", fields }]);
      expect(v.admitted, fields[0]).toBe(false);
      expect(MODEL_SINK_REFUSAL_SENTENCE[v.reason!], fields[0]).toBeTruthy();
    }
  });
});
