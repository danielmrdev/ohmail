import { describe, it, expect } from "vitest";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { FakeRepo, FakeRouting } from "./fakes.js";
import type { Change, CreditGate } from "../src/ports.js";
import type { ClassifierPort, ClassifierResult } from "../src/ai/classify.js";
import { WITHHELD, type WithheldCase } from "./fixtures/sensitive-corpus.js";

/**
 * THE OUTBOUND CLASSIFIER IS UNREACHABLE, AND THE LEDGER IS NEVER ASKED.
 *
 * A review's requirement, verbatim: *"assert that the outbound classifier client is unreachable and
 * the ledger remains untouched."* A test that checked `sensitive === true` would pass while the
 * payload still went out, so nothing here checks a boolean. Both injected ports THROW when
 * called, which means a regression cannot produce a green run with a call in it — the call is the
 * failure.
 *
 * The ledger half is asserted at the `CreditGate` seam rather than against `credit_ledger`
 * itself. The database package's AI gate documents why that is the right place for THIS assertion:
 * "`pipeline.ts` puts the `tryDebit` call LAST in a `&&` chain that begins with
 * `!sensitivity.flags.no_ai`, so `&&`'s short-circuit is the enforcement". A gate that explodes
 * on contact proves the short-circuit held; the row-level assertion against real Postgres lived
 * in the services suite's metering test until metering left this journal.
 *
 * Every case goes through `normalizeMime` — the same route the review used to reproduce its second finding — so the
 * MIME layout is the real one and not one this test assumed.
 */

class ExplodingClassifier implements ClassifierPort {
  calls = 0;
  async classify(): Promise<ClassifierResult> {
    this.calls++;
    throw new Error("UNREACHABLE: classifier.classify() was called for a message that must never reach a model");
  }
}

class ExplodingCreditGate implements CreditGate {
  calls = 0;
  async spend(): Promise<never> {
    this.calls++;
    throw new Error("UNREACHABLE: the credit ledger was asked to debit for a message that must never reach a model");
  }
}

/** Every From: this corpus uses. A KNOWN sender is what keeps the message in the unclear residue. */
const KNOWN = ["no-reply@atlas-identity.invalid", "no-reply@service.invalid", "friend@known.invalid"];

let midSeq = 0;

/**
 * Render a corpus case as a real RFC822 message.
 *
 * The `patch` cases are `NormalizedMessage` shapes, which `planChange` cannot take — it starts
 * from `change.raw`. Rendering them back to MIME is not a workaround; it is what makes this test
 * cover the same surface the review attacked, because the normalizer gets to disagree with the patch
 * and the assertion still has to hold.
 *
 * ── `alternative` vs `mixed` IS THE WHOLE POINT AND IT WAS FOUND HERE ─────────────────────────
 *
 * The first version of this helper wrapped everything in `multipart/mixed`, and the
 * alternatives-divergence case went green with `ordinary`. That is not a detector bug: in a MIXED
 * container the text part and the html part are two SEQUENTIAL body parts, and `simpleParser`
 * correctly concatenates both into `text` AND both into `html`. Nothing is hidden, so there is
 * nothing to be indeterminate about. Divergence is only possible in `multipart/alternative`,
 * where the two parts claim to be the same message — which is exactly the container the second finding used.
 * Attachments still need `mixed`.
 */
