/**
 * A HAND-BACK OPENS THE GAP AT THE PERSON'S PRESS, ON THE DEVICE STORE. The phone's
 * engine composed over SQLite, an in-memory `ohmail/_meta` and a mail server double: the stop, a
 * letter arriving while it is honoured, the reader taking it in before its first look, then
 * "Organize here". Nothing moves until File; Leave moves nothing; and what the still-active
 * organizer decided between the press and the honouring is never offered (RULING Q1).
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

/** `phone-stop-then-start.test.ts`'s statement runner: one serial writer, as a device has. */
function nodeExecutor(): PhoneSqlExecutor & { direct: (sql: string, params?: unknown[]) => unknown[] } {
  const raw = new sqlite.DatabaseSync(":memory:");
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        const st = raw.prepare(sql);
        const columns = (st.columns ? st.columns() : []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
        const rows = columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => { await yielded(); raw.prepare(sql).run(...(params as unknown[])); });
    },
    async batch(statements): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as unknown[]));
          raw.exec("COMMIT");
        } catch (err) {
          try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
          throw err;
        }
      });
    },
    async close(): Promise<void> { try { raw.close(); } catch { /* already closed */ } },
    direct: (sql, params = []) => raw.prepare(sql).all(...params),
  };
}

class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  /** Runs when the folder empties: the stop honoured, never a renewal's expunge of an older record. */
  onRemove: (() => void) | null = null;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    if (this.claims.length === 0) this.onRemove?.();
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
  get count(): number { return this.claims.length; }
}

let uid = 70;
function letter(internalDate: Date): ChangeBatch["creates"][number] {
  uid += 1;
  const raw = Buffer.from([
    "From: Letters <letters@news.test>", "To: a@b.test", `Subject: letter ${uid}`,
    `Message-ID: <handback-${uid}@news.test>`, "Date: Sun, 11 Oct 2026 04:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8", "", "this week's letter", "",
  ].join("\r\n"));
  return { type: "create", locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator, raw, internalDate, seen: false };
}

/** The mail server: what arrives next, every move asked of it, a hand that can hold one read, its doorbell. */
interface Server {
  pending: Array<ChangeBatch["creates"][number]>;
  moves: Array<{ from: string; to: string }>;
  hold: Promise<void> | null;
  ring: (() => void) | null;
  factory: (cfg: ImapConfig) => MailboxAdapter;
}

function mailServer(meta: MemoryMetaFolder): Server {
  const s: Server = {
    pending: [], moves: [], hold: null, ring: null,
    factory: (_cfg: ImapConfig) => ({
      leaseIo: () => meta,
      leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
      async connect(): Promise<void> {},
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince(): Promise<ChangeBatch> {
        if (s.hold !== null) await s.hold;
        return { creates: s.pending.splice(0), moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
      },
      async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
        s.moves.push({ from: locator.folder, to });
        return { ...locator, folder: to };
      },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(onChange: () => void): Promise<() => Promise<void>> {
        s.ring = onChange;
        return async () => { if (s.ring === onChange) s.ring = null; };
      },
      async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("no send"); },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart"); },
    }) as MailboxAdapter,
  };
  return s;
}

const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";
const open: PhoneEngine[] = [];
afterEach(async () => { while (open.length > 0) await open.pop()!.stop().catch(() => undefined); });

interface Gap { since: number | null; letters: number | null; pressed: number | null }

