import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import { ClaimReleaseError, LeaseUnavailableError, makeLeaseIo, type LeaseImapClient } from "../../src/adapters/organizer-lease.js";

/**
 * A SOCKET THAT DIES DURING EXPUNGE IS A TRANSPORT FAULT, NOT A REFUSAL (a low review
 * finding). imapflow's `messageDelete` resolves `false` both when the server refuses the EXPUNGE and
 * when the connection drops under it; only the refusal may count toward the undeletable block. A
 * loopback stub speaks just enough IMAP for the real client, then destroys the socket on
 * `UID EXPUNGE` — or, as the control, answers it `NO`.
 */

const META = "ohmail/_meta";
const ID = { installId: "us", mailboxId: "mb-socket" };

function stub(onExpunge: "destroy" | "refuse"): Promise<{ server: Server; port: number }> {
  const server = createServer((sock: Socket) => {
    let buf = "";
    const say = (line: string): void => { if (!sock.destroyed) sock.write(`${line}\r\n`); };
    say("* OK [CAPABILITY IMAP4rev1 UIDPLUS AUTH=PLAIN] stub ready");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let at: number;
      while ((at = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const [tag, ...rest] = line.split(" ");
        const cmd = rest.join(" ").toUpperCase();
        if (cmd.startsWith("CAPABILITY")) { say("* CAPABILITY IMAP4rev1 UIDPLUS AUTH=PLAIN"); say(`${tag} OK done`); }
        else if (cmd === 'LIST "" ""') { say('* LIST (\\Noselect) "/" ""'); say(`${tag} OK done`); }
        else if (cmd.startsWith("LIST")) { say(`* LIST (\\HasNoChildren \\Subscribed) "/" "${META}"`); say(`${tag} OK done`); }
        else if (cmd.startsWith("SELECT") || cmd.startsWith("EXAMINE")) {
          say("* 1 EXISTS"); say("* OK [UIDVALIDITY 7] ok"); say("* OK [UIDNEXT 2] ok");
          say("* FLAGS (\\Seen \\Deleted)"); say("* OK [PERMANENTFLAGS (\\Seen \\Deleted)] ok");
          say(`${tag} OK [READ-WRITE] selected`);
        } else if (cmd.startsWith("UID FETCH")) { say("* 1 FETCH (UID 1)"); say(`${tag} OK done`); }
        else if (cmd.startsWith("UID STORE")) { say(`${tag} OK done`); }
        else if (cmd.startsWith("UID EXPUNGE")) {
          if (onExpunge === "destroy") sock.destroy();
          else say(`${tag} NO [NOPERM] expunge not permitted`);
        } else if (cmd.startsWith("LOGOUT")) { say("* BYE"); say(`${tag} OK bye`); sock.end(); }
        else say(`${tag} OK done`);
      }
    });
    sock.on("error", () => { /* the stub's own destroy */ });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr !== null ? addr.port : 0 });
    });
  });
}

let open: Array<() => Promise<void>> = [];
beforeEach(() => { resetMetaMemos(); });
afterEach(async () => { for (const c of open.splice(0)) await c().catch(() => undefined); });

async function connected(onExpunge: "destroy" | "refuse"): Promise<ImapFlow> {
  const { server, port } = await stub(onExpunge);
  const client = new ImapFlow({
    host: "127.0.0.1", port, secure: false, auth: { user: "u", pass: "p" }, logger: false,
  });
  client.on("error", () => { /* the drop is the subject */ });
  await client.connect();
  open.push(async () => { client.close(); await new Promise<void>((r) => { server.close(() => r()); }); });
  return client;
}

const io = (c: ImapFlow) => makeLeaseIo(c as unknown as LeaseImapClient, (x) => x, ID);

describe("a dead socket under EXPUNGE is not the server refusing", () => {
  it("removeClaims throws a transport fault, not expunge_refused", async () => {
    const c = await connected("destroy");
    const err = await io(c).removeClaims([1]).then(() => null, (e: unknown) => e);
    expect(err instanceof ClaimReleaseError, "a dropped socket was counted as a refusal").toBe(false);
    expect(err instanceof LeaseUnavailableError && err.op).toBe("remove_claims");
  });

  it("the probe reads unproven, not standing", async () => {
    const c = await connected("destroy");
    const lease = io(c);
    lease.noteCleanup!({ landed: false, uid: 1, generation: 7 });
    expect(await lease.probeUndeletable!()).toEqual({ kind: "unproven" });
  });

  it("CONTROL: a refused EXPUNGE on a live socket is still expunge_refused, in both", async () => {
    const c = await connected("refuse");
    const err = await io(c).removeClaims([1]).then(() => null, (e: unknown) => e);
    expect(err instanceof ClaimReleaseError && err.code).toBe("expunge_refused");
    const lease = io(c);
    lease.noteCleanup!({ landed: false, uid: 1, generation: 7 });
    expect(await lease.probeUndeletable!()).toEqual({ kind: "standing", uid: 1, code: "expunge_refused" });
  });
});
