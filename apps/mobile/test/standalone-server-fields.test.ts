/**
 * THE SERVER FIELDS, AT THE FIELD AND AT THE PRESS — the port rule on both legs, and the outgoing
 * server's refusal at Connect worded about the outgoing server.
 *
 * Measured on a 0.25.1 phone: typing 465 behind the prefilled 587 made `587465`, the form left as
 * connected, and the first send failed with nothing left to change. `Number()` admitted it (and
 * `70000`, `1e3`, and `""` as 0), so the rule is digits and a range, asked before anything dials.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { DECKS } from "../src/copy";
import { openStandaloneMailbox, submissionRefused } from "../src/engine/standalone-door";
import { refuse } from "../src/refusal";
import {
  EMPTY_STANDALONE,
  portFieldSaid,
  portIsDialable,
  portRefusal,
  refusalField,
  withAddress,
  type StandaloneFields,
} from "../src/ui/standalone-form";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = readFileSync(join(APP, "app/standalone.tsx"), "utf8");

describe("a port a socket can be opened on", () => {
  it("admits the whole numbers 1..65535, and the ordinary four", () => {
    for (const p of ["1", "25", "143", "465", "587", "993", "65535", " 587 "]) {
      expect(portIsDialable(p), p).toBe(true);
    }
  });

  it("refuses what Number() let through — the measured 587465 and 70000 among them", () => {
    for (const p of ["587465", "70000", "65536", "0", "", "  ", "1e3", "58.7", "-1", "0x1d1", "abc", "5 87"]) {
      expect(portIsDialable(p), JSON.stringify(p)).toBe(false);
    }
  });
});

const form = (over: Partial<StandaloneFields>): StandaloneFields => ({
  ...withAddress(EMPTY_STANDALONE, personalAt("fixture.lena", "gmx.net")), password: "standalone-password", ...over,
});

describe("the rule the press asks, before anything dials", () => {
  it("names the IMAP port, then the SMTP port", () => {
    expect(portRefusal(form({ imapPort: "70000" }))?.say).toBe("standaloneNoPort");
    expect(portRefusal(form({ smtpPort: "587465" }))?.say).toBe("standaloneNoSmtpPort");
    expect(portRefusal(form({ smtpPort: "" }))?.say, "a named outgoing server needs a port").toBe("standaloneNoSmtpPort");
  });

  it("does not judge the port of an outgoing server nobody named", () => {
    expect(portRefusal(form({ smtpHost: "", smtpPort: "587465" }))).toBeNull();
  });

  it("admits the prefilled form", () => {
    expect(portRefusal(form({}))).toBeNull();
  });

  it("the door refuses at the field and the engine is never started", async () => {
    let started = 0;
    const deps = {
      startEngine: (async () => { started += 1; throw new Error("not reached"); }) as never,
      platform: async () => { started += 1; return { kind: "ready" as const, exec: {}, keks: {} }; },
      machineName: () => "ohmail on a phone",
      installId: async () => "ports-case",
    };
    const smtp = await openStandaloneMailbox(form({ smtpPort: "587465" }), deps);
    expect(smtp.ok ? null : smtp.reason.say).toBe("standaloneNoSmtpPort");
    const imap = await openStandaloneMailbox(form({ imapPort: "70000" }), deps);
    expect(imap.ok ? null : imap.reason.say).toBe("standaloneNoPort");
    expect(started, "nothing was opened or dialled for either").toBe(0);
    // POSITIVE CONTROL: the ordinary form does reach the engine.
    await openStandaloneMailbox(form({}), deps);
    expect(started).toBeGreaterThan(0);
  });
});

describe("the field wears the sentence that is about it", () => {
  it("each server refusal names its own field; the password's names none", () => {
    expect(refusalField(refuse("standaloneNoHost"))).toBe("imapHost");
    expect(refusalField(refuse("standaloneNoPort"))).toBe("imapPort");
    expect(refusalField(refuse("standaloneNoSmtpPort"))).toBe("smtpPort");
    expect(refusalField(refuse("standaloneSmtpSignInRefused"))).toBe("smtpHost");
    expect(refusalField(refuse("standaloneSmtpNoEncryption"))).toBe("smtpHost");
    expect(refusalField(refuse("standaloneSmtpUnreachable"))).toBe("smtpHost");
    expect(refusalField(refuse("standaloneSignInRefused"))).toBeNull();
    expect(refusalField(refuse("standaloneNoEncryption"))).toBeNull();
  });

  it("a port field says so while it is typed, and is silent while empty or right", () => {
    expect(portFieldSaid("587465", "smtp")?.say).toBe("standaloneNoSmtpPort");
    expect(portFieldSaid("", "smtp")).toBeNull();
    expect(portFieldSaid("465", "smtp")).toBeNull();
  });

  it("both sentences name their field, in both languages", () => {
    for (const deck of Object.values(DECKS)) {
      expect(deck.standaloneNoPort).toContain("IMAP");
      expect(deck.standaloneNoSmtpPort).toContain("SMTP");
      expect(deck.standaloneNoSmtpPort).toContain("65535");
    }
  });

  it("the form selects a prefilled port on focus, so typing replaces it", () => {
    const selecting = ROUTE.match(/selectTextOnFocus: true/g) ?? [];
    expect(selecting.length, "both port fields").toBe(2);
    expect(ROUTE).toContain('{...wears("imapPort")}');
    expect(ROUTE).toContain('{...wears("smtpPort")}');
  });
});

describe("the outgoing server's refusal is worded about the outgoing server", () => {
  const pressWith = (thrown: unknown) => openStandaloneMailbox(form({}), {
    startEngine: (async () => { throw thrown; }) as never,
    platform: async () => ({ kind: "ready" as const, exec: {}, keks: {} }),
    machineName: () => "ohmail on a phone",
    installId: async () => "smtp-words-case",
  });
  const refusedBy = (why: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`the outgoing server refused this launch (${why})`), { submissionRefused: why, ...extra });

  it("each of the three answers has its own sentence, on the outgoing server's field", async () => {
    for (const [why, key] of [
      ["auth", "standaloneSmtpSignInRefused"],
      ["tls", "standaloneSmtpNoEncryption"],
      ["unreachable", "standaloneSmtpUnreachable"],
    ] as const) {
      const out = await pressWith(refusedBy(why));
      expect(out.ok ? null : out.reason.say, why).toBe(key);
      expect(out.ok ? null : refusalField(out.reason)).toBe("smtpHost");
    }
  });

  it("outranks the incoming flags, and is read through a wrapping cause", async () => {
    const both = await pressWith(refusedBy("auth", { authenticationFailed: true }));
    expect(both.ok ? null : both.reason.say).toBe("standaloneSmtpSignInRefused");
    expect(submissionRefused(new Error("wrapped", { cause: refusedBy("tls") }))).toBe("tls");
    // POSITIVE CONTROL: the incoming refusal is still the incoming sentence.
    const imap = await pressWith(Object.assign(new Error("no"), { authenticationFailed: true }));
    expect(imap.ok ? null : imap.reason.say).toBe("standaloneSignInRefused");
  });
});
