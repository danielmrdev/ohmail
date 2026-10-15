import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDataDir } from "./_datadir.js";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { connectOverStdio } from "../src/client.js";
import { DataDirLockedError } from "../src/db.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { encodeFrame, PROTOCOL_VERSION } from "../src/frame.js";
import { serveOverStdio } from "../src/host.js";
import { createSidecarLog, describeMethod, describeRoute } from "../src/log.js";

/**
 * THE SIDECAR EMITS THROUGH THE HARDENED LOGGER.
 *
 * `apps/sidecar` used to hand-roll its own sink, one `JSON.stringify` over an arbitrary
 * `Record<string, unknown>`, under a comment claiming it was "the same shape the worker's logger
 * emits". The shape was; the controls were not. (composite secret names survive an
 * exact-name denylist) and (the string channels `sanitize` never saw) were fixed in
 * `packages/core/src/log.ts` and left standing in a second implementation.
 *
 * ── WHAT THESE ASSERTIONS ARE MADE OF ─────────────────────────────────────────────────────
 *
 * The same rule as core's own logger test: the assertion of record is on the exact bytes
 * handed to the sink, because `emit()` swallows every exception and a redaction bug is therefore
 * silent. And EVERY case here also asserts that a SAFE field survived. A test that only checks
 * `not.toContain(secret)` passes against an empty log line, an exception, and a logger that was
 * never called — which is three ways to be green while emitting nothing at all.
 */

const SECRETS = {
  /** What an ImapFlow login failure quotes back. */
  imapPass: "app-password-9f3a",
  address: "mila@example.test",
  /** What a Postgres driver quotes. */
  pgUser: "neondb_owner",
} as const;

function capture(): { lines: string[]; log: ReturnType<typeof createSidecarLog>; text: () => string } {
  const lines: string[] = [];
  return {
    lines,
    log: createSidecarLog({ sink: (l) => { lines.push(l); } }),
    text: () => lines.join("\n"),
  };
}

/** One line, parsed. */
function emitted(event: string, detail: Record<string, unknown>): { line: string; parsed: Record<string, unknown> } {
  const c = capture();
  c.log(event, detail);
  return { line: c.lines[0]!, parsed: JSON.parse(c.lines[0]!) as Record<string, unknown> };
}

describe("createSidecarLog — the line and where it goes", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("writes ONE JSON object per line to stderr, and nothing to stdout", () => {
    // stdout is the FRAME STREAM (see `main.ts`'s header). A log line written there lands inside a
    // length-prefixed frame, and there is no resync point — so this is not a stylistic preference,
    // it is the difference between a bridge and a dead connection.
    const toStderr: string[] = [];
    const toStdout: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { toStderr.push(String(chunk)); return true; });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { toStdout.push(String(chunk)); return true; });

    createSidecarLog()("serving", { mailboxId: "mb-9" });

    expect(toStderr).toHaveLength(1);
    expect(toStderr[0]!.endsWith("\n")).toBe(true);
    expect(toStderr[0]!.trimEnd()).not.toContain("\n");
    expect(toStdout.join("")).not.toContain("\"service\":\"sidecar\"");
    const parsed = JSON.parse(toStderr[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "info", service: "sidecar", event: "serving", mailboxId: "mb-9" });
    expect(typeof parsed.ts).toBe("string");
  });

  it("gates unknown fields by NAME and says so — `dataDir` is the one that was on `serving`", () => {
    // `serving` used to carry `dataDir`, a path under the user's home carrying the OS account
    // name. It is gone from the call site, and the allowlist is why re-adding it cannot be quiet.
    const { parsed } = emitted("serving", { mailboxId: "mb-9", dataDir: "/Users/mila/Library/ohmail" });
    expect(parsed.mailboxId).toBe("mb-9");
    expect(parsed.dataDir).toBeUndefined();
    expect(parsed.droppedFields).toEqual(["dataDir"]);
  });

  it("derives the level from the event name, because the seam has no room for one", () => {
    // `readMailboxLease` takes `(event, detail) => void`; a third parameter would make this
    // function unassignable there. Both branches, and the two names that read the wrong way round.
    for (const event of ["shutdown_failed", "start_failed", "transport_fatal", "frame_stream_fatal",
      "request_failed", "sync_cycle_failed", "adapter_close_failed", "mailbox_start_failed",
      "organizer_stand_down_write_failed", "start_lease_unavailable", "lease_release_failed"]) {
      expect(emitted(event, {}).parsed.level, event).toBe("error");
    }
    // A stand-down is an ORDINARY outcome of the lease, not a fault — §4 makes it the correct
    // behaviour of the losing install. `install_key_absent` is a stated condition, not a failure.
    for (const event of ["shutdown", "serving", "install_key_absent", "organizer_stand_down",
      "stale_sessions_revoked", "input_ended_mid_frame", "lease_stand_down"]) {
      expect(emitted(event, {}).parsed.level, event).toBe("info");
    }
  });
});

