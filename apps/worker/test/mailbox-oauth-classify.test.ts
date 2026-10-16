import { describe, it, expect } from "vitest";
import {
  MAILBOX_ERROR_DETAIL_TOKENS,
  classifyMailboxError,
  mailboxErrorDetail,
  isSafeMailboxErrorDetail,
  loadMailboxCreds,
} from "../src/mailboxes.js";
import {
  OAuthReauthRequiredError, OAuthProviderUnavailableError, OAuthConfigError, OAuthClientRefusedError,
  StaticKeyProvider, type OAuthTokenProvider,
} from "@trafficflow/core";

/**
 * OAUTH VERDICTS IN THE MAILBOX-ERROR TAXONOMY.
 *
 * The one auth outcome is a dead refresh token (`invalid_grant`) — the user reconnects. A token
 * endpoint that is down, a deployment with no client secret: these are NOT the mailbox's credential
 * and must never be classified `auth`, because `auth` quarantines a mailbox as "bad password". A
 * Microsoft outage classified as auth would write off every oauth mailbox in the fleet at once.
 */
describe("classifyMailboxError — OAuth", () => {
  it("OAuthReauthRequiredError → 'auth', and its detail is the storable OAUTH_INVALID_GRANT", () => {
    const err = new OAuthReauthRequiredError("AADSTS700082");
    expect(classifyMailboxError(err, "sync")).toBe("auth");
    expect(classifyMailboxError(err, "attach")).toBe("auth");
    expect(mailboxErrorDetail(err)).toBe("OAUTH_INVALID_GRANT");
  });

  it("OAuthProviderUnavailableError → 'connect', NEVER 'auth' — an outage is not a bad credential", () => {
    const err = new OAuthProviderUnavailableError("token endpoint returned 503");
    expect(classifyMailboxError(err, "sync")).toBe("connect");
    expect(classifyMailboxError(err, "attach")).toBe("connect");
    // Its code is deliberately NOT storable — the error_code carries the actionable part.
    expect(mailboxErrorDetail(err)).toBeNull();
  });

  it("OAuthConfigError (missing client secret) → NOT 'auth' — our misconfiguration, not the mailbox's", () => {
    const err = new OAuthConfigError("MS_OAUTH_CLIENT_SECRET", "not set");
    const code = classifyMailboxError(err, "attach");
    expect(code).not.toBe("auth");
    // It falls through to the phase fallback — a named class in the log, not an auth quarantine.
    expect(code).toBe("unknown");
  });

  it.each([
    ["OAuthClientRefusedError (the endpoint refused OUR client)", new OAuthClientRefusedError("invalid_client", 401)],
    ["OAuthConfigError (a missing client secret)", new OAuthConfigError("MS_OAUTH_CLIENT_SECRET", "not set")],
  ])("%s → 'unknown' in BOTH phases: ours, never auth and never a sync failure", (_l, err) => {
    expect(classifyMailboxError(err, "attach")).toBe("unknown");
    expect(classifyMailboxError(err, "sync")).toBe("unknown");
    expect(mailboxErrorDetail(err)).toBeNull();
  });

  it("OAUTH_INVALID_GRANT is on the closed detail allowlist; the other oauth codes are not", () => {
    expect(MAILBOX_ERROR_DETAIL_TOKENS.has("OAUTH_INVALID_GRANT")).toBe(true);
    expect(isSafeMailboxErrorDetail("OAUTH_INVALID_GRANT")).toBe(true);
    expect(MAILBOX_ERROR_DETAIL_TOKENS.has("OAUTH_TOKEN_ENDPOINT_UNAVAILABLE")).toBe(false);
    expect(MAILBOX_ERROR_DETAIL_TOKENS.has("OAUTH_CONFIG_MISSING")).toBe(false);
    expect(MAILBOX_ERROR_DETAIL_TOKENS.has("OAUTH_CLIENT_REFUSED")).toBe(false);
  });
});

/**
 * loadMailboxCreds WIRING — the worker's creds boundary routes through the shared builder, so an
 * oauth2 row becomes a token callback bound to THIS mailbox and a password row is byte-for-byte
 * unchanged. A tiny fake db stands in for the drizzle chain; the credential assembly is what's under
 * test, not the query.
 */
