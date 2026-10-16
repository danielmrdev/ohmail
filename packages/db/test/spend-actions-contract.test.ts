import { describe, it, expect } from "vitest";
import { IDEMPOTENCY_TTL_MS } from "../src/idempotency.js";
import { AI_CLAIM_TTL_MS } from "../src/ledger-source.js";
import {
  ATTEMPT_KEY_MAX, DRAFT_RETRY_WINDOW_MS, SPEND_ACTIONS, assertAttemptKey,
  classifyAttemptKey, classifyLedgerSource, draftAttemptKey, isSpendAction, ledgerSources,
  screenerAttemptKey, screenerLedgerSource, sourceFor, workflowAttemptKey,
  clientIdempotencyKey,
} from "../src/ledger-source.js";

/**
 * THE SPEND TERMS, PINNED AGAINST THE PROGRAM THAT ANSWERS THEM.
 *
 * Two programs price the same five call sites and neither may import the other. So the table is
 * duplicated by decision, and this file is the other half of that decision: every figure below is
 * transcribed from the entitlements program's wire contract (`docs/PORT-CONTRACT.md`) and its
 * `src/port.ts`, by hand, as a literal. A pin that computed the expectation from `SPEND_ACTIONS`
 * would agree with any drift the moment it happened.
 *
 * The cutover ceremony diffs the two files. Until then, a difference shows up here.
 */

/** The contract's own table: action → reason, namespace, exclusive claim, setup pool, price. */
const CONTRACT_TERMS = {
  classify_ingest: { reason: "debit_classify", namespace: "classify", exclusive: false, setupPool: false },
  screener: { reason: "debit_classify", namespace: "classify", exclusive: true, setupPool: true },
  draft: { reason: "debit_draft", namespace: "draft", exclusive: false, setupPool: false },
  propose: { reason: "debit_propose", namespace: "propose", exclusive: true, setupPool: false },
  workflow: { reason: "debit_workflow", namespace: "workflow_run", exclusive: false, setupPool: false },
} as const;

describe("SPEND_ACTIONS is the program's table", () => {
  it("the five actions, and only those five", () => {
    expect(Object.keys(SPEND_ACTIONS).sort()).toEqual(Object.keys(CONTRACT_TERMS).sort());
  });

  for (const [action, terms] of Object.entries(CONTRACT_TERMS)) {
    it(`${action} spends on the contract's terms`, () => {
      const spec = SPEND_ACTIONS[action as keyof typeof SPEND_ACTIONS];
      expect(spec.reason).toBe(terms.reason);
      expect(spec.namespace).toBe(terms.namespace);
      expect(spec.exclusive).toBe(terms.exclusive);
      expect(spec.setupPool).toBe(terms.setupPool);
    });
  }

  /**
   * The one figure this side owns, and the reason it is asserted rather than imported: the leaf
   * is compiled into the desktop engine and `idempotency.ts` is not a leaf, so the window is
   * re-declared. Inside it a repeat of one client key IS a retry and must not be charged twice;
   * outside it the key means nothing to the request path any more.
   */
  it("the draft retry window is the idempotency window, to the millisecond", () => {
    expect(DRAFT_RETRY_WINDOW_MS).toBe(IDEMPOTENCY_TTL_MS);
    expect(SPEND_ACTIONS.draft.retryWindowMs).toBe(IDEMPOTENCY_TTL_MS);
  });

  it("no other action declares a window — an immutable-mail source is the same work for ever", () => {
    for (const [action, spec] of Object.entries(SPEND_ACTIONS)) {
      if (action === "draft") continue;
      expect("retryWindowMs" in spec, action).toBe(false);
    }
  });

  it("the claim TTL the contract advertises is the one this database honours", () => {
    // "Transient, bounded by a 150-second claim TTL" — PORT-CONTRACT.md, `/v1/spend`.
    expect(AI_CLAIM_TTL_MS).toBe(150_000);
  });

  it("two actions claim, and the TTL is sized for the model call of both", () => {
    // Which sites the TTL is load-bearing for, stated rather than discovered: a claim site added
    // without sizing its call against the TTL is the defect `ai-claim-ttl.test.ts` measures — a
    // claim expiring inside its own model call hands paid work to a second caller. The proposer
    // and the classifier are built from ONE client in `apps/worker/src/config.ts`, so the 130 s
    // ceiling that file checks covers both.
    const claiming = Object.entries(SPEND_ACTIONS)
      .filter(([, spec]) => spec.exclusive).map(([action]) => action).sort();
    expect(claiming).toEqual(["propose", "screener"]);
  });

  it("a key is bounded where the contract bounds it", () => {
    expect(ATTEMPT_KEY_MAX).toBe(160);
  });

  it("isSpendAction admits the five and nothing else", () => {
    for (const a of Object.keys(CONTRACT_TERMS)) expect(isSpendAction(a)).toBe(true);
    for (const a of ["debit_classify", "classify", "", "screener_auto", null, 7]) {
      expect(isSpendAction(a)).toBe(false);
    }
  });
});