describe("the eight `err` call sites reduce to class + code", () => {
  it("an ImapFlow login failure: not one byte of the command, and the class survives", () => {
    // What a real failure quotes. `imapflow` puts the failing command in the message, which on a
    // login path is the credential — `log.ts`'s header records the same accident reaching a hosted
    // log drain from `apps/api-vercel`.
    const err = Object.assign(
      new Error(`Authentication failed: LOGIN "${SECRETS.address}" "${SECRETS.imapPass}"`),
      { code: "AUTHENTICATIONFAILED" },
    );
    const { line, parsed } = emitted("adapter_close_failed", { err, mailboxId: "mb-9" });

    expect(line).not.toContain(SECRETS.imapPass);
    expect(line).not.toContain(SECRETS.address);
    expect(line).not.toContain("LOGIN");
    // …and the line is still worth having: the class, the code, the level and the correlation id.
    expect(parsed.errorClass).toBe("Error");
    expect(parsed.errorCode).toBe("AUTHENTICATIONFAILED");
    expect(parsed.mailboxId).toBe("mb-9");
    expect(parsed.level).toBe("error");
    expect(parsed.event).toBe("adapter_close_failed");
  });

  it("a Postgres error: the SQLSTATE survives, `password authentication failed for user` does not", () => {
    const err = Object.assign(new Error(`password authentication failed for user "${SECRETS.pgUser}"`), { code: "28P01" });
    const { line, parsed } = emitted("organizer_stand_down_write_failed", {
      err,
      reason: "this install has stopped organizing regardless; the row could not record why",
    });
    expect(line).not.toContain(SECRETS.pgUser);
    expect(line).not.toContain("password authentication");
    expect(parsed.errorCode).toBe("28P01");
    expect(parsed.reason).toContain("stopped organizing regardless");
  });

  it("an error's own ENUMERABLE properties do not leak either — DataDirLockedError", () => {
    // The reason `err` is passed whole rather than reduced at the call site is that `err` is a
    // logger-OWNED slot: `emit` hands it to `describeError`, which reads `name` and `code` and
    // nothing else. `DataDirLockedError` carries `dataDir` and `holder` as enumerable own fields,
    // so a sink that walked the object would publish the user's home directory and a pid.
    const err = new DataDirLockedError("/Users/mila/Library/Application Support/ohmail", "pid 41234");
    const { line, parsed } = emitted("start_failed", { err });
    expect(line).not.toContain("/Users/mila");
    expect(line).not.toContain("41234");
    expect(parsed.errorClass).toBe("DataDirLockedError");
  });

  it("a LeaseUnavailableError's `cause` is not walked, and the class is the exemption's own name", () => {
    // `engine.ts`'s `start()` exempts this error BY CLASS. The wrapped cause is an IMAP failure.
    const cause = new Error(`SELECT "ohmail/_meta" failed for ${SECRETS.address}`);
    const err = Object.assign(new Error("the organizer claim in ohmail/_meta could not be read", { cause }), {
      name: "LeaseUnavailableError",
    });
    const { line, parsed } = emitted("start_lease_unavailable", { err, reason: "the mirror is served" });
    expect(line).not.toContain(SECRETS.address);
    expect(line).not.toContain("could not be read");
    expect(parsed.errorClass).toBe("LeaseUnavailableError");
    expect(parsed.reason).toBe("the mirror is served");
  });

  /**
   * THE STAND-DOWN'S OWN LINE, both thrown shapes — the row this pair closes.
   *
   * `organizer_stand_down_write_failed` was read on a phone as `err: {}`: a raw `JSON.stringify`
   * of the detail object, which is what an app composing its own sink produces, since every
   * `Error` property is non-enumerable. The phone hands ONE SINK and the engine builds this logger
   * over it, so `err` is the logger's slot and never reaches the payload — but "never reaches the
   * payload" is only worth having if what replaces it NAMES the failure, so both halves are
   * asserted here at the event the row was filed against.
   */
  it("the stand-down's failure names class AND code, and `err` never reaches the payload", () => {
    /* The real shape, measured: `node:sqlite` throws an `Error` whose `code` is `ERR_SQLITE_ERROR`
       and whose message is the diagnosis (`unrecognized token: ":"`). The class and the code are
       what this logger publishes; the message is driver-written and stays discarded — see the
       file header in `packages/core/src/log.ts` and the two cases above, which measure what
       admitting it would publish (a database role, a person's home directory, a pid). */
    const err = Object.assign(new Error('unrecognized token: ":"'), { code: "ERR_SQLITE_ERROR" });
    const { parsed } = emitted("organizer_stand_down_write_failed", {
      mailboxId: "9f4c1e2a-7b31-4d55-8a0e-2c6f9b1d3e77",
      err,
      reason: "neither the demotion nor the handover was recorded",
    });
    expect(parsed.errorClass).toBe("Error");
    expect(parsed.errorCode).toBe("ERR_SQLITE_ERROR");
    /* THE EMPTY OBJECT THE ROW NAMED. `err` is consumed by `emit`, so a line carrying the key at
       all is a line rendered by something that is not this logger. */
    expect(Object.keys(parsed), "`err` survived into the payload").not.toContain("err");
    expect(parsed.mailboxId, "the line lost the mailbox it is about")
      .toBe("9f4c1e2a-7b31-4d55-8a0e-2c6f9b1d3e77");
  });

  it("a STRING thrown at the same site is logged by VALUE, which is its whole diagnosis", () => {
    /* The other half of the row: a thrown primitive has no `message`, so the value IS the
       diagnosis. It takes the value scrubber and the length bound, like every allowlisted string. */
    const { parsed } = emitted("organizer_stand_down_write_failed", {
      mailboxId: "9f4c1e2a-7b31-4d55-8a0e-2c6f9b1d3e77",
      err: "no such column: organizer_state",
      reason: "neither the demotion nor the handover was recorded",
    });
    expect(parsed.errorClass).toBe("String");
    expect(parsed.errorText).toBe("no such column: organizer_state");
    expect(Object.keys(parsed)).not.toContain("err");
  });

  it("a thrown STRING still reduces to `errorClass: \"String\"`, its address masked", () => {
    const { line, parsed } = emitted("lease_release_failed", { err: `EXPUNGE failed for ${SECRETS.address}` });
    expect(line).not.toContain(SECRETS.address);
    expect(parsed.errorClass).toBe("String");
  });

  it("the organizer-lease path hands the Error whole, and the line names no mail server", () => {
    // `organizer-lease.ts` and `organizer-profile.ts` pass the caught error, not its message: an
    // IMAP error's text can carry the server's name, and only an Error is reduced to class and code.
    const host = "imap.server-name.example";
    const err = Object.assign(new Error(`EXPUNGE failed: connection to ${host}:993 reset`), { code: "ECONNRESET" });
    const { line, parsed } = emitted("lease_release_failed", { op: "remove_claims", err });
    expect(line).not.toContain(host);
    expect([parsed.errorClass, parsed.errorCode]).toEqual(["Error", "ECONNRESET"]);
  });
});

