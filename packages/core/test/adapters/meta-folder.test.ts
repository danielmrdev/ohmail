import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AmbiguousMetaFolderError,
  LeaseUnavailableError,
  META_FOLDER,
  formatClaim,
  makeLeaseIo,
  makeLeasePeekIo,
  readLeasePeek,
  resolveMetaFolder,
  runLeaseGate,
  type LeaseSelf,
} from "../../src/adapters/organizer-lease.js";
import {
  makeProfileDoc, makeProfileIo, readOrganizerProfile, writeOrganizerProfile,
} from "../../src/adapters/organizer-profile.js";
import { memoryImapServer } from "./_metaworld.js";

/** The io seams refuse a memory they cannot attribute, so every fixture states one. */
const TEST_META_ID = { installId: "test-install", mailboxId: "test-mailbox" };

/**
 * ═══ `ohmail/_meta` UNDER A PERSONAL-NAMESPACE PREFIX ═══════════════════════════════════════
 *
 * THE DEFECT, MEASURED LIVE. Both mailboxes this project runs against are Dovecot announcing
 * `NAMESPACE` personal prefix `INBOX.` with delimiter `.`, and both hold their organizer lease in
 * `INBOX.ohmail._meta`. The pre-consent peek computed `toServerPath(META_FOLDER)` —
 * `ohmail._meta` — listed the folders, and returned `[]` unless a path EQUALLED that string. So
 * on a mailbox that production Cloud organizes with a heartbeat minutes old, the peek reported
 * `heldBy: null`, the guided flow's "somebody else organizes this mailbox" step never rendered,
 * and a person could take the mailbox over without being told — the one outcome
 * `notePreConsentHolder`'s docblock says must not happen. The consented path survived only
 * because the server FORGIVES an unprefixed name on CREATE and SELECT; it does not forgive it on
 * LIST, which is the command the read used.
 *
 * WHAT THESE GUARDS ARE FOR. Every one of them fails when the resolution is reverted to a string
 * comparison, and the file censuses the source at the end so a future caller cannot reintroduce
 * one quietly.
 */

const NOW = new Date();
const selfOf = (installId: string): LeaseSelf => ({
  installId, kind: "local", displayName: `${installId} machine`, lastNonce: null,
});

// ── LAYER 1: the resolution itself, pure ────────────────────────────────────────────────────

