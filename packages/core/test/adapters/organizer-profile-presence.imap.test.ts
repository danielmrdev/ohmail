import net from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import { ImapAdapter } from "../../src/adapters/imap.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import {
  formatProfileMessage,
  makeProfileDoc,
  readOrganizerProfile,
} from "../../src/adapters/organizer-profile.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "./_imapenv.js";

/**
 * The meta searches on the wire. GreenMail and Dovecot are asked both spellings of
 * "this record carries its discriminator" for the settings document, the claim and the ack; each
 * is also reached through a relay that answers an empty-value HEADER term with nothing, the way
 * Infomaniak did. The relay counts its rewrites, so a green through it is a relay that fired. The
 * adapter is a real `ImapAdapter`; the in-process twins are the two `*-presence.test.ts` files.
 */

const ABSENT_VALUE = "ohmail-fixture-value-no-message-carries";

interface EmptyHeaderRelay { port: number; rewrites: number; close(): Promise<void> }

/** A TCP relay that rewrites `HEADER <name> ""` in SEARCH commands; literals pass verbatim. */
async function emptyHeaderMatchesNothing(target: { host: string; port: number }): Promise<EmptyHeaderRelay> {
  let rewrites = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client); sockets.add(upstream);
    let pending = Buffer.alloc(0);
    let literal = 0;
    client.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (literal > 0) {
          const take = Math.min(literal, pending.length);
          if (take === 0) break;
          upstream.write(pending.subarray(0, take));
          pending = pending.subarray(take);
          literal -= take;
          continue;
        }
        const nl = pending.indexOf("\r\n");
        if (nl === -1) break;
        let line = pending.subarray(0, nl).toString("latin1");
        pending = pending.subarray(nl + 2);
        if (/^\S+ (UID )?SEARCH /i.test(line)) {
          line = line.replace(/ HEADER (\S+) ""/gi, (_m, name: string) => {
            rewrites += 1;
            return ` HEADER ${name} "${ABSENT_VALUE}"`;
          });
        }
        upstream.write(Buffer.from(`${line}\r\n`, "latin1"));
        const lit = /\{(\d+)\+?\}$/.exec(line);
        if (lit) literal = Number(lit[1]);
      }
    });
    upstream.on("data", (chunk: Buffer) => { if (!client.destroyed) client.write(chunk); });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    get rewrites() { return rewrites; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function dovecotConfig(): ImapConfig {
  return {
    host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "testpass-password" },
  };
}

const CONDSTORE = await probeCondstore();
const SERVERS = [
  { name: "GreenMail", config: greenmailConfig, enabled: true, why: "" },
  { name: "Dovecot", config: dovecotConfig, enabled: CONDSTORE.ok, why: CONDSTORE.ok ? "" : CONDSTORE.why },
];

const open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c.close().catch(() => { /* already down */ });
});

