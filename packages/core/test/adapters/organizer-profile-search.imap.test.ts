import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import { ImapAdapter } from "../../src/adapters/imap.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import { makeProfileDoc, profileFingerprint, writeOrganizerProfile, readOrganizerProfile } from "../../src/adapters/organizer-profile.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "./_imapenv.js";

/**
 * THE SETTINGS MESSAGE CARRIES NO WORD ANOTHER MAIL APP'S SEARCH FINDS (PROFILE-SETTINGS-STILL-
 * MATCH-SEARCHES). A screened address, a contact's name and a rule's text are written through a
 * real adapter; an independent connection asks the server `SEARCH TEXT <nonce>`. A stray message
 * carrying the same nonce in plain text is the positive control that the server's search reads
 * bodies at all, and ohmail reading its own settings back equal is the other half.
 */
/* Dovecot is the shared box behind the GreenMail lock (box-files classes this file LOCKED). */
function dovecotConfig(): ImapConfig {
  return { host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false, auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "testpass-password" } };
}
const CONDSTORE = await probeCondstore();
const SERVERS = [
  { name: "GreenMail", config: greenmailConfig, enabled: true },
  { name: "Dovecot", config: dovecotConfig, enabled: CONDSTORE.ok },
];

const open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => { for (const c of open.splice(0).reverse()) await c.close().catch(() => undefined); });

async function searchText(cfg: ImapConfig, path: string, needle: string): Promise<number[]> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  try {
    const lock = await c.getMailboxLock(path);
    try {
      const found = await c.search({ text: needle }, { uid: true });
      return Array.isArray(found) ? found : [];
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => c.close()); }
}

for (const server of SERVERS) {
  describe.skipIf(!server.enabled)(`the settings message under SEARCH TEXT (${server.name})`, () => {
    it("finds the plain-text control and not the settings message; ohmail reads its settings back equal", async () => {
      const cfg = server.config();
      const adapter = new ImapAdapter(cfg);
      await adapter.connect();
      open.push(adapter);
      const installId = `writer-${randomUUID()}`;
      const io = adapter.profileIo({ installId, mailboxId: "search" });
      await io.ensureMetaFolder();
      const nonce = `zq${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const payload = {
        screener: [{ address: `${nonce}@example.com`, name: `Ada ${nonce}` }],
        rules: [], notifyRules: [], awayResponder: null, tagNames: [`tag${nonce}`], signature: `Regards ${nonce}`,
      };
      const doc = makeProfileDoc(payload, { updatedAt: new Date(Date.UTC(2026, 9, 2, 6, 0, 0)), producer: { kind: "cloud", version: "test" } });
      const written = await writeOrganizerProfile({ io, doc, installId });
      expect(written.written).toBe(true);

      const witness = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
      await witness.connect();
      open.push({ close: () => witness.logout().catch(() => witness.close()) });
      const row = (await witness.list()).find((f) => /(^|[./])ohmail[./]_meta$/.test(f.path));
      expect(row, "no ohmail/_meta").toBeDefined();
      await witness.append(row!.path, `Subject: control\r\nContent-Type: text/plain\r\n\r\ncontrol ${nonce} body\r\n`);

      const hits = await searchText(cfg, row!.path, nonce);
      console.log(`MEASURE ${server.name} SEARCH TEXT ${nonce.length}-char nonce: ${hits.length} hit(s) ${JSON.stringify(hits)}`);
      expect(hits.length, "the server's search did not find even the plain-text control").toBeGreaterThanOrEqual(1);
      expect(hits, "SEARCH TEXT found the settings message by a value it carries").toHaveLength(1);

      const back = await readOrganizerProfile(io);
      expect(back.state).toBe("found");
      expect(back.state === "found" ? profileFingerprint(back.doc) : null).toBe(profileFingerprint(doc));
    });
  });
}