describe("resolveMetaFolder — where the folder IS, not what it is called", () => {
  const row = (path: string, delimiter = "."): { path: string; delimiter: string } => ({ path, delimiter });

  it("finds a root-level folder on a slash-delimited server", () => {
    const at = resolveMetaFolder({ list: [row("INBOX", "/"), row("ohmail/_meta", "/")], bare: "ohmail/_meta" });
    expect(at.path).toBe("ohmail/_meta");
    expect(at.row).not.toBeNull();
  });

  it("finds a root-level folder on a dot-delimited server", () => {
    const at = resolveMetaFolder({ list: [row("INBOX"), row("ohmail._meta")], bare: "ohmail._meta" });
    expect(at.path).toBe("ohmail._meta");
  });

  /** THE LIVE CASE. Infomaniak/Dovecot: personal prefix `INBOX.`, delimiter `.`. */
  it("finds the folder under a NAMESPACE-declared prefix (`.` delimiter)", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX"), row("INBOX.ohmail"), row("INBOX.ohmail._meta")],
      bare: "ohmail._meta",
      namespaces: [{ prefix: "INBOX.", delimiter: "." }],
    });
    expect(at.path).toBe("INBOX.ohmail._meta");
    expect(at.row?.path).toBe("INBOX.ohmail._meta");
  });

  it("finds the folder under a NAMESPACE-declared prefix (`/` delimiter)", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX", "/"), row("INBOX/ohmail/_meta", "/")],
      bare: "ohmail/_meta",
      namespaces: [{ prefix: "INBOX/", delimiter: "/" }],
    });
    expect(at.path).toBe("INBOX/ohmail/_meta");
  });

  /**
   * A prefix that is not `INBOX`. Hardcoding the common case would have left every server whose
   * personal namespace is spelled anything else exactly as broken as before.
   */
  it("finds it under a prefix that is not INBOX", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX"), row("Mail.ohmail._meta")],
      bare: "ohmail._meta",
      namespaces: [{ prefix: "Mail.", delimiter: "." }],
    });
    expect(at.path).toBe("Mail.ohmail._meta");
  });

  /**
   * No NAMESPACE to ask. The prefix is then derived from the LIST: `INBOX.` counts because the
   * server lists a mailbox called `INBOX`.
   */
  it("derives the prefix from the LIST when the client announces no namespace", () => {
    const at = resolveMetaFolder({ list: [row("INBOX"), row("INBOX.ohmail._meta")], bare: "ohmail._meta" });
    expect(at.path).toBe("INBOX.ohmail._meta");
  });

  /**
   * AND IT IS NOT A BLANKET SUFFIX MATCH. A customer's own `Backup.ohmail._meta` is not the
   * organizer lease, and adopting it would put this install's claim inside somebody's archive.
   */
  it("does NOT adopt a look-alike outside the declared namespace", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX"), row("INBOX.Backup"), row("INBOX.Backup.ohmail._meta")],
      bare: "ohmail._meta",
      namespaces: [{ prefix: "INBOX.", delimiter: "." }],
    });
    expect(at.row).toBeNull();
    expect(at.path).toBe("INBOX.ohmail._meta");
  });

  it("does not adopt a name fragment that merely ends in the folder name", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX"), row("myohmail._meta")],
      bare: "ohmail._meta",
      namespaces: [{ prefix: "INBOX.", delimiter: "." }],
    });
    expect(at.row).toBeNull();
  });

  /**
   * TWO CANDIDATES IS A REFUSAL, NEVER A CHOICE. Picking one would leave a reader and a writer in
   * different folders — each renewing a claim the other cannot see, which is the dual-organizer
   * bug with a longer fuse.
   */
  it("REFUSES when two folders both answer to the name", () => {
    let caught: unknown;
    try {
      resolveMetaFolder({
        list: [row("INBOX"), row("ohmail._meta"), row("INBOX.ohmail._meta")],
        bare: "ohmail._meta",
        namespaces: [{ prefix: "INBOX.", delimiter: "." }],
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AmbiguousMetaFolderError);
    expect((caught as AmbiguousMetaFolderError).paths).toEqual(["ohmail._meta", "INBOX.ohmail._meta"]);
  });

  /**
   * The ROOT spelling stays a candidate whatever NAMESPACE says: an install that ran before this
   * resolution existed may have left its `_meta` there, and that folder holds a claim a newer
   * install must still see.
   */
  it("still finds a root-level folder on a server that declares a prefix", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX"), row("ohmail._meta")],
      bare: "ohmail._meta",
      namespaces: [{ prefix: "INBOX.", delimiter: "." }],
    });
    expect(at.path).toBe("ohmail._meta");
    expect(at.row).not.toBeNull();
  });

  /**
   * A DECLARED EMPTY PREFIX IS AN ANSWER, NOT A MISSING ONE. Gmail and Fastmail declare one
   * personal namespace whose prefix is `""` — mailboxes live at the root, and nowhere else. Read
   * as "no prefix declared" this would fall through to the derived branch and let a customer's
   * own `Archive/ohmail/_meta` become this mailbox's organizer lease.
   */
  it("treats a declared EMPTY prefix as authoritative — the root, and nowhere else", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX", "/"), row("Archive", "/"), row("Archive/ohmail/_meta", "/")],
      bare: "ohmail/_meta",
      namespaces: [{ prefix: "", delimiter: "/" }],
    });
    expect(at.row).toBeNull();
    expect(at.path).toBe("ohmail/_meta");
  });

  /**
   * SEVERAL PERSONAL NAMESPACES, AND ONLY THE FIRST IS OURS. `ImapFlow` sets
   * `namespace = namespaces.personal[0]` and prepends THAT prefix to every path it sends and
   * every path LIST returns, so a folder under a second declared namespace is not where this
   * connection's own organizer would ever write. Adopting it reads a claim out of somewhere the
   * writer will never renew — and on a real server that second namespace can be another
   * account's mail.
   */
  it("ignores a folder under a SECOND declared personal namespace", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX", "/"), row("Shared", "/"), row("Shared/ohmail/_meta", "/")],
      bare: "ohmail/_meta",
      namespaces: [{ prefix: "", delimiter: "/" }, { prefix: "Shared/", delimiter: "/" }],
    });
    expect(at.row).toBeNull();
    // AND THE CREATE PATH IS THE FIRST NAMESPACE'S, not the first NON-EMPTY one. Filtering the
    // empty prefix out before taking the head is the same bug on the write side.
    expect(at.path).toBe("ohmail/_meta");
  });

  /**
   * A PREFIX AND A NAME IN TWO ALPHABETS IS A FOLDER NOBODY MEANT TO MAKE. `ImapAdapter.connect`
   * falls back to `delimiter = "/"` when the LIST carries no INBOX row and no delimiter of its
   * own, so `toServerPath` can hand this `ohmail/_meta` while NAMESPACE reports `.`. Appending
   * the derived delimiter to a prefix that does not use it produced `INBOX./ohmail/_meta` —
   * a name `ensureMetaFolder` would then CREATE in the customer's mailbox.
   */
  it("resolves in ONE alphabet when the seam and the namespace disagree", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX"), row("INBOX.ohmail._meta")],
      bare: "ohmail/_meta",
      namespaces: [{ prefix: "INBOX.", delimiter: "." }],
    });
    expect(at.path).toBe("INBOX.ohmail._meta");
    expect(at.row?.path).toBe("INBOX.ohmail._meta");
  });

  /** And the create side of the same disagreement: still one alphabet, still no stray name. */
  it("creates in ONE alphabet when the seam and the namespace disagree", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX")],
      bare: "ohmail/_meta",
      namespaces: [{ prefix: "INBOX.", delimiter: "." }],
    });
    expect(at.row).toBeNull();
    expect(at.path).toBe("INBOX.ohmail._meta");
  });

  /**
   * A prefix the client did not delimiter-terminate. RFC 2342 §5 lets a namespace report a NIL
   * delimiter, and imapflow only appends one when it has one, so `INBOX` arrives bare.
   */
  it("terminates a prefix the client left unterminated", () => {
    const at = resolveMetaFolder({
      list: [row("INBOX"), row("INBOX.ohmail._meta")],
      bare: "ohmail._meta",
      namespaces: [{ prefix: "INBOX", delimiter: null }],
    });
    expect(at.path).toBe("INBOX.ohmail._meta");
  });

  it("creates under the declared prefix when nothing is there yet", () => {
    const at = resolveMetaFolder({
      list: [{ path: "INBOX", delimiter: "." }],
      bare: "ohmail._meta",
      namespaces: [{ prefix: "INBOX.", delimiter: "." }],
    });
    expect(at.row).toBeNull();
    expect(at.path).toBe("INBOX.ohmail._meta");
  });

  it("creates at the root on a server with no prefix", () => {
    const at = resolveMetaFolder({ list: [{ path: "INBOX", delimiter: "/" }], bare: "ohmail/_meta" });
    expect(at.row).toBeNull();
    expect(at.path).toBe("ohmail/_meta");
  });
});