describe("describeMethod / describeRoute — the two transport-supplied strings", () => {
  it("keeps a real route and DROPS the query string, which is where mail arrives", () => {
    // `/search?q=…` carries the search terms. On this product those are mail, which the privacy invariants cover.
    expect(describeRoute("http://sidecar/search?q=Re%3A%20Q3%20payroll")).toBe("/search");
    expect(describeRoute("http://sidecar/threads/9f4c1e2a-7b31-4d55-8a0e-2c6f9b1d3e77/notes"))
      .toBe("/threads/9f4c1e2a-7b31-4d55-8a0e-2c6f9b1d3e77/notes");
    expect(describeRoute("http://sidecar/messages/mb-1/attachments/download-all"))
      .toBe("/messages/mb-1/attachments/download-all");
    // A relative URL never reaches `new Request`, but it can reach the failure path.
    expect(describeRoute("/sync?since=1")).toBe("/sync");
  });

  it("refuses a path carrying content, and everything that is not a string", () => {
    // Percent-encoding is what content in a path looks like, and `%` is not in the grammar.
    expect(describeRoute("http://sidecar/messages/Re%3A%20Q3%20payroll")).toBe("[invalid]");
    expect(describeRoute(`http://sidecar/x/${encodeURIComponent(SECRETS.address)}`)).toBe("[invalid]");
    expect(describeRoute(`http://sidecar/${"a".repeat(200)}`)).toBe("[invalid]");
    expect(describeRoute(undefined)).toBe("[invalid]");
    expect(describeRoute(42)).toBe("[invalid]");
  });

  it("holds the method to a token, because `request_failed` fires BEFORE `new Request` validates it", () => {
    expect(describeMethod("GET")).toBe("GET");
    expect(describeMethod("post")).toBe("POST");
    expect(describeMethod("OPTIONS")).toBe("OPTIONS");
    expect(describeMethod("GET /admin HTTP/1.1")).toBe("[invalid]");
    expect(describeMethod(`LOGIN "${SECRETS.imapPass}"`)).toBe("[invalid]");
    expect(describeMethod(7)).toBe("[invalid]");
  });
});