describe("loadMailboxCreds — the shared-builder wiring", () => {
  const KP = new StaticKeyProvider({ 1: Buffer.from("0".repeat(64), "hex") });
  type Row = { transport: string; secretEnc: string; keyVersion: number; meta: unknown };
  const fakeDb = (rows: Row[]) =>
    ({ select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) }) as unknown as
      Parameters<typeof loadMailboxCreds>[0];

  it("a password imap row yields { user, pass } and touches no token provider", async () => {
    const enc = await KP.encrypt("pw");
    const rows: Row[] = [{
      transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "imap.example.net", port: 993, secure: true, user: "u@example.net" },
    }];
    const creds = await loadMailboxCreds(fakeDb(rows), "mbx-1", KP);
    expect(creds).not.toBeNull();
    expect(creds!.imap.auth).toEqual({ user: "u@example.net", pass: "pw" });
    // No consent marker on the row ⇒ no flag on the creds — the worker's dial keeps the
    // mandatory-STARTTLS floor. `undefined`, never `false`, so `{...spread}` sites stay clean.
    expect(creds!.imap.allowInsecure).toBeUndefined();
  });

  it("`meta.insecureConsent: true` reaches the dialler as `allowInsecure` — and ONLY as `=== true`", async () => {
    // The connect-time probe wrote this marker after proving the server offers no TLS and the
    // user opted in. A worker that drops it strands the mailbox: its dial would demand the
    // STARTTLS the probe just proved absent. The `false` row is the RE-PROBED case — a server
    // that has since grown TLS has its consent rewritten to false, which must read like absence.
    const enc = await KP.encrypt("pw");
    const row = (insecureConsent: unknown): Row[] => [{
      transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "mail.tlsless.example", port: 143, secure: false, user: "u@example.net", insecureConsent },
    }];
    expect((await loadMailboxCreds(fakeDb(row(true)), "mbx-1", KP))!.imap.allowInsecure).toBe(true);
    expect((await loadMailboxCreds(fakeDb(row(false)), "mbx-1", KP))!.imap.allowInsecure).toBeUndefined();
    expect((await loadMailboxCreds(fakeDb(row("yes")), "mbx-1", KP))!.imap.allowInsecure).toBeUndefined();
  });

  it("each transport dials on ITS OWN row's consent: an SMTP marker reaches the submission leg alone", async () => {
    // R23-02: a no-TLS submission server the SMTP probe admitted must send the way it was proved,
    // and an IMAP consent licenses nothing about a different server on a different port.
    const enc = await KP.encrypt("pw");
    const rows = (imapConsent: boolean, smtpConsent: boolean): Row[] => [
      { transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
        meta: { host: "mail.home.arpa", port: 143, secure: false, user: "u@example.net", ...(imapConsent ? { insecureConsent: true } : {}) } },
      { transport: "smtp", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
        meta: { host: "mail.home.arpa", port: 587, secure: false, user: "u@example.net", ...(smtpConsent ? { insecureConsent: true } : {}) } },
    ];
    const smtpOnly = (await loadMailboxCreds(fakeDb(rows(false, true)), "mbx-1", KP))!;
    expect(smtpOnly.smtp!.allowInsecure).toBe(true);
    expect(smtpOnly.imap.allowInsecure).toBeUndefined();
    const imapOnly = (await loadMailboxCreds(fakeDb(rows(true, false)), "mbx-1", KP))!;
    expect(imapOnly.imap.allowInsecure).toBe(true);
    expect(imapOnly.smtp!.allowInsecure).toBeUndefined();
  });

  it("an oauth2 imap row yields a fetchAccessToken callback (no pass), bound to the mailbox id", async () => {
    const enc = await KP.encrypt("REFRESH-TOKEN");
    const rows: Row[] = [{
      transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: {
        host: "outlook.office365.com", port: 993, secure: true, user: "u@contoso-com.example",
        authType: "oauth2", provider: "microsoft", tenant: "common",
      },
    }];
    const forMailboxCalls: string[] = [];
    const tokenProvider: OAuthTokenProvider = {
      forMailbox: (id) => { forMailboxCalls.push(id); return () => async () => "ACCESS-TOKEN"; },
    };
    const creds = await loadMailboxCreds(fakeDb(rows), "mbx-9", KP, tokenProvider);
    expect(creds).not.toBeNull();
    expect("fetchAccessToken" in creds!.imap.auth).toBe(true);
    expect("pass" in creds!.imap.auth).toBe(false);
    expect(forMailboxCalls, "the token source was bound to this mailbox's id").toEqual(["mbx-9"]);
  });

  /**
   * AN OAUTH MAILBOX HAS A SUBMISSION PROFILE EVEN THOUGH IT HAS NO `smtp` ROW.
   *
   * One refresh token covers both transports, so the connect flow stores no second credential row
   * and the submission coordinates live in the imap row's `meta.smtp`. Returning `undefined` for
   * `smtp` — which this boundary did — told every caller "this mailbox cannot submit", and the caller
   * that believed it was the `SIZE` back-fill: an oauth mailbox reported "no SMTP credentials" and so
   * never learned what its own server accepts, on any host, for ever.
   *
   * The `auth` handed back is the SAME OBJECT as the imap leg's, deliberately: one token callback
   * means one access-token cache and one rotated-refresh-token write for the mailbox. Asserted by
   * identity below, because an equal-looking second assembly would be a second token path.
   */
  it("an oauth2 mailbox with no smtp row still gets a submission profile, sharing ONE token callback", async () => {
    const enc = await KP.encrypt("REFRESH-TOKEN");
    const rows: Row[] = [{
      transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: {
        host: "outlook.office365.com", port: 993, secure: true, user: "u@contoso-com.example",
        authType: "oauth2", provider: "microsoft", tenant: "common",
      },
    }];
    const tokenProvider: OAuthTokenProvider = { forMailbox: () => () => async () => "ACCESS-TOKEN" };

    const creds = await loadMailboxCreds(fakeDb(rows), "mbx-10", KP, tokenProvider);

    expect(creds!.smtp, "an oauth mailbox reported no submission endpoint").toBeDefined();
    // Exchange Online's submission endpoint on the STARTTLS port — `oauthSmtpEndpoint`'s defaults,
    // shared with the API's send adapter so the two cannot drift about a port.
    expect(creds!.smtp).toMatchObject({ host: "smtp.office365.com", port: 587, secure: false });
    expect(creds!.smtp!.auth).toBe(creds!.imap.auth);
    expect("pass" in creds!.smtp!.auth).toBe(false);
  });

  it("…and honours the submission block the credential names", async () => {
    const enc = await KP.encrypt("REFRESH-TOKEN");
    const rows: Row[] = [{
      transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: {
        host: "outlook.office365.com", port: 993, secure: true, user: "u@contoso-com.example",
        authType: "oauth2", provider: "microsoft", tenant: "common",
        smtp: { host: "smtp.contoso.example", port: 2525, secure: true },
      },
    }];
    const creds = await loadMailboxCreds(
      fakeDb(rows), "mbx-11", KP, { forMailbox: () => () => async () => "T" },
    );
    expect(creds!.smtp).toMatchObject({ host: "smtp.contoso.example", port: 2525, secure: true });
  });

  it("a PASSWORD mailbox with no smtp row still reports none — the fallback is the API's, not this boundary's", async () => {
    // The narrowing that keeps this change to oauth rows. A generic-IMAP mailbox that shares one
    // password across transports is resolved by whoever dials (the send adapter and the API's probe
    // both fall back to the imap host and secret); inventing a profile here would give the worker's
    // adapter an SMTP block nobody asked for.
    const enc = await KP.encrypt("pw");
    const rows: Row[] = [{
      transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "imap.example.net", port: 993, secure: true, user: "u@example.net" },
    }];
    const creds = await loadMailboxCreds(fakeDb(rows), "mbx-12", KP);
    expect(creds!.smtp).toBeUndefined();
  });
});
