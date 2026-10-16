import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP, type ImportHold } from "../src/pipeline.js";
import {
  makeProfileDoc, profileGateView, type OrganizerProfilePayload, type ProfileRuleEntry,
} from "../src/adapters/organizer-profile.js";
import { FakeRepo } from "./fakes.js";
import type { Rule } from "../src/rules.js";
import type { Change } from "../src/ports.js";

/**
 * THE ROUTING HALF OF THE ORGANIZER-PROFILE HOLD (TAKEOVER-RESCREEN). The 2026-08-29 drill: a cold
 * store moved all 31 INBOX messages of a travelling document's screened-in senders into the
 * Screener while the import question stood. Measured on 0.25.1 the other way: a blanket hold
 * left every new stranger in the INBOX, and nothing files an adopted row after the answer. So:
 * mail the document ADMITS keeps its folder, `'external'`; a sender it does not know or denies is
 * screened now, `'us'`; `unreadable` adopts everything; a `rule` verdict and an auth-FAIL
 * demotion are never subordinated; absent means closed.
 */

function eml(opts: { from?: string; headers?: string[] } = {}): Buffer {
  const { from = "stranger@nowhere.example", headers = [] } = opts;
  return Buffer.from([
    `Message-ID: <${from}-${Math.random().toString(36).slice(2)}@nowhere.example>`,
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    "Date: Mon, 10 Aug 2026 09:00:00 GMT",
    "Subject: Hello",
    ...headers,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Just saying hi.",
  ].join("\r\n"));
}

function create(raw: Buffer, folder = "INBOX"): Change {
  return { type: "create", locator: { folder, ref: "1:10" }, raw };
}

const STRANGER = "stranger@nowhere.example";

/** A travelling document's payload, empty but for what a case names. */
function payload(p: Partial<OrganizerProfilePayload>): OrganizerProfilePayload {
  return {
    screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null, ...p,
  };
}

/** The hold as the organizer builds it: the document's gate view, through Import's own converter. */
function documentHold(p: Partial<OrganizerProfilePayload>): ImportHold {
  const doc = makeProfileDoc(payload(p), {
    updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "0.25.1" },
  });
  return { kind: "document", ...profileGateView(doc) };
}

const docRule = (match: string, destination: string, kind = "sender"): ProfileRuleEntry => ({
  kind, match, destination, priority: 0, enabled: true, provenance: "promoted",
});

/** A hold under which every case below that is not about the document itself adopts. */
const ADMITTING = documentHold({ screener: [{ address: STRANGER }] });

function rule(p: Pick<Rule, "id" | "match" | "destination" | "effect">): Rule {
  return {
    kind: "sender", priority: 10, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, ...p,
  };
}

async function planFor(change: Change, opts: {
  importHold?: ImportHold; rules?: Rule[]; trustedAuthservIds?: ReadonlySet<string>;
} = {}) {
  const repo = new FakeRepo();
  if (opts.rules) repo.rules = opts.rules;
  return planChange(change, {
    repo, accountId: "acct-1", mailboxId: "mb-1",
    ...(opts.importHold !== undefined ? { importHold: opts.importHold } : {}),
    ...(opts.trustedAuthservIds ? { trustedAuthservIds: opts.trustedAuthservIds } : {}),
  });
}

