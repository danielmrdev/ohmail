import { createServer } from "node:http";
import { describe, it, expect } from "vitest";
import { FIXTURE_SHAPES, managedDomain, resendKey } from "../../../test/support/fixture-credentials.js";
import { makeTestDb } from "../src/testing.js";
import { accounts, outboundSends,} from "@trafficflow/db";
import {
  runAlertPass, writeHeartbeat, newDeliveryStreak, nodePostJson,
  DEFAULT_SINK_FAILURE_ESCALATION,
  type Alert, type PostJson,
} from "../src/alerts.js";
import {
  resendAlertSink, RESEND_EMAILS_URL, ALERT_IDEMPOTENCY_BUCKET_MS,
} from "../src/alert-mail.js";

/**
 * ── THE PRODUCTION FAILURE THIS FILE EXISTS FOR, MEASURED NOT IMAGINED ────────────────────
 *
 * 2026-08-21: the worker's only sink was the webhook, pointed at ntfy.sh, and ntfy.sh
 * blackholes the hosting platform's egress IPs — probed from inside the worker's own
 * container: both web ports ETIMEDOUT while https://example.com and https://api.resend.com
 * answered. `sinkFailureStreak` climbed into the hundreds while a critical alert was really firing.
 * The pager was dead and the only thing that knew was the log nobody was paged about.
 *
 * The product is mail, and its transactional mail path (Resend) is reachable from the same
 * container that could not reach the webhook. So the worker gets a mail arm: one JSON POST,
 * no `packages/services` import — the worker may import core + db only, which is why the
 * sink lives in `packages/db` and not next to `MailService`.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const NOW = new Date("2026-08-21T12:00:00.000Z");
const MIN = 60_000;
const CTX = { source: "worker", environment: "test", now: NOW };
const KEY = "re_test_8fQ2vXk1TESTKEYc7Jw";
const FROM = "ohmail <no-reply@ohmail.example>";
const TO = "operator@ohmail.example";
const CFG = { apiKey: KEY, from: FROM, to: TO };

const ONE: Alert[] = [{
  key: "worker_down:0", kind: "worker_down", severity: "critical",
  title: "shard 0 has no worker heartbeat",
  detail: "No leader heartbeat for shard 0; the last one arrived 1d ago.",
  count: 1, oldestSeconds: 90_000,
}];

/** A PostJson that records what it was handed and answers a fixed status. */
function capturing(status = 200): PostJson & { calls: Array<{ url: string; body: string; headers?: Record<string, string> }> } {
  const calls: Array<{ url: string; body: string; headers?: Record<string, string> }> = [];
  const post = (async (url: string, body: string, headers?: Record<string, string>) => {
    calls.push({ url, body, headers });
    return { status };
  }) as PostJson & { calls: typeof calls };
  post.calls = calls;
  return post;
}

async function notifyOne(sink: NonNullable<ReturnType<typeof resendAlertSink>>) {
  return await sink.notify(ONE, CTX) as { ok: boolean; error?: string | null };
}

