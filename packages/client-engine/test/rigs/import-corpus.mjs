/**
 * THE CORPUS BOTH IMPORT RIGS DRIVE, in one place so the two cannot drift apart.
 *
 * `import-peak-rig.mjs` (Node: the engine, the store and the whole-mirror selectors) and
 * `apps/desktop/rigs/renderer-peak/` (a real browser: the same engine under the real
 * `AppShell`) measure two halves of one number, and a comparison between them is only a
 * comparison if the mail is the same mail — the renderer's classes are read by SUBTRACTING the
 * Node figure from the browser's, so a distribution that differed by one folder would put the
 * difference straight into the answer.
 *
 * Browser-safe by construction: no `node:` import anywhere in this file.
 */

/** Fixed, so two arms of one comparison see the identical corpus. */
export const CORPUS_NOW = new Date("2026-09-12T10:00:00.000Z");

const MIN = 60_000;

/**
 * THE CORPUS, as it is on disk. Measured from the rig maildir at
 * `~/memcell-vmail/mem75k@rig.test/Maildir` on 2026-09-12 — the count and the newest-message age
 * of each of the seven physical folders, and the generator's own minutes-long step between
 * messages, which is what makes a large folder span roughly two years the way a real mailbox
 * does. Reproducing the DISTRIBUTION and not just the count is the whole reason either rig can
 * say anything about the window's row count: a corpus spaced one minute apart fits inside ninety
 * days and would measure `full` while asking for `windowed`.
 */
export const FOLDERS = [
  { name: "INBOX", count: 20000, dayOff: 0 },
  { name: "Archive", count: 13636, dayOff: 30 },
  { name: "Newsletters", count: 12448, dayOff: 5 },
  { name: "Receipts", count: 11983, dayOff: 12 },
  { name: "Lists", count: 9542, dayOff: 3 },
  { name: "Projects", count: 4213, dayOff: 20 },
  { name: "ohmail/Screener", count: 2027, dayOff: 90 },
  { name: "Sent", count: 154, dayOff: 1 },
];

/** The address the corpus is addressed to. A rig domain, never anybody's mailbox. */
export const CORPUS_OWNER = "mem75k@rig.test";

export function corpus({ scale = 1, order = "asc", now = CORPUS_NOW } = {}) {
  let seed = 0x5eed17;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };
  const messages = [];
  let n = 0;
  for (const f of FOLDERS) {
    let when = now.getTime() - f.dayOff * 86_400_000;
    const count = Math.max(1, Math.round(f.count * scale));
    for (let i = 0; i < count; i++) {
      const id = `m${n++}`;
      const date = new Date(when).toISOString();
      messages.push({
        id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: `<${id}@x.example>`,
        subject: `Invoice ${Math.floor(rnd() * 90000 + 1000)} — the subject line as the row renders it`,
        from: { name: `Sender ${n % 400}`, address: `sender${n % 400}@org${n % 60}.example` },
        to: [{ name: null, address: CORPUS_OWNER }], cc: [],
        date,
        folder: f.name,
        snippet: `snippet ${id} — a line of preview text the row renders, long enough to be real`,
        unread: n % 9 === 0, hasAttachments: n % 5 === 0, attachmentCount: n % 5 === 0 ? 1 : 0,
        sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
        triage: null, labels: [], remoteContent: "none", updatedAt: date,
      });
      // 12-90 minutes back, the generator's own step.
      when -= (12 + rnd() * 78) * MIN;
    }
  }
  // Newest first is NOT how a delta feed arrives; the log is ascending by seq. Sort ascending by
  // date so the pages arrive oldest-first, which is what a since=0 replay does.
  messages.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (order === "desc") messages.reverse();
  return messages;
}

/**
 * A fingerprint over the fields that decide what the window holds - id, date and folder, in the
 * order the pages will arrive. It exists so the extraction of this module out of the Node rig can
 * be PROVEN not to have moved the corpus rather than argued from the diff: the Node rig is the
 * store control for the renderer measurement and its number may not move.
 *
 * FNV-1a over the joined key rather than a real digest, because this file may not import
 * `node:crypto` - it is bundled into a browser.
 */
export function corpusFingerprint(messages) {
  let h = 0x811c9dc5;
  for (const m of messages) {
    const s = `${m.id}|${m.date}|${m.folder}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return `fnv1a:${h.toString(16).padStart(8, "0")}:${messages.length}`;
}