// ── LAYER 2: the peek, against a server that prefixes ───────────────────────────────────────

const PREFIXED = { prefix: "INBOX.", delimiter: ".", folders: ["INBOX.ohmail._meta"] } as const;

describe("the pre-consent peek finds the holder under a namespace prefix", () => {
  for (const [label, opts] of [
    ["prefixed, `.` delimiter", { prefix: "INBOX.", delimiter: ".", folders: ["INBOX.ohmail._meta"] }],
    ["prefixed, `/` delimiter", { prefix: "INBOX/", delimiter: "/", folders: ["INBOX/ohmail/_meta"] }],
    ["unprefixed, `.` delimiter", { prefix: "", delimiter: ".", folders: ["ohmail._meta"] }],
    ["unprefixed, `/` delimiter", { prefix: "", delimiter: "/", folders: ["ohmail/_meta"] }],
  ] as const) {
    it(`reports the live holder — ${label}`, async () => {
      const server = memoryImapServer(opts);
      const toServerPath = (c: string): string => c.split("/").join(opts.delimiter);
      server.seed(opts.folders[0]!, formatClaim({
        authorizedAt: null, capabilities: [],
        installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
        heartbeat: NOW, claimedAt: new Date(NOW.getTime() - 3_600_000), nonce: "n-1",
      }));

      const peek = await readLeasePeek({ io: makeLeasePeekIo(server, toServerPath), now: NOW });

      expect(peek.state).toBe("held");
      expect(peek.holders).toHaveLength(1);
      expect(peek.holders[0]!.displayName).toBe("ohmail Cloud");
      expect(peek.holders[0]!.kind).toBe("cloud");
      expect(peek.holders[0]!.fresh).toBe(true);
      // A PEEK WRITES NOTHING. The narrowness of `LeasePeekIo` is the enforcement; this is the
      // observation that proves it against a server that records every command.
      expect(server.log.filter((c) => /^(create|append|delete|unsubscribe) /.test(c))).toEqual([]);
    });

    it(`still reports NOBODY when the folder is genuinely absent — ${label}`, async () => {
      const server = memoryImapServer({ ...opts, folders: [] });
      const toServerPath = (c: string): string => c.split("/").join(opts.delimiter);
      const peek = await readLeasePeek({ io: makeLeasePeekIo(server, toServerPath), now: NOW });
      expect(peek.state).toBe("none");
      expect(peek.holders).toEqual([]);
      expect(server.log.filter((c) => c.startsWith("create"))).toEqual([]);
    });
  }

  /**
   * "I could not look" must never render as "nobody holds it" — §3.4. An unresolvable folder is
   * the newest way to reach that question, so it is answered the same way every other IO failure
   * is: a `LeaseUnavailableError`, not an empty list.
   */
  it("an AMBIGUOUS folder is `could not look`, not `nobody`", async () => {
    const server = memoryImapServer({ ...PREFIXED, folders: ["INBOX.ohmail._meta", "ohmail._meta"] });
    const io = makeLeasePeekIo(server, (c) => c.split("/").join("."));
    await expect(readLeasePeek({ io, now: NOW })).rejects.toBeInstanceOf(LeaseUnavailableError);
  });
});

