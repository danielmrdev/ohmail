import { describe, expect, it } from "vitest";
import { StaticKeyProvider } from "@trafficflow/core";
import type { HostResolver } from "@trafficflow/core/net";
import { checkedDial, dialHostGuardFromEnv, makeDialHostGuard } from "../src/dial-host-guard.js";
import { classifyMailboxError, loadMailboxCreds, mailboxErrorDetail } from "../src/mailboxes.js";

/**
 * THE ORGANIZER'S DIAL DOOR DECIDES WHAT THE API'S DOOR DECIDES about the same stored row: the
 * host, the address it pins, and the port. The organizer checked no port, so a stored port that
 * carries no mail was refused at send and at attachment fetch and dialled by the sync. Its other
 * two departures are read here too: an unresolved name lost the socket's own code, so the row
 * read "could not tell why", and the pin was not bounded.
 */

const PUBLIC = "93.184.216.34";
const HOST = "mail.example.test";

function resolverOf(answer: string[] | Error): HostResolver & { asked: () => number } {
  let asked = 0;
  return {
    asked: () => asked,
    resolve: async () => {
      asked += 1;
      if (answer instanceof Error) throw answer;
      return [...answer];
    },
  };
}

const refusalOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

describe("the organizer's dial takes the port rule", () => {
  it("a stored incoming port that carries no mail is refused before any dial", async () => {
    const err = await refusalOf(checkedDial(makeDialHostGuard(resolverOf([PUBLIC])), HOST, 8080, "imap", { secure: true }));
    expect(err, "the organizer dialled a port the API's door refuses").not.toBeNull();
    expect((err as { code?: unknown }).code).toBe("MAILBOX_PORT_REFUSED");
    expect(classifyMailboxError(err, "attach")).toBe("connect");
    expect(mailboxErrorDetail(err), "the row must be able to say which refusal it was").toBe("MAILBOX_PORT_REFUSED");
  });

  it("the outgoing leg is ruled by the submission ports", async () => {
    const guard = makeDialHostGuard(resolverOf([PUBLIC]));
    const err = await refusalOf(checkedDial(guard, HOST, 2525, "smtp", { secure: false }));
    expect((err as { code?: unknown } | null)?.code).toBe("MAILBOX_PORT_REFUSED");
    await expect(checkedDial(guard, HOST, 587, "smtp", { secure: false })).resolves.toEqual({ pin: [PUBLIC] });
  });

  it("CONTROL: every mail port is admitted under the managed policy", async () => {
    const guard = makeDialHostGuard(resolverOf([PUBLIC]));
    for (const port of [143, 993]) {
      await expect(checkedDial(guard, HOST, port, "imap", { secure: port === 993 })).resolves.toEqual({ pin: [PUBLIC] });
    }
    for (const port of [25, 465, 587]) {
      await expect(checkedDial(guard, HOST, port, "smtp", { secure: port === 465 })).resolves.toEqual({ pin: [PUBLIC] });
    }
  });

  it("CONTROL: the self-host policy admits any port, because a LAN mail server may use its own", async () => {
    const guard = dialHostGuardFromEnv({ TF_PROBE_ALLOW_PRIVATE: "1" } as NodeJS.ProcessEnv, resolverOf([PUBLIC]));
    await expect(checkedDial(guard, HOST, 8080, "imap", { secure: true })).resolves.toEqual({});
  });
});

describe("a name the deployment cannot resolve keeps the socket's own code", () => {
  it("the row says the server is not available, never that nobody could tell why", async () => {
    const err = await refusalOf(checkedDial(makeDialHostGuard(resolverOf(new Error("EAI_AGAIN"))), HOST, 993, "imap", { secure: true }));
    expect((err as { code?: unknown } | null)?.code).toBe("ENOTFOUND");
    expect(classifyMailboxError(err, "attach")).toBe("connect");
    expect(mailboxErrorDetail(err)).toBe("ENOTFOUND");
  });
});

describe("the pin is bounded as the API's is", () => {
  it("a name answering forty public addresses pins at most sixteen of them", async () => {
    const forty = Array.from({ length: 40 }, (_, i) => `93.184.216.${i + 1}`);
    const got = await checkedDial(makeDialHostGuard(resolverOf(forty)), HOST, 993, "imap", { secure: true });
    expect(got.pin?.length).toBe(16);
    expect(got.pin).toEqual(forty.slice(0, 16));
  });
});

/**
 * A STORED PORT WRITTEN AS DIGITS IS THE PORT IT NAMES. A row written before the create path validated
 * its body can hold `"993"`, which the organizer dialled as 993; read as text, the port rule would
 * call it a port that carries no mail and stop the mailbox receiving. Through the real credential read.
 */
describe("a stored port written as digits is the port it names", () => {
  const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
  const credsWith = async (port: unknown) => {
    const enc = await KP.encrypt("fixture");
    const rows = [{ transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: HOST, port, secure: true, user: "u" } }];
    const db = { select: () => ({ from: () => ({ where: async () => rows }) }) } as unknown as Parameters<typeof loadMailboxCreds>[0];
    return (await loadMailboxCreds(db, "mb-port", KP))!;
  };

  it("a stored \"993\" dials 993 under the managed policy", async () => {
    const creds = await credsWith("993");
    expect(creds.imap.port, "the stored digits were not read as the port").toBe(993);
    await expect(checkedDial(makeDialHostGuard(resolverOf([PUBLIC])), HOST, creds.imap.port, "imap", creds.imap))
      .resolves.toEqual({ pin: [PUBLIC] });
  });

  it("CONTROL: a stored \"abc\" is still refused, and a number is untouched", async () => {
    const bad = await credsWith("abc");
    const err = await refusalOf(checkedDial(makeDialHostGuard(resolverOf([PUBLIC])), HOST, bad.imap.port, "imap", bad.imap));
    expect((err as { code?: unknown } | null)?.code).toBe("MAILBOX_PORT_REFUSED");
    expect((await credsWith(143)).imap.port).toBe(143);
  });
});