/**
 * THE COMPOSER CONTROL — one string, two readings, and the money that turns on which one is meant.
 *
 * `classify:screener:<messageId>` is the source the Screener has always written. Read as a full
 * SOURCE it is what the local adapter used to hand its gate; read as a bare KEY it is what the
 * program would compose a source FROM. Those two readings of one string differ by a namespace,
 * and the difference is not cosmetic: a spend under the doubled form writes a row that satisfies
 * `credit_ledger_source_reason_check` (`classify:%`) and takes its own slot in
 * `UNIQUE (account_id, source)`, so the already-paid attempt is invisible to it and the customer
 * is charged a second time for one message.
 *
 * So the rule is one composer, and a key that is already a source is refused rather than composed.
 */
describe("one source string, two readings — and only one of them is a KEY", () => {
  const MESSAGE = "9f1c2d3e-0000-4000-8000-000000000001";

  it("the bare key composes the source the Screener has always written", () => {
    expect(sourceFor("screener", screenerAttemptKey(MESSAGE))).toBe(`classify:screener:${MESSAGE}`);
    // …which is byte-for-byte what the pre-port function produced, so the ledger does not move.
    expect(screenerLedgerSource(MESSAGE)).toBe(`classify:screener:${MESSAGE}`);
  });

  it("the SAME string read as a key is refused, and the refusal says what it would have cost", () => {
    const asSource = `classify:screener:${MESSAGE}`;
    expect(() => sourceFor("screener", asSource)).toThrow(/is a SOURCE where a bare KEY belongs/);
    expect(() => sourceFor("screener", asSource)).toThrow(/charged again/);
  });

  it("every namespace is a refusal, in both spend and release direction", () => {
    for (const spec of Object.values(SPEND_ACTIONS)) {
      expect(() => assertAttemptKey("classify_ingest", `${spec.namespace}:anything`))
        .toThrow(/already begins with the ledger namespace/);
    }
  });

  it("a `screener:` prefix is NOT a namespace, and stays a legal key", () => {
    // The one prefix that looks like a namespace and is not: it is part of the KEY, which is what
    // keeps a pre-suggestion from sharing an ingest classification's source.
    expect(() => assertAttemptKey("screener", `screener:${MESSAGE}`)).not.toThrow();
  });

  it("bounds and charset are refused by name, not silently truncated", () => {
    expect(() => assertAttemptKey("draft", "")).toThrow(/is 0 characters/);
    expect(() => assertAttemptKey("draft", "k".repeat(ATTEMPT_KEY_MAX + 1)))
      .toThrow(new RegExp(`is ${ATTEMPT_KEY_MAX + 1} characters`));
    expect(() => assertAttemptKey("draft", "has space")).toThrow(/outside \[A-Za-z0-9/);
    expect(() => assertAttemptKey("draft", "quote'd")).toThrow(/outside \[A-Za-z0-9/);
  });
});

/**
 * EVERY SPEND SOURCE IN THE PRODUCT COMES THROUGH THE ONE COMPOSER.
 *
 * The four spend namespaces used to be built by hand in five places. These cases pin the bytes of
 * each surviving builder so the delegation cannot change what the ledger holds — the discriminator
 * for "nothing moved behaviourally".
 */
describe("the builders produce the bytes they always produced", () => {
  it("classify — the mailbox and the hashed dedup key", () => {
    const source = classifyLedgerSource("mbx-1", "fp1:abc");
    expect(source.startsWith("classify:mbx-1:")).toBe(true);
    expect(source).toBe(`classify:${classifyAttemptKey("mbx-1", "fp1:abc")}`);
    // 32 hex of sha-256, which is what bounds a remote-controlled key's length.
    expect(source).toMatch(/^classify:mbx-1:[0-9a-f]{32}$/);
  });

  it("draft — the message and the hashed client key", () => {
    const key = clientIdempotencyKey("client-key-1");
    expect(ledgerSources.draft("msg-1", key)).toBe(`draft:${draftAttemptKey("msg-1", key)}`);
    expect(ledgerSources.draft("msg-1", key)).toMatch(/^draft:msg-1:[0-9a-f]{32}$/);
  });

  it("propose — the run id, and the run id alone", () => {
    expect(ledgerSources.propose("acct-1:2026-09-10T14")).toBe("propose:acct-1:2026-09-10T14");
  });

  it("workflow — the run and the step, under the `workflow_run` namespace", () => {
    expect(ledgerSources.workflowStep("run-1", 3)).toBe("workflow_run:run-1:3");
    expect(ledgerSources.workflowStep("run-1", 3)).toBe(`workflow_run:${workflowAttemptKey("run-1", 3)}`);
  });

  it("the NON-spend namespaces are untouched by any of this", () => {
    // They have no action and no terms: nobody buys an invoice grant or a trial bounty.
    expect(ledgerSources.invoiceGrant("in_1")).toBe("invoice:in_1");
    expect(ledgerSources.periodExpiry("in_0")).toBe("expiry:in_0");
    expect(ledgerSources.refund("classify:m1")).toBe("refund:classify:m1");
    expect(ledgerSources.admin("adj-1")).toBe("admin:adj-1");
    expect(ledgerSources.trialGrant("acct-1")).toBe("trial:acct-1");
  });
});