// ── LAYER 3: the consented path and the peek agree ──────────────────────────────────────────

describe("a claim written by the gate is read by the peek — under a prefix", () => {
  for (const [label, opts] of [
    ["`.` delimiter", { prefix: "INBOX.", delimiter: "." }],
    ["`/` delimiter", { prefix: "INBOX/", delimiter: "/" }],
  ] as const) {
    it(`round-trips on a server that prefixes (${label})`, async () => {
      const server = memoryImapServer(opts);
      const toServerPath = (c: string): string => c.split("/").join(opts.delimiter);

      const gate = await runLeaseGate({ capabilities: [], io: makeLeaseIo(server, toServerPath, TEST_META_ID), self: selfOf("kitchen-mac"), now: NOW });
      expect(gate.verdict.verdict).toBe("organize");

      // The gate created it where the SERVER files it, and there is exactly one such folder.
      const meta = [...server.tree.keys()].filter((p) => p.endsWith(toServerPath(META_FOLDER)));
      expect(meta).toEqual([`${opts.prefix}${toServerPath(META_FOLDER)}`]);

      const peek = await readLeasePeek({ io: makeLeasePeekIo(server, toServerPath), now: NOW });
      expect(peek.state).toBe("held");
      expect(peek.holders[0]!.displayName).toBe("kitchen-mac machine");
    });
  }

  /**
   * A SERVER THAT DOES NOT FORGIVE. The live Dovecot resolves an unprefixed name on CREATE and
   * SELECT, which is the only reason the write path worked while the read path did not — so a
   * guard run only against a forgiving server cannot tell a real resolution from a lucky one.
   * Here the unprefixed spelling is refused outright.
   */
  it("addresses the prefixed folder on a server that REFUSES the unprefixed name", async () => {
    const server = memoryImapServer({ ...PREFIXED, folders: ["INBOX.ohmail._meta"], strictPrefix: true });
    const toServerPath = (c: string): string => c.split("/").join(".");
    server.seed("INBOX.ohmail._meta", formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: NOW, claimedAt: NOW, nonce: "n-2",
    }));

    const peek = await readLeasePeek({ io: makeLeasePeekIo(server, toServerPath), now: NOW });
    expect(peek.state).toBe("held");

    // And the WRITE side too: the gate must stand this install down against that claim, which it
    // can only do having read the same folder.
    const gate = await runLeaseGate({ capabilities: [], io: makeLeaseIo(server, toServerPath, TEST_META_ID), self: selfOf("laptop"), now: NOW });
    expect(gate.verdict.verdict).toBe("stand_down");
  });

  /**
   * The folder is already there under the prefix, so nothing is created. Before the resolution
   * this issued a CREATE on every cycle — caught as "already exists" and invisible — plus an
   * UNSUBSCRIBE of a folder the server had never subscribed.
   */
  it("does not re-create an existing prefixed folder on every cycle", async () => {
    const server = memoryImapServer({ ...PREFIXED, folders: ["INBOX.ohmail._meta"] });
    const io = makeLeaseIo(server, (c) => c.split("/").join("."), TEST_META_ID);
    await io.ensureMetaFolder();
    await io.ensureMetaFolder();
    expect(server.log.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(server.log.filter((c) => c.startsWith("unsubscribe"))).toEqual([]);
  });

  /**
   * The server names the folder it made, and that answer is truer than any derivation — the same
   * rule `ImapAdapter.createFolder` follows. Without adopting it, the APPEND one line later
   * addresses a name the server has to forgive a second time.
   */
  it("adopts the path the server reports from CREATE", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", delimiter: "." });
    const io = makeLeaseIo(server, (c) => c.split("/").join("."), TEST_META_ID);
    await io.ensureMetaFolder();
    await io.appendClaim(formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "x", kind: "local", displayName: "X", heartbeat: NOW, claimedAt: NOW, nonce: "n-3",
    }));
    expect(server.log).toContain("create INBOX.ohmail._meta");
    expect(server.log).toContain("append INBOX.ohmail._meta");
    expect(server.tree.get("INBOX.ohmail._meta")?.messages).toHaveLength(1);
  });
});