describe("end to end — a handler that throws, over the real frame codec", () => {
  it("the log line carries class, code, route and requestId; the message goes only to the parent", async () => {
    const c = capture();
    const toHost = new PassThrough({ highWaterMark: 1024 });
    const toClient = new PassThrough({ highWaterMark: 1024 });
    const host = serveOverStdio({
      handle: () => {
        throw Object.assign(
          new Error(`IMAP LOGIN failed: user=${SECRETS.address} pass=${SECRETS.imapPass}`),
          { code: "AUTHENTICATIONFAILED" },
        );
      },
      input: toHost,
      output: toClient,
      log: c.log,
    });
    const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
    try {
      // A query string that is mail, on the route that takes one.
      await expect(client.fetch("/search?q=Re%3A%20Q3%20payroll")).rejects.toThrow(/sidecar_failed/);

      const failed = c.lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.event === "request_failed");
      expect(failed, "no request_failed line was emitted at all").toBeDefined();
      // The refusals.
      expect(c.text()).not.toContain(SECRETS.imapPass);
      expect(c.text()).not.toContain(SECRETS.address);
      expect(c.text()).not.toContain("Q3");
      expect(c.text()).not.toContain("payroll");
      // The line is still a diagnostic: every field an operator needs is present, and NOTHING was
      // dropped — which is what makes the census guard and this test agree.
      expect(failed!.route).toBe("/search");
      expect(failed!.method).toBe("GET");
      expect(failed!.errorClass).toBe("Error");
      expect(failed!.errorCode).toBe("AUTHENTICATIONFAILED");
      expect(typeof failed!.requestId).toBe("number");
      expect(failed!.level).toBe("error");
      expect(failed!.droppedFields).toBeUndefined();
    } finally {
      client.close();
      host.stop();
    }
  });

  it("a raw frame's method and path are held to a grammar — the path `new Request` never validates", async () => {
    // `request_failed` is logged from a `catch` that INCLUDES `decodeRequest` throwing, so
    // `header.method` reaches the log without having been through `new Request`'s token check.
    // A client cannot produce this shape (its own `new Request` throws first), which is why this
    // writes the frame by hand — and it is not hypothetical: Node's TypeError for a bad method
    // quotes the method back, so the message that would be logged verbatim IS the credential.
    const c = capture();
    const toHost = new PassThrough({ highWaterMark: 1024 });
    const toClient = new PassThrough({ highWaterMark: 1024 });
    const host = serveOverStdio({
      handle: async () => Response.json({ ok: true }),
      input: toHost,
      output: toClient,
      log: c.log,
    });
    try {
      toHost.write(encodeFrame({
        v: PROTOCOL_VERSION,
        t: "req",
        id: 7,
        method: `LOGIN "${SECRETS.imapPass}"`,
        url: `http://sidecar/messages/${encodeURIComponent("Re: Q3 payroll")}`,
        h: [],
      }));
      await vi.waitFor(() => {
        expect(c.lines.some((l) => l.includes("request_failed"))).toBe(true);
      });

      const failed = JSON.parse(c.lines.find((l) => l.includes("request_failed"))!) as Record<string, unknown>;
      expect(failed.method).toBe("[invalid]");
      expect(failed.route).toBe("[invalid]");
      expect(failed.requestId).toBe(7);
      expect(failed.errorClass).toBe("TypeError");
      expect(c.text()).not.toContain(SECRETS.imapPass);
      expect(c.text()).not.toContain("LOGIN");
      expect(c.text()).not.toContain("Q3");
      expect(c.text()).not.toContain("payroll");
    } finally {
      host.stop();
    }
  });
});

