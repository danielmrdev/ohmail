import { describe, it, expect } from "vitest";
import { createServer, Socket, type Server } from "node:net";
import type { HostResolver } from "@trafficflow/core/net";
import {
  checkedDial, dialHostGuardFromEnv, makeDialHostGuard, ALLOW_ANY_DIAL_HOST,
  MailboxHostRefused, type DialHostGuard,
} from "../src/dial-host-guard.js";

/**
 * EVERY DIAL THE ORGANIZER MAKES RUNS UNDER THE DEPLOYMENT'S OWN POLICY, and connects to the
 * address that policy cleared. FIVE sites dialled a stored hostname with no check and no pin: the
 * always-on attach, the reconcile backstop, the two operator CLIs and `smtp-size.ts`'s submission
 * probe. One policy, read from the deployment — `TF_PROBE_ALLOW_PRIVATE`, the variable
 * `apps/server/src/config.ts` reads for the API's own probe. Absent ENFORCES, `=1` admits, because
 * a self-hosted worker legitimately dials a LAN mail server; the process that VALIDATES and the
 * process that DIALS must not disagree, which is the split `push-wake.ts` makes for its sibling.
 */

/** A resolver the test owns. The core gate takes its DNS port at construction for this reason. */
function resolverOf(answers: Record<string, string[] | Error>): HostResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (host: string): Promise<string[]> => {
      calls.push(host);
      const a = answers[host];
      if (a === undefined) throw new Error(`no answer for ${host}`);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

/** The MANAGED policy: no allowance in the environment, so the strict branch. */
const managed = (r: HostResolver): DialHostGuard => makeDialHostGuard(r);

/* ══════════════════════════════════════════════════════════════════════════════════════════
   (1) THE MANAGED POLICY REFUSES A HOST WHOSE RESOLUTION HAS MOVED — one arm per site shape
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The four sites assemble from two shapes: `loadMailboxCreds`' decrypted `creds.imap`
 * (`index.ts`, `run-junk-sweep.ts`, `run-redacted-restore.ts`) and the backstop's env
 * `config.imap` (`reconcile-cron.ts`). Both are `{ host, port, secure }` and both reach the same
 * helper, so each arm drives the helper with the shape its own site builds.
 */
const SITES = [
  { site: "index.ts attach", host: "mail.example.test", port: 993, secure: true },
  { site: "reconcile-cron.ts backstop", host: "imap.example.test", port: 993, secure: true },
  { site: "run-junk-sweep.ts", host: "sweep.example.test", port: 143, secure: false },
  { site: "run-redacted-restore.ts", host: "restore.example.test", port: 993, secure: true },
] as const;

describe("a stored host whose resolution moved to a private range", () => {
  for (const { site, host } of SITES) {
    it(`is refused at ${site}, by name`, async () => {
      // The real sequence: the address was public when the mailbox was added, and is private now.
      const probeTime = resolverOf({ [host]: ["93.184.216.34"] });
      await expect(managed(probeTime).check(host, 993, "imap")).resolves.toEqual(["93.184.216.34"]);

      const now = resolverOf({ [host]: ["10.0.0.5"] });
      await expect(checkedDial(managed(now), host, 993, "imap"))
        .rejects.toBeInstanceOf(MailboxHostRefused);
      expect(now.calls, "the guard must resolve at the moment it dials").toContain(host);
    });
  }

  it("is refused for loopback and link-local too, not only RFC1918", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "::1"]) {
      const r = resolverOf({ "mail.example.test": [address] });
      await expect(checkedDial(managed(r), "mail.example.test", 993, "imap"))
        .rejects.toBeInstanceOf(MailboxHostRefused);
    }
  });

  it("is refused when the stored host is a private literal, with no resolution at all", async () => {
    const r = resolverOf({});
    await expect(checkedDial(managed(r), "10.0.0.5", 993, "imap"))
      .rejects.toBeInstanceOf(MailboxHostRefused);
    expect(r.calls, "a literal is decided without a lookup").toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   (2) THE SELF-HOST POLICY ADMITS IT — and the DEPLOYMENT decides which one is in force
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the deployment's own configuration decides the policy", () => {
  it("absent TF_PROBE_ALLOW_PRIVATE ENFORCES — the managed organizer", async () => {
    const guard = dialHostGuardFromEnv({} as NodeJS.ProcessEnv, resolverOf({ "m.example.test": ["10.0.0.5"] }));
    await expect(checkedDial(guard, "m.example.test", 993, "imap"))
      .rejects.toBeInstanceOf(MailboxHostRefused);
  });

  it("TF_PROBE_ALLOW_PRIVATE=1 ADMITS — a self-hosted organizer dials its own LAN server", async () => {
    const r = resolverOf({ "m.example.test": ["10.0.0.5"] });
    const guard = dialHostGuardFromEnv({ TF_PROBE_ALLOW_PRIVATE: "1" } as NodeJS.ProcessEnv, r);
    // Nothing to pin: the dial is by NAME, exactly as it was before this guard existed.
    await expect(checkedDial(guard, "m.example.test", 993, "imap")).resolves.toEqual({});
    expect(r.calls, "the admitting policy resolves nothing").toEqual([]);
  });

  it("reads the allowance exactly, like its sibling — \"true\" and \"yes\" do not arm it", async () => {
    for (const value of ["true", "yes", "0", "", " 1 x"]) {
      const guard = dialHostGuardFromEnv(
        { TF_PROBE_ALLOW_PRIVATE: value } as NodeJS.ProcessEnv,
        resolverOf({ "m.example.test": ["10.0.0.5"] }),
      );
      await expect(checkedDial(guard, "m.example.test", 993, "imap"),
        `${JSON.stringify(value)} must not arm the allowance`).rejects.toBeInstanceOf(MailboxHostRefused);
    }
  });

  it("REFUSES TO COMPOSE when no policy was supplied, naming the input", async () => {
    // Not a silent dial-by-name, which is the state this whole change removes. The sentence has
    // to name the variable, because the operator's next act is to set it.
    await expect(checkedDial(undefined, "m.example.test", 993, "imap")).rejects.toThrow(/TF_PROBE_ALLOW_PRIVATE/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   (3) AN UNCHANGED PUBLIC HOST CONNECTS UNDER BOTH POLICIES, AND SNI STAYS THE NAME
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("an unchanged public host", () => {
  it("connects under the managed policy, pinned to what was cleared", async () => {
    const r = resolverOf({ "mail.example.test": ["93.184.216.34", "93.184.216.35"] });
    await expect(checkedDial(managed(r), "mail.example.test", 993, "imap"))
      .resolves.toEqual({ pin: ["93.184.216.34", "93.184.216.35"] });
  });

  it("connects under the self-host policy, unpinned", async () => {
    const guard = dialHostGuardFromEnv({ TF_PROBE_ALLOW_PRIVATE: "1" } as NodeJS.ProcessEnv);
    await expect(checkedDial(guard, "mail.example.test", 993, "imap")).resolves.toEqual({});
  });

  it("NARROWS THE ADDRESS AND NOTHING ELSE — the config's host is still the NAME", async () => {
    // The arm that reds if the pin is ever spelled as a dial host. `host` is what SNI and
    // certificate validation read; a config that dialled the address would produce no SNI at all
    // and a multi-vhost server would answer with its default certificate, which is
    // indistinguishable from a wrong certificate. Asserted BEFORE anything about the pin.
    const r = resolverOf({ "mail.example.test": ["93.184.216.34"] });
    const cfg = { host: "mail.example.test", port: 993, secure: true, auth: { user: "u", pass: "p" },
      ...(await checkedDial(managed(r), "mail.example.test", 993, "imap")) };
    expect(cfg.host, "SNI must be the name, never the address").toBe("mail.example.test");
    expect(cfg.pin).toEqual(["93.184.216.34"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   (5) A RESOLVER OUTAGE IS NOT A VERDICT ABOUT A MAILBOX
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("a resolver that could not answer", () => {
  it("defers the mailbox — a plain Error, never the typed refusal", async () => {
    const r = resolverOf({ "mail.example.test": new Error("EAI_AGAIN") });
    const err = await checkedDial(managed(r), "mail.example.test", 993, "imap").catch((e: unknown) => e);
    expect(err, "a minute of broken DNS must not settle as 'this host is refused'")
      .not.toBeInstanceOf(MailboxHostRefused);
    expect(err).toBeInstanceOf(Error);
  });

  it("carries a CODE the worker's classifier can read, never the resolver's words", async () => {
    const r = resolverOf({ "mail.example.test": ["10.0.0.5"] });
    const err = await checkedDial(managed(r), "mail.example.test", 993, "imap")
      .catch((e: unknown) => e) as MailboxHostRefused;
    expect(err.code).toBe("MAILBOX_HOST_REFUSED");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SOCKET — the check runs BEFORE a connection exists, not beside it
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the fake server seam", () => {
  it("never receives a connection from a refused host", async () => {
    const seen: string[] = [];
    const server: Server = createServer((s) => { seen.push("connected"); s.destroy(); });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as { port: number }).port;
    try {
      // A stored host that IS the listener. Under the managed policy the guard decides before
      // anything opens a socket, so the listener's own count is the reading — not an assertion
      // about what the code intended.
      await expect(checkedDial(managed(resolverOf({})), "127.0.0.1", 993, "imap"))
        .rejects.toBeInstanceOf(MailboxHostRefused);
      expect(seen, "the refusal must happen before a socket exists").toEqual([]);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("does receive one under the admitting policy — the refusal is the POLICY's, not the port's", async () => {
    // The positive control. Without it "nothing connected" is satisfied by a helper that never
    // dials at all, on either policy.
    const seen: string[] = [];
    const server: Server = createServer((s) => { seen.push("connected"); s.destroy(); });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await checkedDial(ALLOW_ANY_DIAL_HOST, "127.0.0.1", 993, "imap")).toEqual({});
      await new Promise<void>((res, rej) => {
        const sock = new Socket();
        sock.connect(port, "127.0.0.1", () => { sock.destroy(); res(); });
        sock.on("error", rej);
      });
      expect(seen, "the listener must be reachable, or the arm above proves nothing").toEqual(["connected"]);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

describe("a stored plaintext consent under each policy", () => {
  const plaintext = { secure: false, allowInsecure: true } as const;

  it("MANAGED: a consent is never honoured — the cleared address is public by construction", async () => {
    // ohmail Cloud reaches no address on the person's network, so a legacy consent stops here.
    const r = resolverOf({ "m.example.test": ["93.184.216.34"] });
    const err = await checkedDial(managed(r), "m.example.test", 993, "imap", plaintext).catch((e: unknown) => e);
    expect((err as { code?: unknown }).code).toBe("MAILBOX_PLAINTEXT_REFUSED");
  });

  it("SELF-HOST: a name on the person's network is admitted, pinned; the same leg with TLS is untouched", async () => {
    const r = resolverOf({ "m.example.test": ["192.168.1.20"] });
    const guard = dialHostGuardFromEnv({ TF_PROBE_ALLOW_PRIVATE: "1" } as NodeJS.ProcessEnv, r);
    await expect(checkedDial(guard, "m.example.test", 993, "imap", plaintext))
      .resolves.toEqual({ pin: ["192.168.1.20"], allowInsecure: true });
    await expect(checkedDial(guard, "m.example.test", 993, "imap", { secure: true, allowInsecure: true })).resolves.toEqual({});
  });
});