// ── LAYER 4: the profile shares the folder, so it shares the resolution ─────────────────────

describe("the organizer profile resolves the same folder", () => {
  it("reads back a profile written under a prefix", async () => {
    const server = memoryImapServer(PREFIXED);
    const io = makeProfileIo(server, (c) => c.split("/").join("."), TEST_META_ID);
    await writeOrganizerProfile({
      io, installId: "kitchen-mac",
      doc: makeProfileDoc(
        {
          screener: [{ address: "anna@example.com", name: "Anna" }],
          rules: [], notifyRules: [], awayResponder: null, tagNames: [],
          signature: null,
        },
        { updatedAt: NOW, producer: { kind: "local", version: "test" } },
      ),
    });
    expect(server.log.filter((c) => c.startsWith("append"))).toEqual(["append INBOX.ohmail._meta"]);
    const read = await readOrganizerProfile(makeProfileIo(server, (c) => c.split("/").join("."), TEST_META_ID));
    expect(read.state).toBe("found");
  });
});

// ── LAYER 5: the census — one resolution, and no way back to string equality ────────────────

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  TWO ADAPTERS, ONE MAILBOX, DIFFERENT ANSWERS — LEASE-PEEK-ENGINE-ADAPTER-BLIND
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT WAS SEEN ─────────────────────────────────────────────────────────────────────────
 *
 * On one live mailbox, in ONE process, against the same host and credentials: a FRESH
 * `ImapAdapter` peeked and answered `state=held holders=1` (the Cloud organizer, heartbeat
 * current), while the engine's own long-lived adapter answered `state=none holders=0` — twice,
 * before and after a drain. Only the adapter instance differed.
 *
 * ── WHAT ACTUALLY DIFFERED ────────────────────────────────────────────────────────────────
 *
 * `toServerPath`, and through it `metaAlphabet`'s idea of the delimiter. `ImapAdapter` starts at
 * `delimiter = "/"` and `toServerPath` short-circuits on `"/"`, returning the canonical name
 * UNCHANGED — so an adapter that has not learned its delimiter, or learned the `"/"` fallback
 * from a LIST that carried none, hands the resolver `ohmail/_meta` on a server that spells it
 * `INBOX.ohmail._meta`.
 *
 * That alone was survivable, and this is the part worth keeping: `metaAlphabet` re-spells `bare`
 * from the FIRST personal namespace's delimiter, so a server that answers NAMESPACE is repaired.
 * It took BOTH — an unlearned delimiter AND a client with no namespaces — and the second is
 * documented in `resolveOhmailFolder` as reachable in production, because `ImapFlow`'s own
 * NAMESPACE handler can swallow a throw and leave the connection with none.
 *
 * Measured across the four combinations before the fix: `.`/ns, `.`/no-ns and `/`/ns all
 * resolved; `/`/no-ns alone returned "absent". Below, both halves are driven, and the
 * combination is the second case.
 *
 * ── WHAT THE LIVE RE-MEASURE DID AND DID NOT SHOW ─────────────────────────────────────────
 *
 * Read-only against the reported mailbox, on a FRESH connection: the server answers NAMESPACE
 * (`personal[0] = { prefix: "INBOX.", delimiter: "." }`), its LIST rows carry `.`, and it holds
 * `INBOX.ohmail._meta` beside the five watched folders. Both mappings — learned and unlearned —
 * resolved to `INBOX.ohmail._meta` and both peeked `state=held holders=1`.
 *
 * So the live `none` was NOT reproduced from a fresh connection, and could not be: a fresh one
 * gets namespaces, and namespaces alone repair the unlearned delimiter. That is consistent with
 * the report — the FRESH adapter was the half that worked. It also means the engine's adapter
 * must have been peeking through a client with NO namespaces, which is the ImapFlow failure
 * `resolveOhmailFolder` already documents. This fix removes the OTHER half of the conjunction,
 * so the resolution no longer depends on that client ever having answered: a LIST row's
 * delimiter is enough, and this server's LIST always carries one.
 *
 * ── WHY IT WAS THE WORST AVAILABLE FAILURE ────────────────────────────────────────────────
 *
 * `makeLeasePeekIo` reads an unresolved folder as ZERO CLAIMS — the truth when it is genuinely
 * absent — so the peek reported `none` for a mailbox another install was actively organizing.
 * A wrong ANSWER, not a refusal, in the one place this file insists the two stay unreachable
 * from one another (§3.4). The fix is in the resolution's precedence: the LIST row's delimiter
 * is the SERVER's statement and now outranks a spelling the adapter may never have made.
 */