describe("resendAlertSink construction — TF_ALERT_EMAIL is the arming variable", () => {
  it("no address is NULL — even with the mailer halves set, because clearing it is a disarm", () => {
    // An operator who blanks TF_ALERT_EMAIL has turned the mail arm off on purpose; a
    // deployment whose RESEND_API_KEY + MAIL_FROM exist for OTHER mail must not escalate
    // forever about a pager that is deliberately off. Matches the API host's arming
    // semantics for its own mail sink.
    expect(resendAlertSink({})).toBeNull();
    expect(resendAlertSink({ apiKey: KEY, from: FROM })).toBeNull();
    expect(resendAlertSink({ apiKey: KEY, from: FROM, to: "  " })).toBeNull();
  });

  it("ARMED but missing the mailer is a named fault, not silence and not unset", async () => {
    // The webhook sink's own lesson: a value that is present-but-unusable must not look like
    // an unset one (the pass would tell the operator to set a variable that IS set), and must
    // not be a bare `false` forever (the state the ntfy outage spent months in). A sink is
    // returned, it refuses everything, and it names exactly what is missing.
    const post = capturing();
    const sink = resendAlertSink({ to: TO }, post);
    expect(sink, "armed-but-incomplete must NOT look like unset").not.toBeNull();
    const r = await notifyOne(sink!);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("RESEND_API_KEY");
    expect(r.error).toContain("MAIL_FROM");
    expect(post.calls, "a misconfigured sink must never reach the network").toHaveLength(0);

    const r2 = await notifyOne(resendAlertSink({ to: TO, apiKey: KEY }, post)!);
    expect(r2.error).toContain("MAIL_FROM");
    expect(r2.error).not.toContain("RESEND_API_KEY");
    expect(post.calls).toHaveLength(0);
  });

  it("an address that is not a single plain address is the quoted-env trap, named", async () => {
    // `TF_ALERT_EMAIL="ops@…"` with the quotes stored in the value, a display-name form, or
    // a comma list. Refused at construction with the variable named, never sent.
    const post = capturing();
    for (const bad of ['"ops@ohmail.example"', "ops@a.example, ops@b.example", "ohmail <ops@ohmail.example>", "not-an-address"]) {
      const r = await notifyOne(resendAlertSink({ ...CFG, to: bad }, post)!);
      expect(r.ok, `must refuse: ${bad}`).toBe(false);
      expect(r.error).toContain("TF_ALERT_EMAIL");
    }
    expect(post.calls).toHaveLength(0);
  });

  it("an apostrophe INSIDE the local part is a legal address, not the quoted-env trap", async () => {
    // Independent-review finding: the first validator rejected quotes ANYWHERE, so a
    // legitimate o'connor@ operator address built a permanently-refusing sink — with the
    // webhook arm already dead, that is a pager that never pages, reached through a valid
    // configuration. Only SURROUNDING quotes are the env trap; interior apostrophes are mail.
    const post = capturing(200);
    const r = await notifyOne(resendAlertSink({ ...CFG, to: "o'connor@ohmail.example" }, post)!);
    expect(r.ok).toBe(true);
    expect(post.calls).toHaveLength(1);
    expect((JSON.parse(post.calls[0]!.body) as { to: string[] }).to).toEqual(["o'connor@ohmail.example"]);
  });

  it("structurally broken addresses are refused at construction, not as provider failures", async () => {
    // Independent-review finding: two @s, a dotless domain, separators and escapes slipped
    // the first validator and would have surfaced as an endless provider-refusal streak
    // instead of a named TF_ALERT_EMAIL fault. Named at build time, like the webhook URL.
    const post = capturing();
    for (const bad of [
      "one@ohmail.example@two.example",   // two @s
      "ops@ohmail",                        // no dot in the domain
      "a;b@ohmail.example",                // list separator
      "a\\b@ohmail.example",               // escape
      "'ops@ohmail.example'",              // surrounding single quotes — still the env trap
    ]) {
      const r = await notifyOne(resendAlertSink({ ...CFG, to: bad }, post)!);
      expect(r.ok, `must refuse: ${bad}`).toBe(false);
      expect(r.error).toContain("TF_ALERT_EMAIL");
    }
    expect(post.calls).toHaveLength(0);
  });
});