describe("the import-decision hold", () => {
  it("HOLD ABSENT: a stranger is held at the gate — every existing caller is this branch", async () => {
    const plan = await planFor(create(eml()));
    expect(plan.new?.desired).toBe("ohmail/Screener");
    expect(plan.new?.passive).toBeUndefined();
  });

  it("(a) THE DOCUMENT NAMES SOMEBODY ELSE: a stranger to both is screened now, attributed to us", async () => {
    // Measured on 0.25.1: under the blanket hold this letter stayed in the INBOX, and no pass files an
    // adopted row after the answer. Import would leave this sender at the gate, so the hold does.
    const plan = await planFor(create(eml()), {
      importHold: documentHold({ screener: [{ address: "friend@elsewhere.example" }] }),
    });
    expect(plan.new?.desired).toBe("ohmail/Screener");
    expect(plan.new?.passive).toBeUndefined();
  });

  it("(b) THE DOCUMENT NAMES THE SENDER: the arrival folder, passive — the takeover does not empty the inbox", async () => {
    // No date term: the window is bounded by the user's answer, not by a clock.
    const plan = await planFor(create(eml()), { importHold: documentHold({ screener: [{ address: STRANGER }] }) });
    expect(plan.new?.desired).toBe("INBOX");
    expect(plan.new?.passive).toBe(true);
  });

  it("(c) A DOCUMENT RULE DENIES THE SENDER: the gate, now — Import would file them out, Not now would hold them", async () => {
    const plan = await planFor(create(eml()), {
      importHold: documentHold({ rules: [docRule(STRANGER, "ohmail/Screened")] }),
    });
    expect(plan.new?.desired).toBe("ohmail/Screener");
    expect(plan.new?.passive).toBeUndefined();
  });

  it("(e) THE PREVIOUS ORGANIZER'S SCREEN-OUT STAYS: mail the document's own rule files where it sits is kept", async () => {
    // At takeover the backlog in `ohmail/Screened` is the previous organizer's screen-outs; the gate
    // verdict would move each one back to the Screener. The document files it where it is, so the
    // hold keeps it, as for an admitted sender. The same sender's INBOX arrival is (c): the gate.
    const hold = documentHold({ rules: [docRule(STRANGER, "ohmail/Screened")] });
    const plan = await planFor(create(eml(), "ohmail/Screened"), { importHold: hold });
    expect(plan.new?.desired, "a screen-out the document states was moved back to the gate").toBe("ohmail/Screened");
    expect(plan.new?.passive).toBe(true);
  });

  it("(d) AN UNREADABLE DOCUMENT keeps the blanket hold: the arrival folder, passive", async () => {
    const plan = await planFor(create(eml()), { importHold: { kind: "unreadable" } });
    expect(plan.new?.desired).toBe("INBOX");
    expect(plan.new?.passive).toBe(true);
  });

  it("the document is read by the ROUTER, not a second matcher: a domain rule admits, a rule Import skips does not", async () => {
    const byDomain = await planFor(create(eml()), {
      importHold: documentHold({ rules: [docRule("nowhere.example", "INBOX", "domain")] }),
    });
    expect(byDomain.new?.desired, "a document domain rule admits through evaluateRules").toBe("INBOX");
    expect(byDomain.new?.passive).toBe(true);

    // A destination outside the six is skipped by Import's converter, so it admits nobody here.
    const skipped = await planFor(create(eml()), {
      importHold: documentHold({ rules: [docRule(STRANGER, "Archive")] }),
    });
    expect(skipped.new?.desired, "a rule Import would skip held mail").toBe("ohmail/Screener");
    expect(skipped.new?.passive).toBeUndefined();

    // A screener entry is read as Import writes it into `contacts`: trimmed and lowercased.
    const cased = await planFor(create(eml()), { importHold: documentHold({ screener: [{ address: " Stranger@Nowhere.Example " }] }) });
    expect(cased.new?.desired, "a screened-in sender spelled in capitals was not recognised").toBe("INBOX");
  });

  it("HOLD OPEN: mail the previous organizer HELD in the Screener stays held — adoption is not admission", async () => {
    // The outgoing organizer's consent bag travels physically in `ohmail/Screener`: adopting its
    // placement keeps it there, and a stranger the document does not name is screened in place.
    for (const importHold of [ADMITTING, documentHold({}), { kind: "unreadable" } as const]) {
      const plan = await planFor(create(eml(), "ohmail/Screener"), { importHold });
      expect(plan.new?.desired).toBe("ohmail/Screener");
    }
    // A stranger to the document at the gate is this organizer's gate verdict, not an adoption.
    const unknown = await planFor(create(eml(), "ohmail/Screener"), { importHold: documentHold({}) });
    expect(unknown.new?.passive, "a stranger at the gate was adopted as a hand placement").toBeUndefined();
  });

  it("A RULE IS NEVER SUBORDINATED — the user's own decisions outrank the hold, both directions", async () => {
    const deny = rule({ id: "r-deny", match: "spammer@nowhere.example", destination: "ohmail/Screened", effect: "deny" });
    const allow = rule({ id: "r-allow", match: "known@nowhere.example", destination: "ohmail/News", effect: "allow" });
    for (const importHold of [
      documentHold({ screener: [{ address: "spammer@nowhere.example" }, { address: "known@nowhere.example" }] }),
      { kind: "unreadable" } as const,
    ]) {
      expect((await planFor(create(eml({ from: "spammer@nowhere.example" })), {
        importHold, rules: [deny],
      })).new?.desired).toBe("ohmail/Screened");
      expect((await planFor(create(eml({ from: "known@nowhere.example" })), {
        importHold, rules: [allow],
      })).new?.desired).toBe("ohmail/News");
    }
  });

  it("AN AUTH-FAIL DEMOTION IS NEVER SUBORDINATED — an open import question does not excuse a failed DMARC", async () => {
    const trusted = new Set(["mx.test"]);
    const allow = rule({ id: "r-allow", match: "known@nowhere.example", destination: "INBOX", effect: "allow" });
    const failing = create(eml({
      from: "known@nowhere.example",
      headers: ["Authentication-Results: mx.test; dmarc=fail header.from=nowhere.example"],
    }));
    for (const importHold of [documentHold({ screener: [{ address: "known@nowhere.example" }] }), { kind: "unreadable" } as const]) {
      expect((await planFor(failing, {
        importHold, rules: [allow], trustedAuthservIds: trusted,
      })).new?.desired).toBe("ohmail/Screener");
    }
  });

  it("A LIFT THAT MOVES MAIL UNDER THE HOLD IS NEVER PASSIVE — the reconciler must still execute it", async () => {
    // Review round 3: the corroborated-bounce arm outranks the hold and picks INBOX — a REAL
    // move when the report was observed in the Screener — and `reconcileFolders` skips
    // `external` rows. A passive stamp there would leave the master in the Screener while the
    // database and every client claim INBOX: a divergence between the mailbox and its mirror.
    // The one corroboration a report can carry: it quotes the account's own Sent copy.
    const seedOwnSent = async (into: FakeRepo): Promise<void> => {
      const raw = Buffer.from([
        "Message-ID: <sent-hold-1@lichtgrat.example>", "From: mila@lichtgrat.example", "To: recipient@elsewhere.example",
        "Subject: the original", "Content-Type: text/plain; charset=utf-8", "", "hi",
      ].join("\r\n"));
      const sent = await planChange({
        type: "create", locator: { folder: "Sent", ref: "2:1" }, raw, ownAuthored: true,
        internalDate: new Date("2026-09-22T15:12:00.000Z"),
      }, { repo: into, accountId: "acct-1", mailboxId: "mb-1", readerMode: false });
      await commitChange(sent, { repo: into, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP });
    };
    const repo = new FakeRepo();
    await seedOwnSent(repo);
    const dsn = Buffer.from([
      "Message-ID: <dsn-hold-1@their-host.example>",
      "From: MAILER-DAEMON@their-host.example",
      "To: mila@lichtgrat.example",
      "Subject: Undelivered Mail Returned to Sender",
      "In-Reply-To: <sent-hold-1@lichtgrat.example>",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your message could not be delivered.",
      "",
      "--b1--",
    ].join("\r\n"));
    const plan = await planChange(
      { type: "create", locator: { folder: "ohmail/Screener", ref: "1:10" }, raw: dsn },
      { repo, accountId: "acct-1", mailboxId: "mb-1", importHold: { kind: "unreadable" } },
    );
    expect(plan.new?.desired).toBe("INBOX");
    expect(plan.new?.passive, "a decided MOVE must stay 'us' or it is never executed").toBeUndefined();
    const out = await commitChange(plan, {
      repo, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP,
    });
    // The bounce arm's admission is decided for this letter: no rule about its sender moves it.
    expect(repo.folder.get(out.messageId)).toEqual({
      desiredFolder: "INBOX", observedFolder: "ohmail/Screener", lastSetBy: "us", decidedAt: expect.any(Date),
    });

    // …and IN PLACE too (rounds 9 and 13): a corroborated DSN that already arrived in the INBOX
    // needs no move, but its placement was still THIS organizer's decision — an `external` stamp
    // would hide it from the retro passes entitled to revisit decisions we made.
    const repo2 = new FakeRepo();
    await seedOwnSent(repo2);
    const dsnInbox = Buffer.from(dsn.toString().replace("dsn-hold-1", "dsn-hold-2"));
    const plan2 = await planChange(
      { type: "create", locator: { folder: "INBOX", ref: "1:11" }, raw: dsnInbox },
      { repo: repo2, accountId: "acct-1", mailboxId: "mb-1", importHold: { kind: "unreadable" } },
    );
    expect(plan2.new?.desired).toBe("INBOX");
    expect(plan2.new?.passive, "an in-place lift is still OUR decision").toBeUndefined();
    const out2 = await commitChange(plan2, {
      repo: repo2, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP,
    });
    expect(repo2.folder.get(out2.messageId)?.lastSetBy).toBe("us");
  });

  it("AN ADOPTED PLACEMENT COMMITS `last_set_by: 'external'` — out of every retro pass's reach", async () => {
    // Without this the hold only postpones the re-screen: the imported rules' retro passes all
    // key on `last_set_by = 'us'`, so an adopted row committed as 'us' would be re-decided the
    // moment the import lands — INBOX byte-identical after apply is the acceptance, and this is
    // the word that carries it.
    const repo = new FakeRepo();
    const plan = await planChange(create(eml()), {
      repo, accountId: "acct-1", mailboxId: "mb-1", importHold: ADMITTING,
    });
    expect(plan.new?.passive).toBe(true);
    const out = await commitChange(plan, {
      repo, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP,
    });
    expect(repo.folder.get(out.messageId)).toEqual({
      desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external",
    });

    // The control: the same message with the hold ABSENT screens, attributed to us.
    const repo2 = new FakeRepo();
    const plan2 = await planChange(create(eml()), { repo: repo2, accountId: "acct-1", mailboxId: "mb-1" });
    const out2 = await commitChange(plan2, {
      repo: repo2, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP,
    });
    expect(repo2.folder.get(out2.messageId)?.lastSetBy).toBe("us");
    expect(repo2.folder.get(out2.messageId)?.desiredFolder).toBe("ohmail/Screener");
  });
});