async function flow(cfg: ImapConfig, port = cfg.port): Promise<ImapFlow> {
  const c = new ImapFlow({ host: cfg.host, port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  open.push({ close: () => c.logout().catch(() => c.close()) });
  return c;
}

function settings(tag: string, at: string, installId: string): string {
  const doc = makeProfileDoc(
    { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [tag], signature: null },
    { updatedAt: new Date(at), producer: { kind: "desktop", version: "test" } },
  );
  return formatProfileMessage(doc, { installId });
}

/** Creates `ohmail/_meta` through the adapter, then returns the server path the witness sees. */
async function metaPathOf(adapter: ImapAdapter, witness: ImapFlow): Promise<string> {
  await adapter.profileIo({ installId: `seed-${randomUUID()}`, mailboxId: "presence" }).ensureMetaFolder();
  const row = (await witness.list()).find((f) => /(^|[./])ohmail[./]_meta$/.test(f.path));
  if (!row) throw new Error("ensureMetaFolder created no ohmail/_meta the witness can list");
  return row.path;
}

async function uidsOf(witness: ImapFlow, path: string): Promise<number[]> {
  const lock = await witness.getMailboxLock(path);
  try {
    const box = witness.mailbox;
    if (typeof box === "object" && box !== null && box.exists === 0) return [];
    const out: number[] = [];
    for await (const m of witness.fetch("1:*", { uid: true }, { uid: false })) out.push(m.uid);
    return out.sort((a, b) => a - b);
  } finally {
    lock.release();
  }
}

async function countOf(c: ImapFlow, path: string, name: string, value: true | string): Promise<number> {
  const lock = await c.getMailboxLock(path);
  try {
    const found = await c.search({ header: { [name]: value } }, { uid: true });
    if (!Array.isArray(found)) throw new Error(`the ${JSON.stringify(value)} search was refused`);
    return found.length;
  } finally {
    lock.release();
  }
}

for (const server of SERVERS) {
  if (!server.enabled) {
    console.warn(`\n[condstore] SKIPPING the settings search against ${server.name} — ${server.why}\n`);
    describe(`settings search on the wire (${server.name})`, () => {
      it.skip(`NOT RUN — ${server.why}`, () => { /* the name is the report */ });
    });
  }

  for (const variant of ["direct", "Infomaniak-like"] as const) {
    describe.skipIf(!server.enabled)(`settings search on the wire (${server.name}, ${variant})`, () => {
      /** The adapter's endpoint: the server itself, or the relay in front of it. */
      async function endpoint(cfg: ImapConfig): Promise<{ cfg: ImapConfig; relay: EmptyHeaderRelay | null }> {
        if (variant === "direct") return { cfg, relay: null };
        const relay = await emptyHeaderMatchesNothing({ host: cfg.host, port: cfg.port });
        open.push(relay);
        return { cfg: { ...cfg, host: "127.0.0.1", port: relay.port }, relay };
      }

      it("measures which spelling this server honours", async () => {
        const cfg = server.config();
        const { cfg: at, relay } = await endpoint(cfg);
        const adapter = new ImapAdapter(at);
        await adapter.connect();
        open.push(adapter);
        const witness = await flow(cfg);
        const path = await metaPathOf(adapter, witness);
        for (const [tag, when] of [["a", "10:00"], ["b", "11:00"], ["c", "12:00"]] as const) {
          await witness.append(path, settings(tag, `2026-09-26T${when}:00Z`, "install-x"), ["\\Seen"]);
        }
        await witness.append(path, "X-Ohmail-Lease: 1\r\nSubject: claim\r\n\r\nclaim", ["\\Seen"]);
        await witness.append(path, "X-Ohmail-Ack: 1\r\nSubject: ack\r\n\r\nack", ["\\Seen"]);

        const asked = await flow(at);
        for (const [name, held] of [["X-Ohmail-Profile", 3], ["X-Ohmail-Lease", 1], ["X-Ohmail-Ack", 1]] as const) {
          const empty = await countOf(asked, path, name, true);
          const one = await countOf(asked, path, name, "1");
          console.log(`MEASURE ${server.name} ${variant}: HEADER ${name} "" -> ${empty}, "1" -> ${one} (holds ${held})`);
          expect(one, `${server.name} ${variant}: ${name} by the value the record carries`).toBe(held);
          expect(empty, `${server.name} ${variant}: ${name} by the empty value`).toBe(relay === null ? held : 0);
        }
        if (relay !== null) expect(relay.rewrites, "the relay never fired").toBe(3);
      });

      it("the real adapter takes the newest document and removes nothing", async () => {
        const cfg = server.config();
        const { cfg: at } = await endpoint(cfg);
        const adapter = new ImapAdapter(at);
        await adapter.connect();
        open.push(adapter);
        const witness = await flow(cfg);
        const path = await metaPathOf(adapter, witness);
        await witness.append(path, settings("older", "2026-09-26T11:31:28Z", "install-b5f7"), ["\\Seen"]);
        await witness.append(path, settings("second", "2026-09-26T15:46:55Z", "install-1aa6"), ["\\Seen"]);
        await witness.append(path, settings("newest", "2026-09-26T15:52:52Z", "install-1aa6"), ["\\Seen"]);
        await witness.append(path, "Subject: a stranger's message\r\n\r\nbody", ["\\Seen"]);
        const before = await uidsOf(witness, path);

        const read = await readOrganizerProfile(
          adapter.profileIo({ installId: `reader-${randomUUID()}`, mailboxId: "presence" }),
        );

        expect(read.state, `${server.name} ${variant}: three documents and the read found none`).toBe("found");
        if (read.state === "found") {
          expect(read.doc.tagNames).toEqual(["newest"]);
          // FIX-026: the tidy's count counts the other install's copy too, hours older and unclaimed.
          expect(read.residue).toBe(2);
        }
        expect(await uidsOf(witness, path), "the read removed a copy").toEqual(before);
      });

      it("an empty folder and a claim-only folder still read none", async () => {
        const cfg = server.config();
        const { cfg: at } = await endpoint(cfg);
        const adapter = new ImapAdapter(at);
        await adapter.connect();
        open.push(adapter);
        const witness = await flow(cfg);
        const path = await metaPathOf(adapter, witness);
        const io = (): ReturnType<ImapAdapter["profileIo"]> =>
          adapter.profileIo({ installId: `reader-${randomUUID()}`, mailboxId: "presence" });

        expect((await readOrganizerProfile(io())).state, "an empty ohmail/_meta").toBe("none");
        await witness.append(path, "X-Ohmail-Lease: 1\r\nSubject: claim\r\n\r\nclaim", ["\\Seen"]);
        expect((await readOrganizerProfile(io())).state, "a claim-only ohmail/_meta").toBe("none");
      });
    });
  }
}