describe("resendAlertSink delivery — one JSON POST to the product's own mail path", () => {
  it("posts to the Resend emails endpoint with the bearer header and an operator-readable mail", async () => {
    const post = capturing(200);
    const sink = resendAlertSink(CFG, post)!;
    expect(sink.name, "one name for the mail path across both drivers").toBe("mail");
    const r = await notifyOne(sink);
    expect(r.ok).toBe(true);
    expect(r.error ?? null).toBeNull();

    expect(post.calls).toHaveLength(1);
    const call = post.calls[0]!;
    expect(call.url).toBe(RESEND_EMAILS_URL);
    expect(call.headers?.authorization).toBe(`Bearer ${KEY}`);

    const body = JSON.parse(call.body) as Record<string, unknown>;
    // THE KEY SET IS THE CONTENT BOUNDARY: `Alert` is structurally content-free, so a payload
    // built from exactly these five fields cannot carry mail content (the html is the text's
    // blocks, escaped — 2026-09-28, one renderer for both hosts). A sixth field added to the
    // payload is a review event, and this line is what forces it.
    expect(Object.keys(body).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(body.from).toBe(FROM);
    expect(body.to).toEqual([TO]);
    // The subject carries the environment and the count — the same first words as the
    // webhook title, so nobody pages on staging by mistaking it for production.
    expect(body.subject).toBe("[test] ohmail: 1 alert firing");
    // The text is renderAlertMail's: title + detail, counts and ages ONLY.
    expect(body.text).toContain("shard 0 has no worker heartbeat");
    expect(body.text).toContain("the last one arrived 1d ago");
    expect(body.text).toContain("Observed by the worker alert pass.");
    expect(body.html).toContain("the last one arrived 1d ago");
  });

  it("every send carries an Idempotency-Key, stable per notification window", async () => {
    // Independent-review finding: a POST Resend ACCEPTED whose response was lost looks like a
    // failure, the pass releases its claim, and the 60 s retry sends a second mail — per
    // minute, for as long as the response path is broken. The design direction stands (a
    // duplicate page beats a swallowed one — `runAlertPass`'s header), so the key is BUCKETED:
    // retries inside one window dedupe provider-side, and a genuinely failed send is blocked
    // by a stale key for at most one bucket before a fresh key retries cleanly.
    const post = capturing(200);
    const sink = resendAlertSink(CFG, post)!;
    await sink.notify(ONE, CTX);
    await sink.notify(ONE, { ...CTX, now: new Date(NOW.getTime() + 60_000) });      // next pass, same bucket
    await sink.notify(ONE, { ...CTX, now: new Date(NOW.getTime() + ALERT_IDEMPOTENCY_BUCKET_MS + 1) });
    const keys = post.calls.map((c) => c.headers?.["Idempotency-Key"]);
    expect(keys[0], "the header must be present").toBeTruthy();
    expect(keys[1], "a 60 s retry inside the window must dedupe").toBe(keys[0]);
    expect(keys[2], "a later window is a new page and must send").not.toBe(keys[0]);
    // A different alert set is a different page, never deduped against this one.
    await sink.notify([{ ...ONE[0]!, key: "sends_stuck" }], CTX);
    expect(post.calls[3]!.headers?.["Idempotency-Key"]).not.toBe(keys[0]);
  });

  it("a refusal reports the HTTP status and the response body — with the API key NEVER in it", async () => {
    // Contrived echo: even if Resend's error body quoted the credential, the diagnostic is
    // drain-bound and must not carry it.
    const post: PostJson = async () => ({ status: 422, body: `{"message":"invalid from, key ${KEY}"}` });
    const r = await notifyOne(resendAlertSink(CFG, post)!);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 422");
    expect(r.error).toContain("invalid from");
    expect(r.error).not.toContain(KEY);
  });

  it("redaction is not defeated by a DIFFERENT key in the body, nor by bearer echoes", async () => {
    // Independent-review finding: exact-string replacement misses every variant the sink did
    // not configure — a rotated old key echoed by the provider, or an Authorization line
    // quoted whole. Anything shaped like a Resend key or a bearer value is scrubbed, not just
    // the one string this sink holds.
    const other = resendKey("rotated-old-key");
    expect(other, "the rotated key has the vendor key's shape").toMatch(FIXTURE_SHAPES.resend);
    const post: PostJson = async () => ({
      status: 401, body: `{"message":"key ${other} revoked; sent Authorization: Bearer ${KEY}"}`,
    });
    const r = await notifyOne(resendAlertSink(CFG, post)!);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 401");
    expect(r.error).not.toContain(other);
    expect(r.error).not.toContain(KEY);
    expect(r.error, "the shape of the message survives — only the secrets go").toContain("revoked");
  });

  it("a thrown transport failure reports its cause and never throws through", async () => {
    const post: PostJson = () => {
      const err = new TypeError(`fetch failed for Bearer ${KEY}`);
      (err as { cause?: unknown }).cause = { code: "ETIMEDOUT" };
      throw err;
    };
    const r = await notifyOne(resendAlertSink(CFG, post)!);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("fetch failed");
    expect(r.error).toContain("ETIMEDOUT");
    expect(r.error).not.toContain(KEY);
  });

  it("bounds the diagnostic — a provider that answers a novel is not a log bill", async () => {
    const post: PostJson = async () => ({ status: 500, body: "x".repeat(5000) });
    const r = await notifyOne(resendAlertSink(CFG, post)!);
    expect(r.error!.length).toBeLessThanOrEqual(210);
  });

  it("a throw whose properties are not strings still resolves false — notify NEVER rejects", async () => {
    // Independent-review finding: template interpolation of a Symbol throws, so a transport
    // rejecting with `{ message: Symbol(...) }` made the FORMATTER the thing that threw —
    // `deliver()`'s belt caught it, but the sink's own never-reject contract was violated.
    const post: PostJson = () => {
      const weird = { name: Symbol("boom"), message: Symbol("secret-ish"), cause: { code: Symbol("c") } };
      throw weird;
    };
    const r = await notifyOne(resendAlertSink(CFG, post)!);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error!.length).toBeGreaterThan(0);
  });

  it("the REAL nodePostJson carries the authorization header to the wire", async () => {
    // The fakes above prove the sink hands headers to its PostJson; this proves the default
    // PostJson does not drop them. A merge that lost `authorization` would be a 401 on every
    // live delivery under a fully green suite — the injected default is otherwise the one
    // branch nothing exercises. Loopback only; the suite-wide network trap allows it.
    const seen: Array<{ auth?: string; contentType?: string; body: string }> = [];
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c: string) => { data += c; });
      req.on("end", () => {
        seen.push({
          auth: req.headers.authorization,
          contentType: req.headers["content-type"],
          body: data,
        });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const res = await nodePostJson(
        `http://127.0.0.1:${port}/emails`, '{"probe":true}', { authorization: "Bearer sk-x" },
      );
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.auth).toBe("Bearer sk-x");
      expect(seen[0]!.contentType).toBe("application/json");
      expect(seen[0]!.body).toBe('{"probe":true}');

      // Independent-review finding: with caller headers spread AFTER the default, a caller's
      // `content-type` replaced it, and a differently-cased `Content-Type` combined into an
      // invalid `application/json, text/plain` at the wire. The media type is this seam's
      // contract (`PostJson` — ONE JSON POST), so the caller cannot move it, in any casing.
      await nodePostJson(
        `http://127.0.0.1:${port}/emails`, '{"p":2}',
        { "Content-Type": "text/plain", authorization: "Bearer sk-y" },
      );
      expect(seen).toHaveLength(2);
      expect(seen[1]!.contentType, "the JSON media type must survive any caller casing")
        .toBe("application/json");
      expect(seen[1]!.auth, "unrelated headers still pass").toBe("Bearer sk-y");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("the mail arm plugs into the escalation — failure KEEPS logging alerts_undeliverable", () => {
  /** A world with one real, permanently-firing alert to try to deliver. */
  async function seedFiring(db: Db): Promise<void> {
    const [acct] = await db.insert(accounts).values({ name: "MailSink" }).returning();
    await writeHeartbeat(db, {
      shardIndex: 0, instanceId: "wkr-test", shards: 1,
      mailboxes: 0, expected: 0, accounts: 1, quarantined: 0, degraded: false,
      lastCycleAt: NOW, startedAt: new Date(NOW.getTime() - 60 * MIN),
    }, NOW);
    // One STUCK SEND, which is what makes an alert fire here now: `sends_stuck` needs a single
    // planted row and no metering, and the subject of this file is the SINK rather than the rule.
    await db.insert(outboundSends).values({
      accountId: acct!.id,
      idempotencyKey: "idem-mail-sink",
      mintedMessageId: `<mail-sink@app.${managedDomain()}>`,
      status: "pending",
      createdAt: new Date(NOW.getTime() - 60 * MIN),
    });
  }

  it("a refusing mail sink escalates after N attempts, naming the sink and the reason", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const post: PostJson = async () => ({ status: 403, body: "forbidden" });
    const sink = resendAlertSink(CFG, post)!;

    let escalation = null;
    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION; i++) {
      const r = await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * MIN), sinks: [sink], deliveryStreak: streak,
      });
      if (r.escalate) escalation = r.escalate;
    }
    expect(escalation, "a dead mail arm is the same outage the dead webhook was").not.toBeNull();
    expect(escalation!.sinks).toEqual(["mail"]);
    expect(escalation!.errors[0]).toContain("HTTP 403");
  });

  it("a delivering mail sink is a delivery — the streak clears and the alert is confirmed", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const post = capturing(200);
    const sink = resendAlertSink(CFG, post)!;

    const r = await runAlertPass(db, { now: NOW, sinks: [sink], deliveryStreak: streak });
    expect(r.delivered).toEqual(["mail"]);
    expect(r.failedSinks).toEqual([]);
    expect(r.sinkFailureStreak).toBe(0);
    // The page, then the first daily digest: no digest has ever been accepted, and the window
    // holds the incident this pass opened.
    expect(post.calls.map((c) => (JSON.parse(c.body) as { subject: string }).subject))
      .toEqual(["[production] ohmail: 1 alert firing", "[production] ohmail: daily alert summary — 1 incident"]);
  });
});