/** An organizing phone with a consented row, a claim in the folder and a News rule older than any letter. */
async function organizingPhone() {
  const exec = nodeExecutor();
  const meta = new MemoryMetaFolder();
  const server = mailServer(meta);
  const engine = await startPhoneEngine({
    exec, imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
    machineName: "ohmail on a phone", installId: "install-handback-gap", adapterFactory: server.factory, log: () => {},
  } as Parameters<typeof startPhoneEngine>[0]);
  open.push(engine);
  const id = Object.keys(engine.runtimes().organizer)[0]!;
  exec.direct(`insert or replace into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
    values (?, 'imap', 'not-a-secret', 1)`, [id]);
  exec.direct(`update mailboxes set organizer_role = 'organizer', organize_consented_at = 1, status = 'connected' where id = ?`, [id]);
  const ruleMade = Date.now() - 7 * 86_400_000;
  exec.direct(`insert into rules (account_id, kind, match, destination, provenance, enabled, created_at, updated_at)
    values ((select account_id from mailboxes where id = ?), 'sender', 'letters@news.test', 'ohmail/News', 'manual', 1, ?, ?)`,
  [id, ruleMade, ruleMade]);
  await engine.resume();
  expect(meta.count, "premise: this phone holds its claim").toBe(1);
  const gap = (): Gap => (exec.direct(`select gap_since as since, gap_letters as letters, gap_pressed_at as pressed
    from mailboxes where id = ?`, [id]) as Gap[])[0]!;
  /* THE ORDINARY DRAIN, rung by the doorbell: a forced one (`resume`) is not the quiet drain that
     licenses the gap pass, so the offer is driven the way a real arrival drives it. */
  const until = async (done: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 80; i++) {
      if (done()) return true;
      server.ring?.();
      await new Promise((r) => setTimeout(r, 50));
    }
    return done();
  };
  // The look before consent noted a window, as on every fresh mailbox; this phone's tenure closes it.
  expect(await until(() => gap().since === null), "premise: an organizing phone's tenure closed the boot window").toBe(true);
  // Drains are serialized per mailbox: a forced one queues behind any rung drain still running.
  await engine.resume();
  const route = (path: string, body: unknown) => engine.handle(new Request(`http://engine.invalid${path}`, {
    method: "POST", headers: { authorization: `Bearer ${engine.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return {
    engine, meta, server, id, route,
    gap, until,
    pressedAt: (): number | null => (exec.direct("select release_requested_at as p from mailboxes where id = ?", [id]) as { p: number | null }[])[0]!.p,
    refusal: (): string | null => (exec.direct("select release_refusal as r from mailboxes where id = ?", [id]) as { r: string | null }[])[0]!.r,
    letters: () => exec.direct(`select m.id, m.created_at as createdAt, m.arrived_at as arrivedAt, f.last_set_by as lastSetBy,
        f.desired_folder as desired from messages m join folder_state f on f.message_id = m.id order by m.created_at`) as
      Array<{ id: string; createdAt: number; arrivedAt: number; lastSetBy: string; desired: string }>,
    /** The letters the gap pass filed, by its own audit row. */
    gapFiled: () => (exec.direct("select payload from audit_log where action = 'gap_catchup_move'") as { payload: string }[])
      .map((r) => (JSON.parse(r.payload) as { messageId: string }).messageId),
    /** "Organize here", then ordinary drains until the window is counted or closed. */
    organizeHere: async () => {
      expect(await engine.claimHere({ by: "press" })).toBe("claimed");
      await until(() => gap().letters !== null || gap().since === null);
    },
  };
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(process.env.OHMAIL_EXPECT_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("the gap window a hand-back opens, on the device store", () => {
  /** The stop, with one ruled letter arriving while it is honoured: taken in before the first look. */
  async function handedBackWithALetter() {
    const p = await organizingPhone();
    p.meta.onRemove = () => { p.server.pending.push(letter(new Date())); p.meta.onRemove = null; };
    await expect(p.engine.stopOrganizing()).resolves.toBe("released");
    const [taken] = p.letters();
    expect(taken, "the reader did not take the letter in").toMatchObject({ lastSetBy: "peer", desired: "INBOX" });
    await p.engine.resume();
    return p;
  }

  it("the letter is offered after Organize here, nothing moves, and File files it once", async () => {
    const p = await handedBackWithALetter();
    await p.organizeHere();
    expect(p.server.moves, "mail moved without the press").toEqual([]);
    expect(p.gap(), "the offer missed the letter the hand-back let through").toMatchObject({ letters: 1, pressed: null });
    const filed = await p.route(`/mailboxes/${p.id}/gap-letters`, { file: true, count: 1 });
    expect(filed.status, await filed.clone().text()).toBe(202);
    for (let i = 0; i < 100 && p.server.moves.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(p.server.moves).toEqual([{ from: "INBOX", to: "ohmail/News" }]);
    for (let i = 0; i < 3; i++) await p.engine.resume();
    expect(p.server.moves, "the letter was filed more than once").toHaveLength(1);
    expect(p.gap()).toEqual({ since: null, letters: null, pressed: null });
  }, 60_000);

  it("Leave closes the offer and nothing moves", async () => {
    const p = await handedBackWithALetter();
    await p.organizeHere();
    expect(p.gap().letters, "premise: the letter was offered").toBe(1);
    const left = await p.route(`/mailboxes/${p.id}/gap-letters`, { file: false });
    expect(left.status, await left.clone().text()).toBe(200);
    for (let i = 0; i < 3; i++) await p.engine.resume();
    expect(p.server.moves, "Leave moved mail").toEqual([]);
    expect(p.gap()).toEqual({ since: null, letters: null, pressed: null });
  }, 60_000);

  it("a stop refused for a copy of this install opens the window when the copy lets go, never at the press", async () => {
    const p = await organizingPhone();
    // A restored copy took the mailbox over: our record is gone, and the copy renews one under this
    // install's id and a nonce this process never wrote.
    await p.meta.removeClaims((await p.meta.listClaims()).map((c) => c.ref));
    await p.meta.appendClaim(formatClaim({
      installId: "install-handback-gap", kind: "mobile", displayName: "ohmail on a phone", heartbeat: new Date(),
      claimedAt: new Date(), nonce: "a-restored-copy", authorizedAt: null, capabilities: [],
    }));
    await p.engine.stopOrganizing();
    expect(p.refusal(), "premise: the stop was refused for the copy").toBe("sibling_lapse");
    const pressedAt = p.pressedAt();
    expect(pressedAt, "premise: the stop still stands").not.toBeNull();
    // The copy organizes; this install's reader takes in a letter the copy kept in INBOX.
    p.server.pending.push(letter(new Date()));
    await p.engine.resume();
    const [keptByTheCopy] = p.letters();
    expect(keptByTheCopy).toMatchObject({ lastSetBy: "peer", desired: "INBOX" });
    // The copy lets go.
    const copy = (await p.meta.listClaims()).find((c) => c.raw.includes("a-restored-copy"))!;
    await p.meta.removeClaims([copy.ref]);
    const left = Date.now();
    await p.engine.resume();
    const since = p.gap().since;
    expect(since, "the release opened no window").not.toBeNull();
    expect(since!, "the window reached back over the copy's tenure").toBeGreaterThan(pressedAt!);
    expect(since!).toBeGreaterThanOrEqual(left - 1_000);
    p.server.pending.push(letter(new Date()));
    await p.engine.resume();
    await p.organizeHere();
    expect(p.gap(), "a letter the copy kept was counted").toMatchObject({ letters: 1, pressed: null });
  }, 60_000);

  it("RULING Q1: a letter the still-active organizer filed after the press is not offered; a gap letter is", async () => {
    const p = await organizingPhone();
    let letGo!: () => void;
    p.server.hold = new Promise<void>((r) => { letGo = r; });
    const organizing = p.engine.resume();
    // The press lands while the organizer's own read is in flight.
    const stop = await p.route(`/mailboxes/${p.id}/release`, {});
    expect(stop.status, await stop.clone().text()).toBe(202);
    const pressedAt = p.pressedAt();
    expect(pressedAt, "premise: the press is on the row").not.toBeNull();
    p.server.pending.push(letter(new Date()));
    p.server.hold = null;
    letGo();
    await organizing;
    const [decided] = p.letters();
    expect(decided, "premise: the still-active organizer decided its letter").toMatchObject({ lastSetBy: "us", desired: "ohmail/News" });
    await p.engine.resume();
    expect(p.meta.count, "premise: the stop was honoured").toBe(0);
    p.server.pending.push(letter(new Date()));
    await p.engine.resume();
    const since = p.gap().since;
    expect(since, "the window did not open at the press").toBe(pressedAt);
    // Inside the window by both instants: only the organizer's decision keeps it out.
    expect(decided!.createdAt).toBeGreaterThanOrEqual(since!);
    expect(decided!.arrivedAt).toBeGreaterThanOrEqual(since!);
    const gapLetter = p.letters().find((l) => l.id !== decided!.id);
    expect(gapLetter).toMatchObject({ lastSetBy: "peer", desired: "INBOX" });

    await p.organizeHere();
    expect(p.gap(), "a letter the organizer decided was offered").toMatchObject({ letters: 1, pressed: null });
    const filed = await p.route(`/mailboxes/${p.id}/gap-letters`, { file: true, count: 1 });
    expect(filed.status, await filed.clone().text()).toBe(202);
    await p.until(() => p.gapFiled().length > 0);
    for (let i = 0; i < 3; i++) await p.engine.resume();
    expect(p.gapFiled(), "the gap pass filed a letter the organizer had decided").toEqual([gapLetter!.id]);
    expect(p.gap()).toEqual({ since: null, letters: null, pressed: null });
  }, 60_000);
});