describe("install_key_absent — the event that used to be called `ephemeral_kek`", () => {
  const dirs: string[] = [];
  const started: Sidecar[] = [];
  afterEach(async () => {
    for (const s of started.splice(0)) await s.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("names the variable that was not set, and no key reaches the log", async () => {
    // Assembly only — no IMAP connection is opened, so this needs no server. `createSidecar` is
    // where the absence is decided, which makes this the one place the real call site can be
    // observed rather than imitated.
    const dir = await freshDataDir("ohmail-sidecar-log-");
    dirs.push(dir);
    const c = capture();
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: SECRETS.address, pass: SECRETS.imapPass } },
      log: c.log,
      adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    });
    started.push(sidecar);

    const line = c.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === "install_key_absent");
    expect(line, "createSidecar emitted no install_key_absent line").toBeDefined();
    expect(line!.configVar).toBe("OHMAIL_KEK");
    // The line has to say what the absence COSTS, and the cost changed when credentials became
    // persistable: it used to be "a key was generated for this launch", and the honest sentence
    // now is that nothing is stored at all. Pinned on both halves of that claim rather than on a
    // single phrase, so a future edit cannot quietly reduce it back to a reassurance.
    expect(line!.reason).toContain("not written down");
    expect(line!.reason).toContain("refused");
    expect(line!.droppedFields).toBeUndefined();

    // The name is gone, and so is any shape a 32-byte key could take. `crypto.ts` has no forward
    // secrecy, so one KEK on one line retroactively decrypts everything wrapped under it.
    expect(c.text()).not.toContain("ephemeral_kek");
    expect(c.text()).not.toContain(SECRETS.imapPass);
    expect(c.text()).not.toMatch(/[0-9a-f]{40,}/i);
    expect(c.text()).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  }, 180_000);
});
