import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../src/adapters/imap.js";
import { SendNotSubmitted, SentCopyAppendFailed, submissionNeverOffered } from "../src/send.js";

/**
 * A SUBMISSION THAT NEVER GOT PAST SECURING OR LOGIN IS A DEFINITE NON-DELIVERY.
 *
 * nodemailer raises `ETLS` only while STARTTLS is asked for or the upgrade runs, and `EAUTH` only
 * during login; the phone's transport stamps `tlsFailed` on an error before its handshake is
 * confirmed. Each of those proves no envelope was offered, so `ImapAdapter.send` says so by type.
 * Before, every one of them read as an ambiguous SMTP throw and the send ended "couldn't confirm".
 * A timeout, a reset or a close proves nothing about the envelope and stays ambiguous.
 */

const fail = (code: string | undefined, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("smtp"), code ? { code } : {}, extra);

describe("which submission errors prove nothing was offered", () => {
  it("names the step for the three that do", () => {
    expect(submissionNeverOffered(fail("ETLS"))).toBe("secure");
    expect(submissionNeverOffered(fail("ESOCKET", { tlsFailed: true }))).toBe("secure");
    expect(submissionNeverOffered(fail("EAUTH"))).toBe("login");
  });

  it("proves nothing for everything else", () => {
    for (const code of ["ETIMEDOUT", "ECONNECTION", "ESOCKET", "EENVELOPE", "EMESSAGE", undefined]) {
      expect(submissionNeverOffered(fail(code))).toBeNull();
    }
    expect(submissionNeverOffered(null)).toBeNull();
    expect(submissionNeverOffered("ETLS")).toBeNull();
  });
});

describe("ImapAdapter.send over a submission that never offered the message", () => {
  const adapterFailing = (err: Error) => {
    const adapter = new ImapAdapter({
      host: "example.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" },
      smtp: { host: "example.invalid", port: 587, secure: false, auth: { user: "u", pass: "p" } },
    });
    (adapter as unknown as { transporter: unknown }).transporter = {
      sendMail: async () => { throw err; }, close() { /* nothing */ },
    };
    return adapter;
  };
  const send = (a: ImapAdapter) =>
    a.send({ from: "u@example.test", to: "b@example.test", subject: "s", text: "t" }).then(() => "resolved", (e: unknown) => e);

  it("throws SendNotSubmitted with the step, carrying the client's own error", async () => {
    const tlsErr = fail("ETLS");
    const secured = await send(adapterFailing(tlsErr));
    expect(secured).toBeInstanceOf(SendNotSubmitted);
    expect((secured as SendNotSubmitted).step).toBe("secure");
    expect((secured as { cause?: unknown }).cause).toBe(tlsErr);
    // Every reader that classifies by code or message reads what it read before the wrap.
    expect((secured as SendNotSubmitted).code).toBe("ETLS");
    expect((secured as Error).message).toBe(tlsErr.message);

    const login = await send(adapterFailing(fail("EAUTH")));
    expect(login).toBeInstanceOf(SendNotSubmitted);
    expect((login as SendNotSubmitted).step).toBe("login");
  });

  it("the ambiguous control: a timeout reaches the caller unchanged", async () => {
    const timeout = fail("ETIMEDOUT");
    const out = await send(adapterFailing(timeout));
    expect(out).toBe(timeout);
    expect(out).not.toBeInstanceOf(SendNotSubmitted);
    expect(out).not.toBeInstanceOf(SentCopyAppendFailed);
  });
});

describe("a submission whose socket never connected is `connect`", () => {
  it("reads DNS, the socket's own connect and the two deadlines before the greeting", () => {
    expect(submissionNeverOffered(fail("EDNS", { syscall: "getaddrinfo" }))).toBe("connect");
    expect(submissionNeverOffered(fail("ESOCKET", { syscall: "connect" }))).toBe("connect");
    expect(submissionNeverOffered(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }))).toBe("connect");
    expect(submissionNeverOffered(Object.assign(new Error("Greeting never received"), { code: "ETIMEDOUT" }))).toBe("connect");
  });

  it("CONTROL: a socket error or a timeout after the greeting proves nothing", () => {
    expect(submissionNeverOffered(fail("ESOCKET", { syscall: "read" }))).toBeNull();
    expect(submissionNeverOffered(Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" }))).toBeNull();
    expect(submissionNeverOffered(Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" }))).toBeNull();
  });

  /* Over real sockets and the pinned nodemailer: the strings and fields the arm reads are its own. */
  const realSend = async (port: number) => {
    const fakeImap = {
      list: async () => [{ path: "INBOX", delimiter: "/", flags: new Set<string>() }],
      on: () => undefined, logout: async () => undefined, close: () => undefined,
    };
    const a = new ImapAdapter({
      host: "127.0.0.1", port: 1, secure: false, auth: { user: "u", pass: "p" },
      smtp: { host: "127.0.0.1", port, secure: false, auth: { user: "u", pass: "p" } },
      timeouts: { connectionMs: 500, greetingMs: 500, socketMs: 2_000 },
    }, { client: fakeImap as never });
    await a.connect();
    return a.send({ from: "u@example.test", to: "b@example.test", subject: "s", text: "t" })
      .then(() => "resolved", (e: unknown) => e);
  };

  it("a refused port and a server that never greets both throw SendNotSubmitted('connect')", async () => {
    const net = await import("node:net");
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const refused = await realSend(closedPort);
    expect(refused).toBeInstanceOf(SendNotSubmitted);
    expect((refused as SendNotSubmitted).step).toBe("connect");

    const held: import("node:net").Socket[] = [];
    const silent = net.createServer((s) => { held.push(s); });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    try {
      const unanswered = await realSend((silent.address() as { port: number }).port);
      expect(unanswered).toBeInstanceOf(SendNotSubmitted);
      expect((unanswered as SendNotSubmitted).step).toBe("connect");
    } finally {
      for (const s of held) s.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });
});
