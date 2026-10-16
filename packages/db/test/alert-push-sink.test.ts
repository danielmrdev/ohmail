import { describe, it, expect } from "vitest";
import {
  telegramAlertSink, TELEGRAM_API_ORIGIN, TELEGRAM_TEXT_LIMIT,
} from "../src/alert-push.js";
import type { Alert, AlertNotifyContext, PostJson } from "../src/alerts.js";

/**
 * The pager's SECOND vendor.
 *
 * The mail arm and this one share a seam and nothing else: different company, different
 * network, different credential, different delivery channel. That last one is load-bearing —
 * the operator address is a mailbox this product serves, so a mail-path incident is both worth
 * paging about and a reason the page may not be seen.
 *
 * What is asserted here is the same list the mail arm's guards cover, because the failures are
 * the same failures: a credential that reaches a log, a set-but-unusable value that looks like
 * an unset one, a payload that grows a field nobody vetted, and a sink that swallows its own
 * failure instead of reporting it.
 */

const NOW = new Date("2026-08-22T12:00:00.000Z");
const CTX: AlertNotifyContext = { source: "worker", environment: "production", now: NOW };

/** A real-shaped BotFather token. Fictional, and it never leaves this file. */
const TOKEN = "8123456789:AAF-fakefakefakefakefakefakefake0123";
const CHAT = "-1001234567890";

const ALERTS: Alert[] = [{
  key: "worker_down:0",
  kind: "worker_down",
  severity: "critical",
  title: "shard 0 has no worker heartbeat",
  detail: "No leader heartbeat for shard 0. The last one was 2 hours ago; nothing is syncing.",
  count: 1,
  oldestSeconds: 7200,
}];

/** Records every POST and answers with whatever the test set. */
function spy(status = 200, body?: string) {
  const calls: { url: string; body: string; headers?: Record<string, string> }[] = [];
  const post: PostJson = async (url, b, headers) => {
    calls.push({ url, body: b, headers });
    return { status, body };
  };
  return { calls, post };
}

describe("telegramAlertSink — arming", () => {
  it("neither variable set ⇒ no arm, quietly", () => {
    expect(telegramAlertSink({})).toBeNull();
    expect(telegramAlertSink({ botToken: "  ", chatId: "" })).toBeNull();
  });

  it("HALF configured refuses and names the missing variable — it must not look unset", async () => {
    const noChat = telegramAlertSink({ botToken: TOKEN });
    expect(noChat, "an arm somebody started configuring is not an absent arm").not.toBeNull();
    const a = await noChat!.notify(ALERTS, CTX);
    expect(a).toMatchObject({ ok: false, outcome: "misconfigured" });
    expect((a as { error: string }).error).toContain("TF_ALERT_TELEGRAM_CHAT_ID");

    const noToken = telegramAlertSink({ chatId: CHAT });
    expect(noToken).not.toBeNull();
    const b = await noToken!.notify(ALERTS, CTX);
    expect(b).toMatchObject({ ok: false, outcome: "misconfigured" });
    expect((b as { error: string }).error).toContain("TF_ALERT_TELEGRAM_BOT_TOKEN");
  });

  it("the quoted-env trap is a NAMED fault, not a permanently silent arm", async () => {
    const sink = telegramAlertSink({ botToken: `"${TOKEN}"`, chatId: CHAT });
    const out = await sink!.notify(ALERTS, CTX);
    expect(out).toMatchObject({ ok: false, outcome: "misconfigured" });
    expect((out as { error: string }).error).toContain("quotes");
    expect(
      (out as { error: string }).error,
      "the refusal is written to a log drain — it may not quote the credential back",
    ).not.toContain(TOKEN);
  });

  it("a chat TITLE is not a chat id, and is refused at build time", async () => {
    const sink = telegramAlertSink({ botToken: TOKEN, chatId: "ohmail alerts" });
    const out = await sink!.notify(ALERTS, CTX);
    expect(out).toMatchObject({ ok: false, outcome: "misconfigured" });
    expect((out as { error: string }).error).toContain("TF_ALERT_TELEGRAM_CHAT_ID");
  });

  it("accepts the two forms Telegram actually issues", () => {
    for (const chatId of [CHAT, "123456789", "@ohmail_alerts"]) {
      const sink = telegramAlertSink({ botToken: TOKEN, chatId });
      expect(sink, `${chatId} is a chat id Telegram hands out`).not.toBeNull();
      expect(sink!.name).toBe("telegram");
    }
  });
});

