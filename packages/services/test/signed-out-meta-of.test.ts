import { describe, expect, it } from "vitest";
import { signedOutMetaOf, signedOutTransportMeta } from "../src/signed-out-fence.js";

/**
 * The one value a sign-out writes into `mailboxes.signed_out_meta` (mail 0127) is built by
 * allow-list: host, port, secure and user per transport, each only in its own type. A password,
 * a secret, a consent marker or a key nobody has named yet never survives it, in either direction.
 */
describe("signedOutMetaOf keeps where a mailbox lives and nothing else", () => {
  const imap = {
    host: "imap.example.test", port: 993, secure: true, user: "me@example.test",
    pass: "a-password", secretEnc: "ciphertext", insecureConsent: true, smtpHost: "smtp.example.test",
    authType: "oauth2", someKeyAddedLater: "x",
  };

  it("keeps the four coordinates per transport and drops every other key", () => {
    expect(signedOutMetaOf([
      { transport: "imap", meta: imap },
      { transport: "smtp", meta: { host: "smtp.example.test", port: 465, secure: true, user: "me@example.test", pass: "p" } },
      { transport: "graph", meta: { host: "graph.example.test", token: "t" } },
    ])).toEqual({
      imap: { host: "imap.example.test", port: 993, secure: true, user: "me@example.test" },
      smtp: { host: "smtp.example.test", port: 465, secure: true, user: "me@example.test" },
    });
  });

  it("a coordinate in the wrong type is dropped, and a row naming no server keeps nothing", () => {
    expect(signedOutMetaOf([{ transport: "imap", meta: { host: "h", port: "993", secure: "yes", user: 7 } }]))
      .toEqual({ imap: { host: "h" } });
    expect(signedOutMetaOf([{ transport: "imap", meta: { port: 993, user: "u" } }])).toBeNull();
    expect(signedOutMetaOf([{ transport: "imap", meta: null }])).toBeNull();
    expect(signedOutMetaOf([])).toBeNull();
  });

  it("the reader re-applies the allow-list, so a column written any other way leaks nothing", () => {
    const column = { imap: { ...imap }, smtp: "not an object" };
    expect(signedOutTransportMeta(column, "imap"))
      .toEqual({ host: "imap.example.test", port: 993, secure: true, user: "me@example.test" });
    expect(signedOutTransportMeta(column, "smtp")).toBeNull();
    expect(signedOutTransportMeta(null, "imap")).toBeNull();
    expect(signedOutTransportMeta("text", "imap")).toBeNull();
  });
});
