import { describe, it, expect } from "vitest";
import { managedDomain } from "../../../test/support/fixture-credentials.js";
import { makeTestDb } from "../src/testing.js";
import { accounts, outboundSends,} from "@trafficflow/db";
import {
  runAlertPass, webhookAlertSink, writeHeartbeat, newDeliveryStreak, redactEndpoint,
  DEFAULT_SINK_FAILURE_ESCALATION,
  type Alert, type AlertSink,
} from "../src/alerts.js";

/**
 * ── THE PRODUCTION FAILURE THIS FILE ASSERTS AGAINST, MEASURED NOT IMAGINED ──────────────
 *
 * Every `alert_notified` line the worker emitted read `delivered=[] failedSinks=["webhook"]`.
 * `TF_ALERT_WEBHOOK_URL` was set, the pass ran every 60 s, the alert was real — and every
 * delivery failed for as long as the logs went back. Nothing escalated, because the alarm for
 * alert-blindness (`alerts_undeliverable`, the state `alerts.ts` itself calls "the single most
 * dangerous") tested `sinks.length === 0`: it fired when NOTHING WAS CONFIGURED and was silent
 * in the strictly worse case where something was configured and refused everything.
 *
 * Both states have the same consequence — alerts reach nobody — so they get the same ERROR.
 * The difference is that this one needs memory: one refusal is a blip, a streak is a fault.
 *
 * The second half of the file is about the other thing that made this last: a refusal carried
 * no reason. `failedSinks:["webhook"]` is true, useless, and identical for a dead URL, a 429,
 * a DNS failure and a value with quotes baked into it.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const NOW = new Date("2026-07-31T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A world with one real, permanently-firing alert to try to deliver. */
async function seedFiring(db: Db): Promise<void> {
  const [acct] = await db.insert(accounts).values({ name: "SinkFailure" }).returning();
  await writeHeartbeat(db, {
    shardIndex: 0, instanceId: "wkr-test", shards: 1,
    mailboxes: 0, expected: 0, accounts: 1, quarantined: 0, degraded: false,
    lastCycleAt: NOW, startedAt: new Date(NOW.getTime() - HOUR),
  }, NOW);
  // One STUCK SEND, which is what makes an alert fire here now: `sends_stuck` needs a single
  // planted row and no metering, and the subject of this file is the SINK rather than the rule.
  await db.insert(outboundSends).values({
    accountId: acct!.id,
    idempotencyKey: "idem-sink-escalation",
    mintedMessageId: `<sink-escalation@app.${managedDomain()}>`,
    status: "pending",
    createdAt: new Date(NOW.getTime() - HOUR),
  });
}

/** A sink that always refuses and says why — the shape `webhookAlertSink` now produces. */
function refusing(name: string, error: string): AlertSink {
  return { name, notify: () => Promise.resolve({ ok: false, error }) };
}

/** A sink that accepts, and remembers what it was handed. */
function accepting(name: string): AlertSink & { seen: Alert[][] } {
  const seen: Alert[][] = [];
  return { name, seen, async notify(alerts) { seen.push([...alerts]); return true; } };
}