describe("one adapter instance must answer what a fresh one answers", () => {
  /* The engine's long-lived adapter, exactly: `delimiter` still `"/"`, so `toServerPath` returns
     the canonical unchanged. Not a contrivance — it is `ImapAdapter.toServerPath`'s own
     short-circuit, reached by every adapter that has not learned a delimiter. */
  const unlearned = (c: string): string => c;
  /** A connected adapter on the same server: the mapping the delimiter would have produced. */
  const learned = (c: string): string => c.split("/").join(".");

  const held = (server: ReturnType<typeof memoryImapServer>, at: string): void => {
    server.seed(at, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: NOW, claimedAt: new Date(NOW.getTime() - 3_600_000), nonce: "n-1",
    }));
  };

  for (const [label, announceNamespace] of [
    ["the server answers NAMESPACE", true],
    ["the server answers NO NAMESPACE — the combination that was live", false],
  ] as const) {
    it(`both adapters see the same holder — ${label}`, async () => {
      const opts = {
        prefix: "INBOX.", delimiter: ".", folders: ["INBOX.ohmail._meta"], announceNamespace,
      } as const;

      const fresh = memoryImapServer(opts);
      held(fresh, "INBOX.ohmail._meta");
      const a = await readLeasePeek({ io: makeLeasePeekIo(fresh, learned), now: NOW });

      const engine = memoryImapServer(opts);
      held(engine, "INBOX.ohmail._meta");
      const b = await readLeasePeek({ io: makeLeasePeekIo(engine, unlearned), now: NOW });

      // The claim in the row's own words: only the adapter instance differed.
      expect(a.state, "the fresh adapter could not see the holder either").toBe("held");
      expect(
        b.state,
        "the long-lived adapter reported a mailbox as UNHELD while another install organizes it",
      ).toBe("held");
      expect(b.holders.map((h) => h.displayName)).toEqual(a.holders.map((h) => h.displayName));
      expect(b.holders[0]!.kind).toBe("cloud");
      expect(b.holders[0]!.fresh).toBe(true);
      // Still a read. An adapter that repaired itself by CREATING the folder would be worse than
      // the defect: two organizers, and a lease folder minted by the party that could not find it.
      expect(engine.log.filter((c) => /^(create|append|delete|unsubscribe) /.test(c))).toEqual([]);
    });
  }

  it("and an ABSENT folder is still NOBODY, on the same unlearned adapter", async () => {
    // The negative control. Without it, a resolution that answered "held" for everything would
    // pass the two cases above — and "nobody" is the answer a genuinely free mailbox needs.
    const server = memoryImapServer({
      prefix: "INBOX.", delimiter: ".", folders: [], announceNamespace: false,
    });
    const peek = await readLeasePeek({ io: makeLeasePeekIo(server, unlearned), now: NOW });
    expect(peek.state).toBe("none");
    expect(peek.holders).toEqual([]);
    expect(server.log.filter((c) => c.startsWith("create"))).toEqual([]);
  });
});

