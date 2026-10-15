import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP, type PlanDeps } from "../src/pipeline.js";
import { evaluateRules, type Rule } from "../src/rules.js";
import { claimedIdentity } from "../src/sender-check.js";
import { normalizeMime } from "../src/mime.js";
import { FakeRepo, FakeRouting } from "./fakes.js";
import type { Change } from "../src/ports.js";
import type { ClassifierPort, ClassifierInput, ClassifierResult } from "../src/ai/classify.js";

/**
 * THE ROUTER NEVER HOLDS THE ACCOUNT'S OWN MAIL AT THE GATE. Mail from one of the account's own
 * mailbox addresses arriving in INBOX stays there: no Screener, no AI question, no routing row.
 * A domain rule still decides; a sender rule naming an own address does not, and a trusted
 * authentication failure still screens (a forged own `From`). A company claim does not hold it
 * either: the fact rides on the row for the reader to say. Every address here is `.invalid`.
 */

const ME = "me@own.invalid";
const ALSO_ME = "second@own-too.invalid";
const STRANGER = "someone@stranger.invalid";
const PROVIDER: ReadonlySet<string> = new Set(["mx.provider.invalid"]);

function eml(o: { from: string; messageId: string; auth?: string; bulk?: boolean; subject?: string }): Buffer {
  return Buffer.from([
    `Message-ID: <${o.messageId}>`,
    ...(o.auth ? [`Authentication-Results: ${o.auth}`] : []),
    `From: ${o.from}`,
    `To: ${ME}`,
    `Subject: ${o.subject ?? "a note to myself"}`,
    ...(o.bulk ? ["List-Unsubscribe: <https://list.invalid/u>"] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Remember the north elevation.",
  ].join("\r\n"));
}

const inbox = (raw: Buffer, ref = "1:20"): Change =>
  ({ type: "create", locator: { folder: "INBOX", ref }, raw, seen: false, internalDate: new Date() });

class CountingClassifier implements ClassifierPort {
  calls = 0;
  async classify(_i: ClassifierInput): Promise<ClassifierResult> {
    this.calls++;
    return { destination: "ohmail/Quarantine", confidence: 0.99, rationale: "x", spam: true };
  }
}

function setup() {
  const repo = new FakeRepo();
  repo.own = new Set([ME, ALSO_ME]);
  return { repo, classifier: new CountingClassifier(), routing: new FakeRouting() };
}

async function ingest(s: ReturnType<typeof setup>, change: Change, extra: Partial<PlanDeps> = {}) {
  const plan = await planChange(change, {
    repo: s.repo, accountId: "acct-1", mailboxId: "mb-1", readerMode: false,
    classifier: s.classifier, routing: s.routing, ...extra,
  });
  await commitChange(plan, {
    repo: s.repo, routing: s.routing, accountId: "acct-1", mailboxId: "mb-1",
    storageCap: UNMETERED_STORAGE_CAP,
  });
  return plan;
}

const rule = (over: Partial<Rule>): Rule => ({
  id: "r1", kind: "sender", match: ME, destination: "ohmail/Screened", effect: "deny",
  priority: 0, provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
  ...over,
});

describe("own mail at ingest", () => {
  it("mail from the mailbox's own address stays in INBOX, asks no AI question, writes no routing row", async () => {
    const s = setup();
    const plan = await ingest(s, inbox(eml({ from: ME, messageId: "self-1@own.invalid" })));
    expect(plan.new!.desired).toBe("INBOX");
    expect(s.classifier.calls).toBe(0);
    expect(s.routing.decisions).toHaveLength(0);
  });

  it("mail from ANOTHER mailbox of the account, in mixed case, stays in INBOX too", async () => {
    const s = setup();
    const plan = await ingest(s, inbox(eml({ from: "Second@Own-Too.invalid", messageId: "self-2@own.invalid" })));
    expect(plan.new!.desired).toBe("INBOX");
  });

  it("list-shaped own mail keeps its INBOX place — the gate skip places nothing", async () => {
    const s = setup();
    const plan = await ingest(s, inbox(eml({ from: ME, messageId: "self-3@own.invalid", bulk: true })));
    expect(plan.new!.desired).toBe("INBOX");
  });

  it("the page's resolved set is used when the cycle passes one, and the repo is not asked", async () => {
    const s = setup();
    s.repo.own = new Set();
    const plan = await ingest(s, inbox(eml({ from: ME, messageId: "self-4@own.invalid" })),
      { ownAddresses: new Set([ME]) });
    expect(plan.new!.desired).toBe("INBOX");
  });

  it("CONTROL: a stranger's mail is still held at the gate", async () => {
    const s = setup();
    const plan = await ingest(s, inbox(eml({ from: STRANGER, messageId: "x-1@stranger.invalid" })));
    expect(plan.new!.desired).toBe("ohmail/Screener");
  });

  it("CONTROL: a trusted authentication failure on an own From still screens", async () => {
    const s = setup();
    const plan = await ingest(s, inbox(eml({
      from: ME, messageId: "forged-1@own.invalid",
      auth: "mx.provider.invalid; dkim=fail header.d=own.invalid; spf=fail",
    })), { trustedAuthservIds: PROVIDER });
    expect(plan.new!.desired).toBe("ohmail/Screener");
  });

  it("a sender rule about the account's own address does not decide its own mail", async () => {
    // HAND BACK 1 HIGH-2: a sender rule naming an own address never decides authenticated own mail.
    const s = setup();
    s.repo.rules = [rule({})];
    const plan = await ingest(s, inbox(eml({ from: ME, messageId: "self-5@own.invalid" })));
    expect(plan.new!.desired).toBe("INBOX");
    expect(s.classifier.calls).toBe(0);
  });

  it("CONTROL: the same rule still decides a forged own From that fails authentication", async () => {
    const s = setup();
    s.repo.rules = [rule({})];
    const plan = await ingest(s, inbox(eml({
      from: ME, messageId: "forged-2@own.invalid",
      auth: "mx.provider.invalid; dkim=fail header.d=own.invalid; spf=fail",
    })), { trustedAuthservIds: PROVIDER });
    expect(plan.new!.desired).toBe("ohmail/Screened");
  });

  it("CONTROL: a domain rule still decides the account's own mail", async () => {
    const s = setup();
    s.repo.rules = [rule({ kind: "domain", match: "own.invalid" })];
    const plan = await ingest(s, inbox(eml({ from: ME, messageId: "self-6@own.invalid" })));
    expect(plan.new!.desired).toBe("ohmail/Screened");
  });

  // REVIEW-02518 HIGH-1: its two probes, a company in the subject's lead-in and in the own name.
  it("own mail claiming a company keeps its INBOX place, asks nothing, and carries the fact", async () => {
    for (const [from, subject, brand, via] of [
      [ME, "Fwd: PostFinance: Kontoauszug September", "PostFinance", "subject_lead"],
      [`Anna Muster Swisscom <${ME}>`, "a note", "Swisscom", "name"],
    ] as const) {
      const s = setup();
      const plan = await ingest(s, inbox(eml({ from, subject, messageId: `claim-${via}@own.invalid` })));
      expect(plan.new!.desired, subject).toBe("INBOX");
      expect(plan.new!.senderCheck, subject).toEqual({ brand, via });
      expect(s.classifier.calls, subject).toBe(0);
      expect(s.routing.decisions, subject).toHaveLength(0);
    }
  });

  it("CONTROL: a forged own From claiming a company that fails DMARC at a trusted id is held", async () => {
    const s = setup();
    const plan = await ingest(s, inbox(eml({
      from: ME, subject: "Fwd: PostFinance: Kontoauszug September", messageId: "forged-claim@own.invalid",
      auth: "mx.provider.invalid; dmarc=fail header.from=own.invalid",
    })), { trustedAuthservIds: PROVIDER });
    expect(plan.new!.desired).toBe("ohmail/Screener");
    expect(plan.new!.senderCheck?.brand).toBe("PostFinance");
  });

  it("CONTROL: a stranger's claim is held where a domain rule admits the same stranger unclaimed", async () => {
    const admit = rule({ id: "d", kind: "domain", match: "stranger.invalid", destination: "INBOX", effect: "allow" });
    const claimed = setup();
    claimed.repo.rules = [admit];
    const held = await ingest(claimed, inbox(eml({ from: `PostFinance <${STRANGER}>`, messageId: "x-2@stranger.invalid" })));
    expect(held.new!.desired).toBe("ohmail/Screener");
    const plain = setup();
    plain.repo.rules = [admit];
    const admitted = await ingest(plain, inbox(eml({ from: `Anna <${STRANGER}>`, messageId: "x-3@stranger.invalid" })));
    expect(admitted.new!.desired).toBe("INBOX");
  });
});

describe("evaluateRules — the gate step for the account's own address", () => {
  const base = { rules: [] as Rule[], knownSenders: { addresses: new Set<string>(), inferred: new Set<string>(), lists: new Map() }, ohboxPolicy: "people_and_replied" as const };

  it("an own author with no rule answers `own`, destination null", async () => {
    const msg = await normalizeMime(eml({ from: ME, messageId: "p-1@own.invalid" }));
    const d = evaluateRules({ ...base, msg, auth: "unavailable", ownAddresses: new Set([ME]), identity: null });
    expect(d).toEqual({ destination: null, matchedRuleId: null, source: "own" });
  });

  it("CONTROL: the same message with no own set is held", async () => {
    const msg = await normalizeMime(eml({ from: ME, messageId: "p-2@own.invalid" }));
    const d = evaluateRules({ ...base, msg, auth: "unavailable", ownAddresses: new Set(), identity: null });
    expect(d.source).toBe("screener");
  });

  it("a sender rule naming an own address, narrowed or not, is read as if it did not exist", async () => {
    const msg = await normalizeMime(eml({ from: ME, messageId: "p-4@own.invalid" }));
    const rules = [
      { id: "r1", kind: "sender", match: " Me@Own.invalid ", destination: "ohmail/Screened", effect: "deny", priority: 9,
        provenance: "manual", enabled: true, subjectContains: null, bodyContains: null },
      { id: "r2", kind: "sender", match: ME, destination: "ohmail/Receipts", effect: "allow", priority: 0,
        provenance: "manual", enabled: true, subjectContains: "note", bodyContains: null },
    ] as Rule[];
    const d = evaluateRules({ ...base, rules, msg, auth: "pass", ownAddresses: new Set([ME]), identity: null });
    expect(d).toEqual({ destination: null, matchedRuleId: null, source: "own" });
  });

  it("an own author claiming a company keeps its place with the fact; `fail` holds it with the fact", async () => {
    const msg = await normalizeMime(eml({ from: `PostFinance <${ME}>`, messageId: "p-5@own.invalid" }));
    const identity = claimedIdentity({ fromName: "PostFinance", fromAddress: ME, subject: msg.subject })!;
    expect(identity.brand).toBe("PostFinance");
    expect(evaluateRules({ ...base, msg, auth: "unavailable", ownAddresses: new Set([ME]), identity }))
      .toEqual({ destination: null, matchedRuleId: null, source: "own", identity });
    expect(evaluateRules({ ...base, msg, auth: "fail", ownAddresses: new Set([ME]), identity }))
      .toEqual({ destination: "ohmail/Screener", matchedRuleId: null, source: "screener", identity });
  });

  it("CONTROL: `fail` still screens an own author", async () => {
    const msg = await normalizeMime(eml({ from: ME, messageId: "p-3@own.invalid" }));
    const d = evaluateRules({ ...base, msg, auth: "fail", ownAddresses: new Set([ME]), identity: null });
    expect(d.source).toBe("screener");
  });
});