describe("failing-sink escalation — configured and refusing is the same outage as unconfigured", () => {
  it("escalates after N consecutive full-delivery failures, naming the sink and the reason", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const sink = refusing("webhook", "HTTP 429 — rate limited");

    const results = [];
    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION; i++) {
      results.push(await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * MIN), sinks: [sink], deliveryStreak: streak,
      }));
    }

    // Every pass re-claims, because a failed delivery releases its claim — so the streak
    // counts attempts at the worker's 60 s cadence, which is what N is calibrated against.
    for (const r of results) expect(r.delivered).toEqual([]);
    expect(
      results.slice(0, -1).map((r) => r.escalate),
      "fewer than N refusals is a blip, and must not fire the loudest error in the file",
    ).toEqual(new Array(DEFAULT_SINK_FAILURE_ESCALATION - 1).fill(null));

    const last = results.at(-1)!;
    expect(last.escalate, "N consecutive refusals must escalate").not.toBeNull();
    expect(last.escalate!.consecutiveFailures).toBe(DEFAULT_SINK_FAILURE_ESCALATION);
    expect(last.escalate!.sinks).toEqual(["webhook"]);
    expect(last.escalate!.errors, "the escalation must carry WHY, not just that")
      .toEqual(["webhook: HTTP 429 — rate limited"]);
    expect(last.sinkFailureStreak).toBe(DEFAULT_SINK_FAILURE_ESCALATION);
  });

  it("escalates ONCE per streak — a broken sink must not become the line people filter", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const sink = refusing("webhook", "HTTP 404");

    const escalations = [];
    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION + 4; i++) {
      const r = await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * MIN), sinks: [sink], deliveryStreak: streak,
      });
      if (r.escalate) escalations.push(r.escalate);
    }
    expect(escalations, "one ERROR per streak, however long the streak runs").toHaveLength(1);
  });

  it("ANY success resets the streak, and a NEW streak escalates again", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const bad = refusing("webhook", "HTTP 500");
    const good = accepting("webhook");

    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION - 1; i++) {
      await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * MIN), sinks: [bad], deliveryStreak: streak,
      });
    }
    expect(streak.consecutiveFailures).toBe(DEFAULT_SINK_FAILURE_ESCALATION - 1);

    // The question a streak answers is "did an alert reach a human", so a success clears it
    // outright rather than decrementing it.
    const ok = await runAlertPass(db, {
      now: new Date(NOW.getTime() + HOUR), sinks: [good], deliveryStreak: streak,
    });
    expect(ok.delivered, "a delivered alert names the sink that took it").toEqual(["webhook"]);
    expect(ok.failedSinks).toEqual([]);
    expect(ok.sinkErrors).toEqual([]);
    expect(ok.escalate).toBeNull();
    expect(ok.sinkFailureStreak).toBe(0);
    expect(good.seen, "the sink really was handed the firing alert").toHaveLength(1);

    // A fresh fault is a fresh streak and must be allowed to escalate again — otherwise the
    // first outage of a deployment's life would be the only one it ever reported.
    //
    // NOTE THE CLOCK, WHICH THIS TEST GOT WRONG FIRST AND IS WORTH STATING: the success above
    // CONFIRMED the claim, so the alert is not due again for a full `repeatMs`. Passes one,
    // two and three minutes later attempt nothing, and correctly leave the streak alone. A
    // sink that breaks immediately after a success is therefore escalated one repeat interval
    // plus N passes later, not N passes later — inherent to the repeat interval, not a defect
    // in the streak, and the reason the loop below starts an hour on.
    let escalated = false;
    for (let i = 1; i <= DEFAULT_SINK_FAILURE_ESCALATION; i++) {
      const r = await runAlertPass(db, {
        now: new Date(NOW.getTime() + 2 * HOUR + i * MIN), sinks: [bad], deliveryStreak: streak,
      });
      if (r.escalate) escalated = true;
    }
    expect(escalated, "the streak must re-arm after a success").toBe(true);
  });

  it("a pass with NOTHING to deliver neither advances nor clears the streak", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const bad = refusing("webhook", "HTTP 500");

    await runAlertPass(db, { now: NOW, sinks: [bad], deliveryStreak: streak });
    expect(streak.consecutiveFailures).toBe(1);

    // A world with nothing wrong: no alert fires, so no delivery is attempted. Silence is not
    // evidence that the pager works — a pager that looks fine because nothing has asked it to
    // do anything is precisely the fault this file exists to report.
    const clean = await makeTestDb();
    const quiet = await runAlertPass(clean, {
      now: NOW, sinks: [bad], shards: [], deliveryStreak: streak,
    });
    expect(quiet.notified).toEqual([]);
    expect(quiet.escalate).toBeNull();
    expect(streak.consecutiveFailures, "an untried sink is neither proven nor disproven").toBe(1);
  });

  it("the NO-SINK alarm is untouched: it still fires every pass, and does not consume the streak", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();

    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION + 1; i++) {
      const r = await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * MIN), sinks: [], deliveryStreak: streak,
      });
      expect(r.firing.length, "the fault is real on every pass").toBeGreaterThan(0);
      expect(r.undeliverable, "no sink configured must keep saying so, every pass").toBe(true);
      // Disjoint alarms for two different faults. Folding them together would make the
      // no-sink case go quiet after one escalation, which is a regression.
      expect(r.escalate).toBeNull();
    }
    expect(streak.consecutiveFailures).toBe(0);
  });

  it("without a streak the pass still reports every failure — it just cannot escalate", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const sink = refusing("webhook", "HTTP 403");
    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION + 2; i++) {
      const r = await runAlertPass(db, { now: new Date(NOW.getTime() + i * MIN), sinks: [sink] });
      expect(r.failedSinks).toEqual(["webhook"]);
      expect(r.sinkErrors).toEqual(["webhook: HTTP 403"]);
      expect(r.escalate).toBeNull();
    }
  });

  it("a sink that returns a bare boolean still works — the contract was widened, not replaced", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const legacy: AlertSink = { name: "mail", notify: () => Promise.resolve(false) };

    let escalation = null;
    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION; i++) {
      const r = await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * MIN), sinks: [legacy], deliveryStreak: streak,
      });
      if (r.escalate) escalation = r.escalate;
    }
    expect(escalation, "a boolean-only sink must still be escalatable").not.toBeNull();
    expect(escalation!.sinks).toEqual(["mail"]);
    expect(escalation!.errors, "it simply has nothing to add about why").toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The webhook sink says WHY — and never leaks the endpoint doing it
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("webhookAlertSink diagnostics", () => {
  const CTX = { source: "worker", environment: "test", now: NOW };
  const ONE: Alert[] = [{
    key: "k", kind: "sends_stuck", severity: "critical",
    title: "t", detail: "d", count: 1, oldestSeconds: 60,
  }];

  it("reports the HTTP status AND the response body — the two halves of a rejection", async () => {
    const sink = webhookAlertSink(
      "https://ntfy.example/topic",
      async () => ({ status: 429, body: '{"code":42204,"error":"rate limit reached"}' }),
    )!;
    const r = await sink.notify(ONE, CTX) as { ok: boolean; error?: string | null };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 429");
    expect(r.error, "the body is where every one of these services explains itself")
      .toContain("rate limit reached");
  });

  it("reports a THROWN transport failure with its cause", async () => {
    const sink = webhookAlertSink("https://ntfy.example/topic", () => {
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "ENOTFOUND" };
      throw err;
    })!;
    const r = await sink.notify(ONE, CTX) as { ok: boolean; error?: string | null };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("fetch failed");
    expect(r.error).toContain("ENOTFOUND");
  });

  it("NEVER puts the endpoint path in the diagnostic — it is a bearer credential", async () => {
    // An ntfy topic, a Slack hook path and a Discord webhook token are all secrets carried in
    // the URL path, and these strings go to a log drain. The HOST survives, because
    // `ENOTFOUND ntfy.example` is the diagnosis and the host is not the secret.
    const token = "webhook-path-fixture-token";
    const secret = `/ohmail-alerts-${token}`;
    const url = `https://ntfy.example${secret}`;
    const sink = webhookAlertSink(url, async () => ({
      status: 404, body: `no such topic: ${url} (${secret})`,
    }))!;
    const r = await sink.notify(ONE, CTX) as { ok: boolean; error?: string | null };
    expect(r.error).not.toContain(token);
    expect(r.error).not.toContain(secret);
    expect(r.error, "the host is diagnostic, not secret").toContain("ntfy.example");
    expect(r.error).toContain("HTTP 404");
  });

  it("bounds the diagnostic — an endpoint that answers a novel is not a log bill", () => {
    const out = redactEndpoint("x".repeat(5000), "https://ntfy.example/t");
    expect(out.length).toBeLessThanOrEqual(201);
  });

  it("a 2xx is a success and says nothing", async () => {
    const sink = webhookAlertSink("https://ntfy.example/topic", async () => ({ status: 200 }))!;
    const r = await sink.notify(ONE, CTX) as { ok: boolean; error?: string | null };
    expect(r.ok).toBe(true);
    expect(r.error ?? null).toBeNull();
  });

  it("SET-BUT-UNPARSEABLE is a named fault, not silence — the quoted-env trap", async () => {
    // `TF_ALERT_WEBHOOK_URL="https://…"` with the quotes stored in the value. `fetch` threw,
    // the old `catch` returned a bare `false`, and the deployment looked configured forever.
    // Returning null would be worse still: the pass would then report `undeliverable` and tell
    // the operator to set a variable that IS set.
    const quoted = '"https://ntfy.example/topic"';
    const sink = webhookAlertSink(quoted, async () => { throw new Error("must not be called"); });
    expect(sink, "a set-but-broken value must NOT look like an unset one").not.toBeNull();
    const r = await sink!.notify(ONE, CTX) as { ok: boolean; error?: string | null };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a parseable URL");
  });

  it("rejects a non-http scheme at construction rather than at every delivery", async () => {
    const sink = webhookAlertSink("ftp://ntfy.example/topic", async () => ({ status: 200 }));
    const r = await sink!.notify(ONE, CTX) as { ok: boolean; error?: string | null };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not http(s)");
  });
});