describe("telegramAlertSink — the wire", () => {
  it("posts sendMessage on the bot's own path, with the alert text and nothing else", async () => {
    const { calls, post } = spy(200);
    const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
    const out = await sink!.notify(ALERTS, CTX);

    expect(out).toEqual({ ok: true, outcome: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${TELEGRAM_API_ORIGIN}/bot${TOKEN}/sendMessage`);

    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(
      Object.keys(body).sort(),
      "the payload key set is pinned: a field nobody vetted must not reach a third party",
    ).toEqual(["chat_id", "disable_web_page_preview", "text"]);
    expect(body["chat_id"], "a STRING — a channel id past 2^53 does not survive a double").toBe(CHAT);
    expect(body["disable_web_page_preview"]).toBe(true);
    expect(body["text"]).toContain("no worker heartbeat");
    expect(body["text"]).toContain("production");
  });

  it("caps the text at Telegram's own limit rather than earning a 400 mid-incident", async () => {
    const { calls, post } = spy(200);
    const many: Alert[] = Array.from({ length: 40 }, (_, i) => ({
      ...ALERTS[0]!,
      key: `sync_lag:${i}`,
      detail: `${"a mailbox has not synced within the threshold. ".repeat(6)}#${i}`,
    }));
    const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
    const out = await sink!.notify(many, CTX);

    expect(out).toEqual({ ok: true, outcome: "ok" });
    const text = (JSON.parse(calls[0]!.body) as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(text, "a truncated page must say that it was truncated").toContain("(truncated)");
  });

  it("a refusal carries the vendor's reason AND a closed code, with the token redacted", async () => {
    const { post } = spy(400, `{"ok":false,"description":"Bad Request: chat not found"}`);
    const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
    const out = await sink!.notify(ALERTS, CTX) as { ok: boolean; outcome: string; error: string };

    expect(out.ok).toBe(false);
    expect(out.outcome).toBe("refused");
    expect(out.error, "the reason a sink refuses is the whole diagnosis").toContain("chat not found");
    expect(out.error).toContain("400");
    expect(out.error, "the bot token is a URL-PATH credential").not.toContain(TOKEN);
  });

  it("redacts a token the API echoes back inside its own error body", async () => {
    const other = "9987654321:BBQ-anotherfaketokenvalue-abcdefghij";
    const { post } = spy(401, `{"description":"Unauthorized for ${other}"}`);
    const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
    const out = await sink!.notify(ALERTS, CTX) as { error: string };
    expect(
      out.error,
      "exact-string redaction misses a rotated token; the SHAPE has to go too",
    ).not.toContain(other);
    expect(out.error).toContain("<redacted>");
  });

  it("redacts an echoed token whose secret ENDS IN A HYPHEN at the pattern's own floor", async () => {
    // Review finding, and the mechanism is narrower and nastier than "a word boundary fails".
    //
    // The secret half may legally end in `-`, which is not a word character, so a trailing
    // `\b` needs a word character NEXT and an echoed token before a quote or at end-of-string
    // has none. That alone is survivable: the quantifier is greedy, so the engine BACKTRACKS
    // one character, ends the match on the alphanumeric before the hyphen, and still redacts
    // the secret (leaving a stray `-`). The leak is where backtracking runs out of room — a
    // secret at the pattern's own minimum length, where dropping the final hyphen breaks the
    // `{30,}` floor and the match fails entirely, at every start position. Nothing is
    // redacted, and the exact-endpoint pass cannot cover it either: that looks for the whole
    // URL, not a bare token. So the boundary is "not a token character", stated both ways.
    //
    // Exactly 30 characters after the colon, last one a hyphen — the leaking case.
    const trailing = "9987654321:BBQanotherfaketokenvalue12345-";
    expect(trailing.split(":")[1]!.length, "the guard depends on hitting the floor exactly").toBe(30);
    for (const body of [
      `{"description":"Unauthorized for ${trailing}"}`,
      `{"description":"${trailing}"}`,
      `token ${trailing}`,
    ]) {
      const { post } = spy(401, body);
      const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
      const out = await sink!.notify(ALERTS, CTX) as { error: string };
      expect(out.error, `a credential must not survive: ${body}`).not.toContain(trailing);
      expect(out.error).toContain("<redacted>");
    }
  });

  it("redacts an echoed token whatever punctuation the body glues it to", async () => {
    // The left boundary this replaced excluded `:` and `-` — the two commonest delimiters in
    // error prose — and because every interior start position is preceded by a digit, the WHOLE
    // token then survived. `token:<token>` and `bot-<token>` are not exotic shapes; they are
    // what an error message looks like. So the pattern asserts no boundary at all, and this is
    // the matrix that says so.
    const tokens = [
      "9987654321:BBQanotherfaketokenvalue12345-",        // secret at the {30,} floor, ends '-'
      "9987654321:BBQ-anotherfaketokenvaluehere12-",      // longer, ends '-'
      "8123456789:AAF-fakefakefakefakefakefakefake0123",  // ends alphanumeric
    ];
    for (const tok of tokens) {
      for (const body of [
        `token:${tok}`, `bot-${tok}`, `Unauthorized for ${tok}`, tok,
        `x${tok}`, `{"description":"${tok}"}`, `prefix--${tok}`,
      ]) {
        const { post } = spy(401, body);
        const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
        const out = await sink!.notify(ALERTS, CTX) as { error: string };
        expect(out.error, `a credential must not survive: ${body}`).not.toContain(tok);
      }
    }
  });

  it("bounds the diagnostic — an observability field may not become a log bill", async () => {
    const { post } = spy(500, "x".repeat(5000));
    const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
    const out = await sink!.notify(ALERTS, CTX) as { error: string };
    expect(out.error.length).toBeLessThanOrEqual(201);
  });
});

