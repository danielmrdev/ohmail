import { describe, it, expect } from "vitest";
import { MailboxSideRefusal, type HostResolver } from "@trafficflow/services/mail";
import { makeProbeHostGuard } from "../src/imap-probe.js";
import { clearedFor } from "../src/dial-host-guard.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * A STORED PORT THAT CARRIES NO MAIL IS REFUSED AT THE DIAL, AND THE SENTENCE SAYS WHICH. The add
 * form's probe has always told the person the port and the ports on offer; the send and attachment
 * doors mapped the same guard refusal to "an address this service will not connect to", which
 * names neither the port nor the fix. The refusal stays terminal: the port is the person's to change.
 */

const PUBLIC = "93.184.216.34";
const resolverTo = (addresses: string[]): HostResolver => ({ resolve: async () => addresses });
const depsWith = (resolver: HostResolver): ApiDeps =>
  ({ services: { probeHostGuard: makeProbeHostGuard(resolver) } }) as unknown as ApiDeps;

async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (err) {
    return err;
  }
}

describe("the dial door says a stored non-mail port by name", () => {
  it("an incoming port outside the mail set names the port, the ports and where to change it", async () => {
    const err = await refusalOf(() => clearedFor(depsWith(resolverTo([PUBLIC])), "imap.example.com", 8080, "imap"));
    expect(err).toBeInstanceOf(MailboxSideRefusal);
    expect((err as MailboxSideRefusal).code).toBe("mailbox_port_refused");
    expect((err as Error).message).toBe(
      "This mailbox's incoming (IMAP) server is set to port 8080, which does not carry mail. "
        + "Change the port in Settings → Mailboxes (143 or 993).",
    );
  });

  it("the outgoing leg names its own ports", async () => {
    const err = await refusalOf(() => clearedFor(depsWith(resolverTo([PUBLIC])), "smtp.example.com", 2525, "smtp"));
    expect((err as MailboxSideRefusal).code).toBe("mailbox_port_refused");
    expect((err as Error).message).toBe(
      "This mailbox's outgoing (SMTP) server is set to port 2525, which does not carry mail. "
        + "Change the port in Settings → Mailboxes (25, 465 or 587).",
    );
  });

  it("CONTROL: an address this service will not connect to keeps its own sentence", async () => {
    const err = await refusalOf(() => clearedFor(depsWith(resolverTo(["10.0.0.5"])), "imap.example.com", 993, "imap"));
    expect((err as MailboxSideRefusal).code).toBe("mailbox_host_refused");
    expect((err as Error).message).toContain("an address that is not one this service will connect to");
  });

  it("CONTROL: a mail port on a public address is cleared", async () => {
    const pin = await clearedFor(depsWith(resolverTo([PUBLIC])), "imap.example.com", 993, "imap");
    expect(pin).toEqual([PUBLIC]);
  });

  it("the add form's probe keeps its own sentence and carries the port as fields", async () => {
    const err = await refusalOf(() => makeProbeHostGuard(resolverTo([PUBLIC])).check("imap.example.com", 8080, "imap"));
    expect((err as Error).message).toBe("Mail is not carried on port 8080. Use 143, 993.");
    expect((err as { details?: unknown }).details).toEqual({ port: 8080, ports: [143, 993] });
  });
});