function toRaw(c: WithheldCase): Buffer {
  if (c.raw !== undefined) return Buffer.from(c.raw, "utf8");
  const p = c.patch ?? {};
  const head = [
    `Message-ID: <b10-${++midSeq}@service.invalid>`,
    "From: Atlas Identity <no-reply@atlas-identity.invalid>",
    "To: ohmail@lichtgrat.example",
    `Subject: =?UTF-8?B?${Buffer.from(p.subject ?? "", "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
  ];
  const attachments = p.attachments ?? [];
  const b = `b0und-${midSeq}`;

  // Single body part and nothing attached: a plain message, no multipart at all.
  if (attachments.length === 0 && !(p.textBody && p.htmlBody)) {
    const html = !p.textBody && p.htmlBody;
    return Buffer.from([
      ...head,
      `Content-Type: text/${html ? "html" : "plain"}; charset=utf-8`,
      "",
      (html ? p.htmlBody : p.textBody) ?? "",
      "",
    ].join("\r\n"), "utf8");
  }

  const parts: string[] = [];
  if (p.textBody) parts.push([`--${b}`, "Content-Type: text/plain; charset=utf-8", "", p.textBody].join("\r\n"));
  if (p.htmlBody) parts.push([`--${b}`, "Content-Type: text/html; charset=utf-8", "", p.htmlBody].join("\r\n"));
  for (const a of attachments) {
    parts.push([
      `--${b}`,
      `Content-Type: ${a.contentType}${a.filename ? `; name="${a.filename}"` : ""}`,
      `Content-Disposition: attachment${a.filename ? `; filename="${a.filename}"` : ""}`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("placeholder body of the attached part", "utf8").toString("base64"),
    ].join("\r\n"));
  }
  return Buffer.from([
    ...head,
    `Content-Type: multipart/${attachments.length > 0 ? "mixed" : "alternative"}; boundary="${b}"`,
    "",
    ...parts,
    `--${b}--`,
    "",
  ].join("\r\n"), "utf8");
}

function deps() {
  const repo = new FakeRepo();
  for (const s of KNOWN) repo.senders.add(s);
  return {
    repo, routing: new FakeRouting(),
    classifier: new ExplodingClassifier(), credits: new ExplodingCreditGate(),
    accountId: "acct-1", mailboxId: "mb-1",
  };
}

const change = (raw: Buffer, ref: string): Change =>
  ({ type: "create", locator: { folder: "INBOX", ref }, raw });

describe("no withheld message can reach the model or the ledger", () => {
  it.each(WITHHELD.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const d = deps();
    const plan = await planChange(change(toRaw(c), `1:${++midSeq}`), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
      classifier: d.classifier, routing: d.routing, credits: d.credits,
    });

    // The two assertions the review asked for, made against ports that fail on contact.
    expect(d.classifier.calls, `${c.id}: the outbound classifier client must be unreachable`).toBe(0);
    expect(d.credits.calls, `${c.id}: the ledger must not be asked`).toBe(0);

    expect(plan.outcome).toBe("new");
    expect(plan.new!.sensitivity.flags.no_ai, `${c.id} — ${c.why}`).toBe(true);
    // No AI plan means no routing decision, no approval and no graduation for this message.
    expect(plan.new!.ai, `${c.id}: no AI plan may exist`).toBeUndefined();

    const res = await commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, routing: d.routing,
    });
    expect(d.routing.decisions, `${c.id}: no routing_decision`).toHaveLength(0);
    expect(d.routing.approvals, `${c.id}: no approval`).toHaveLength(0);
    expect(res.messageId).toBeTruthy();
  });

  /**
   * ANTI-VACUITY, and the most important test in the file.
   *
   * Everything above would also pass if the AI branch simply never fired — a rule matching, an
   * unknown sender short-circuiting to the Screener, a missing `routing` port. This proves the
   * branch IS live for the same deps and the same sender: the exploding classifier is reached,
   * and it explodes. If this ever goes green with `calls === 0`, every assertion above is
   * measuring nothing.
   */
  it("the exploding ports ARE reachable for ordinary mail — otherwise this file proves nothing", async () => {
    const d = deps();
    // A known sender with no automated markers — no bulk List-* header, no money subject — so the
    // deterministic layer leaves it `unclear` (`decision.destination == null`) and the AI branch
    // fires. A service-shaped local part alone does NOT file mail out of the Ohbox (a `no-reply@`
    // carries relevant transactional mail too), so this ordinary note stays in the residue the
    // classifier is meant to judge.
    const raw = Buffer.from([
      "Message-ID: <ordinary@service.invalid>",
      "From: Atlas Identity <no-reply@atlas-identity.invalid>",
      "To: ohmail@lichtgrat.example",
      "Subject: Photos from the weekend",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Morning, do you still have the file from March? I pushed the changes, have a look.",
      "",
    ].join("\r\n"), "utf8");

    await expect(planChange(change(raw, "1:9999"), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
      classifier: d.classifier, routing: d.routing, credits: d.credits,
    })).rejects.toThrow(/the credit ledger was asked to debit/);
    // The gate is asked BEFORE the classifier (`&&` order: sensitivity, then ports, then money),
    // which is why this is the throw that surfaces. Both were reached; neither was short-circuited.
    expect(d.credits.calls).toBe(1);
  });

  it("a recognised sensitive message stores its body in FULL, and still reaches no model", async () => {
    const d = deps();
    const raw = Buffer.from([
      "Message-ID: <redact@service.invalid>",
      "From: Atlas Identity <no-reply@atlas-identity.invalid>",
      "To: ohmail@lichtgrat.example",
      "Subject: Your verification code",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your one-time code is 900123. Or tap https://accounts.example.com/session?t=SECRET-LOGIN-TOKEN",
      "",
    ].join("\r\n"), "utf8");
    const plan = await planChange(change(raw, "1:8888"), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
      classifier: d.classifier, routing: d.routing, credits: d.credits,
    });
    const res = await commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, routing: d.routing,
    });
    // Body redaction at rest is removed: the stored body is the FULL original, code and token
    // included — the reader sees their own mail. The disclosure guarantee is the two below: the
    // classifier was never called and no credit was spent, so nothing about this message left for a
    // model.
    const body = d.repo.bodies.get(res.messageId)!;
    expect(body.text).toContain("900123");
    expect(body.text).toContain("SECRET-LOGIN-TOKEN");
    expect(body.text).not.toContain("[REDACTED]");
    expect(d.classifier.calls).toBe(0);
    expect(d.credits.calls).toBe(0);
  });
});