/**
 * A provider with Resend's idempotency contract: a key it has seen with the SAME body replays the
 * stored answer and mails nothing; a key it has seen with a DIFFERENT body is refused with 409.
 * `loseNext` drops the response after the provider accepted, the way a broken return path does.
 */
function idempotentProvider(): PostJson & { mailed: string[]; loseNext: boolean } {
  const seen = new Map<string, string>();
  const mailed: string[] = [];
  const post = (async (_url: string, body: string, headers?: Record<string, string>) => {
    const key = headers?.["Idempotency-Key"] ?? "";
    const prior = seen.get(key);
    if (prior !== undefined && prior !== body) return { status: 409, body: "invalid_idempotent_request" };
    if (prior === undefined) { seen.set(key, body); mailed.push(body); }
    if (post.loseNext) { post.loseNext = false; throw new TypeError("fetch failed"); }
    return { status: 200 };
  }) as PostJson & { mailed: string[]; loseNext: boolean };
  post.mailed = mailed;
  post.loseNext = false;
  return post;
}

describe("the pager never refuses itself", () => {
  it("a retry whose body changed inside one bucket is a new key, and is delivered once", async () => {
    const post = idempotentProvider();
    const sink = resendAlertSink(CFG, post)!;
    post.loseNext = true;
    const lost = await sink.notify(ONE, CTX) as { ok: boolean };
    expect(lost.ok, "the provider mailed it; the pager could not know").toBe(false);
    const changed: Alert[] = [{ ...ONE[0]!, detail: "No leader heartbeat for shard 0; the last one arrived 2d ago." }];
    const retry = await sink.notify(changed, { ...CTX, now: new Date(NOW.getTime() + MIN) }) as { ok: boolean };
    expect(retry.ok, "a changed body under the old key was the 409 that silenced the pager").toBe(true);
    const again = await sink.notify(changed, { ...CTX, now: new Date(NOW.getTime() + 2 * MIN) }) as { ok: boolean };
    expect(again.ok).toBe(true);
    expect(post.mailed, "the identical retry replays, it does not mail again").toHaveLength(2);
  });

  it("a pass whose signature moved three minutes after a page is HELD — no POST, nothing refused", async () => {
    const db = await makeTestDb();
    const [acct] = await db.insert(accounts).values({ name: "MailSinkF4" }).returning();
    const stuck = (tag: string) => db.insert(outboundSends).values({
      accountId: acct!.id, idempotencyKey: `idem-${tag}`, mintedMessageId: `<${tag}@app.ohmail.app>`,
      status: "pending", createdAt: new Date(NOW.getTime() - 60 * MIN),
    });
    await stuck("f4-one");
    const post = idempotentProvider();
    const sink = resendAlertSink(CFG, post)!;
    const first = await runAlertPass(db, { now: NOW, sinks: [sink], shards: [] });
    expect(first.delivered).toEqual(["mail"]);
    await stuck("f4-two");
    const mailedBefore = post.mailed.length;
    const moved = await runAlertPass(db, { now: new Date(NOW.getTime() + 3 * MIN), sinks: [sink], shards: [] });
    // Inside the kind's mail window the moved signature is claimed and held: the 409 a new body
    // under an old key once caused cannot arise, because nothing is posted at all.
    expect(moved.mailHeld.map((h) => h.alertKey)).toEqual(["sends_stuck"]);
    expect(moved.failedSinks).toEqual([]);
    expect(moved.notified).toEqual([]);
    expect(post.mailed.length).toBe(mailedBefore);
  });

  it("the mail arm has no notifyResolved — a cleared alert is in the digest, not a mail", () => {
    const sink = resendAlertSink(CFG, capturing(200))!;
    expect("notifyResolved" in sink).toBe(false);
    expect(sink.channel).toBe("mail");
  });

  it("the digest's key names its window, and a retry from the other driver sends the same mail", async () => {
    const post = capturing(200);
    const sink = resendAlertSink(CFG, post)!;
    const digest = {
      since: "2026-09-24T13:20:00.000Z", more: 0,
      lines: [{
        key: "sync_lag:critical", kind: "sync_lag", severity: "critical", title: "2 mailboxes behind",
        openedAt: "2026-09-25T09:03:00.000Z", resolvedAt: "2026-09-25T13:20:00.000Z",
      }],
    };
    const r = await sink.notifyDigest!(digest, CTX) as { ok: boolean };
    expect(r.ok).toBe(true);
    await sink.notifyDigest!(digest, { ...CTX, source: "api", now: new Date(NOW.getTime() + 5 * MIN) });
    const [one, two] = post.calls;
    expect(one!.headers?.["Idempotency-Key"]).toMatch(/^tf-alert\/digest\/2026-09-24T13:20:00\.000Z\//);
    expect(two!.headers?.["Idempotency-Key"], "another driver, another minute: the same mail").toBe(one!.headers?.["Idempotency-Key"]);
    expect(two!.body).toBe(one!.body);
    const body = JSON.parse(one!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(body.subject).toBe("[test] ohmail: daily alert summary — 1 incident");
  });
});