describe("telegramAlertSink — failure never escapes", () => {
  it("a blackholed host is `unreachable`, not a refusal, and it does not throw", async () => {
    const post: PostJson = () => Promise.reject(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } }),
    );
    const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
    const out = await sink!.notify(ALERTS, CTX) as { ok: boolean; outcome: string; error: string };
    expect(out.ok).toBe(false);
    expect(
      out.outcome,
      "the ntfy failure shape: nobody said no, the packets went nowhere",
    ).toBe("unreachable");
    expect(out.error).toContain("ETIMEDOUT");
  });

  it("the sink's own deadline is `timeout`", async () => {
    const post: PostJson = () => Promise.reject(
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
    );
    const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
    const out = await sink!.notify(ALERTS, CTX) as { outcome: string };
    expect(out.outcome).toBe("timeout");
  });

  it("a symbol-valued rejection does not make the formatter the thing that throws", async () => {
    const post: PostJson = () => Promise.reject({ name: Symbol("nope"), message: Symbol("also") });
    const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
    await expect(sink!.notify(ALERTS, CTX)).resolves.toMatchObject({ ok: false });
  });

  it("never resolves `ok` for a status the API did not accept", async () => {
    for (const status of [301, 400, 401, 403, 429, 500, 502]) {
      const { post } = spy(status);
      const sink = telegramAlertSink({ botToken: TOKEN, chatId: CHAT }, post);
      const out = await sink!.notify(ALERTS, CTX) as { ok: boolean };
      expect(out.ok, `HTTP ${status} is not a delivered page`).toBe(false);
    }
  });
});