describe("SOURCE CENSUS — nothing builds the meta path by string equality", () => {
  /**
   * COMMENTS ARE NOT CODE, and this file is full of prose that names the very pattern being
   * banned — including the paragraph explaining why it was banned. A census that read the raw
   * bytes would be red on its own documentation, which is how a guard gets weakened to make it
   * pass. So the source is stripped of comments first and the assertions run on what executes.
   */
  const code = (name: string): string => readFileSync(resolvePath(__dirname, "../../src/adapters", name), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

  /**
   * `toServerPath(META_FOLDER)` answers what the folder is CALLED. Turning that into a path to
   * ADDRESS is `makeMetaFolderRef`'s job and nobody else's — the defect was one function doing it
   * for itself, and the fix is only durable while a second one cannot.
   */
  it("`toServerPath(META_FOLDER)` is evaluated in exactly one place", () => {
    const hits = ["organizer-lease.ts", "organizer-profile.ts", "imap.ts"].flatMap((name) =>
      [...code(name).matchAll(/toServerPath\(\s*META_FOLDER\s*\)/g)].map(() => name));
    expect(hits).toEqual(["organizer-lease.ts"]);

    const lease = code("organizer-lease.ts");
    expect(lease.slice(lease.indexOf("export function makeMetaFolderRef(")))
      .toMatch(/toServerPath\(META_FOLDER\)/);
  });

  /**
   * And the pattern itself. ONE function is permitted to compare a LIST row's path, because it is
   * the one that also knows what a namespace prefix is.
   *
   * That function is now `resolveOhmailFolder`. The rule has not moved and the window is still
   * exactly one function — only the name has changed, because the resolution was generalised from
   * `ohmail/_meta` to any one of our folders when `ImapAdapter.ensureFolders` turned out to have
   * this defect in the same shape (it matched `OHMAIL_FOLDERS` by string equality, so a prefixed
   * server re-CREATEd all five on every connect). `resolveMetaFolder` survives as the wrapper that
   * binds the canonical name, and holds no comparison of its own.
   */
  it("no LIST row is matched by `.path ===` outside the resolver", () => {
    for (const name of ["organizer-lease.ts", "organizer-profile.ts"]) {
      const src = code(name);
      const start = src.indexOf("export function resolveOhmailFolder(");
      const end = start === -1 ? -1 : src.indexOf("\n}\n", start) + 2;
      for (const m of src.matchAll(/\.path\s*===/g)) {
        expect(
          start !== -1 && m.index! > start && m.index! < end,
          `${name}:${src.slice(0, m.index).split("\n").length} compares a folder path for equality `
          + "outside resolveOhmailFolder",
        ).toBe(true);
      }
    }
  });

  /** Both IO factories go through the ref — a new one that forgets is red here. */
  it("every `_meta` IO factory addresses the folder through the shared ref", () => {
    const lease = code("organizer-lease.ts");
    const profile = code("organizer-profile.ts");
    for (const [src, fn] of [[lease, "makeLeaseIo"], [lease, "makeLeasePeekIo"], [profile, "makeProfileIo"]] as const) {
      const body = src.slice(src.indexOf(`export function ${fn}(`));
      expect(body.slice(0, body.indexOf("\n}\n")), `${fn} must resolve through makeMetaFolderRef`)
        .toMatch(/makeMetaFolderRef\(/);
    }
  });
});
