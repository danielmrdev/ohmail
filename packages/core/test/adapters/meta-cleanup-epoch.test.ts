import { describe, expect, it } from "vitest";

import { memoryImapServer } from "./_metaworld.js";
import {
  CLAIM_PROTOCOL, META_FOLDER, REQUEST_PROTOCOL, RequestUnavailableError,
  formatAck, formatClaim, formatRequest, makeRequestOrganizerIo, signRequest,
} from "../../src/adapters/organizer-lease.js";
import {
  ProfileUnavailableError, formatProfileMessage, makeProfileDoc, makeProfileIo, writeOrganizerProfile,
} from "../../src/adapters/organizer-profile.js";

/**
 * ═══ THE THREE `ohmail/_meta` CLEANUPS TAKE ONE RULE ═══════════════════════════════════════
 *
 * A remembered uid is a fact only under the UIDVALIDITY that issued it. `removeClaims` has
 * checked that since its own slice (`organizer-lease-remove-claims.test.ts`); the request drain's
 * `remove` and the settings cleanup's `removeProfiles` did not, and both delete by uid from a
 * list a much earlier read produced. Between that read and the delete the folder can be replaced
 * — a customer clearing `ohmail/_meta`, a restore, a migration — and the numbers then name
 * whatever sits at them now: another install's pending request, somebody else's settings.
 *
 * Both arms of the rule are watched here, and the fail-OPEN arm is deliberate: refusing on an
 * unprovable epoch would strand every mailbox on a connection that never states one, with the
 * custody read-back as the backstop a proof cannot supply. Only a PROVEN contradiction refuses.
 */

const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");
const TEST_META_ID = { installId: "us", mailboxId: "22222222-2222-4222-8222-222222222222" };
const MAILBOX = TEST_META_ID.mailboxId;
const KEY = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";
const NOW = new Date("2026-09-14T09:00:00.000Z");

/** One reader's pending request, as the format layer writes one. */
function requestRaw(requestId: string, installId: string): string {
  const envelope = {
    protocol: REQUEST_PROTOCOL, requestId, kind: "screener.decide" as const,
    mailboxId: MAILBOX, installId, organizerKind: "cloud" as const, decidedAt: NOW,
    payload: { scope: "sender", decision: "yes", address: "person@example.com" },
  };
  return formatRequest({ ...envelope, key: KEY });
}

function ackRaw(requestId: string): string {
  return formatAck({
    requestId, mailboxId: MAILBOX, outcome: "applied", ackedAt: NOW, key: KEY,
  });
}

function claimRaw(installId: string): string {
  return formatClaim({
    protocol: CLAIM_PROTOCOL, installId, kind: "local", displayName: `${installId} machine`,
    claimedAt: NOW, heartbeat: NOW, nonce: `n-${installId}`, authorizedAt: null, capabilities: [],
  });
}

/** A settings document, as the format layer writes one. */
function profileDoc(marker: string): string {
  return [
    "X-Ohmail-Profile: 1",
    "X-Ohmail-Profile-Version: 1",
    `X-Ohmail-Install-Id: ${marker}`,
    "Subject: ohmail settings",
    "",
    marker,
    "",
  ].join("\r\n");
}

/** The signature helper is only referenced so an unused import cannot hide a format change. */
void signRequest;
void claimRaw;

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("the request drain's expunge and the folder's numbering", () => {
  /**
   * SOMEBODY ELSE'S PENDING PRESS. The drain reads the folder, settles what it found, and
   * expunges by uid; `ohmail/_meta` is recreated in between and a reader on another computer
   * appends a request, which lands at uid 1. The old list names uid 1 too. Deleting it erases a
   * button a person pressed — the reader is never told it was refused, because it was not: it was
   * silently removed and will simply never happen.
   */
  it("REFUSES a proven renumbering, and another install's request survives", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, requestRaw("11111111-1111-4111-8111-111111111111", "us"));
    const io = makeRequestOrganizerIo(server, toServerPath, TEST_META_ID);

    // The read is what samples the generation the refs belong to.
    const records = (await io.listMetaRecords()).records;
    expect(records).toHaveLength(1);

    server.renumber(META);
    server.seed(META, requestRaw("33333333-3333-4333-8333-333333333333", "other-install"));

    const err = await io.remove(records.map((r) => r.ref)).then(() => null, (e: unknown) => e);
    expect(err, "a stale list was used to delete by uid").toBeInstanceOf(RequestUnavailableError);
    expect((err as Error).message).toContain(META_FOLDER);

    const left = server.tree.get(META)!.messages.map((m) => m.raw).join("\n");
    expect(left, "another computer's pending request was expunged by uid coincidence")
      .toContain("other-install");
  });

  /** The same rule over the ack sweep, which reaches `remove` by the other call site. */
  it("REFUSES a proven renumbering on the stale-ack path too", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, ackRaw("11111111-1111-4111-8111-111111111111"));
    const io = makeRequestOrganizerIo(server, toServerPath, TEST_META_ID);
    const records = (await io.listMetaRecords()).records;

    server.renumber(META);
    server.seed(META, requestRaw("33333333-3333-4333-8333-333333333333", "other-install"));

    await expect(io.remove(records.map((r) => r.ref)))
      .rejects.toBeInstanceOf(RequestUnavailableError);
    expect(server.tree.get(META)!.messages.map((m) => m.raw).join("\n"))
      .toContain("other-install");
  });

  /** THE POSITIVE CONTROL: an ordinary cleanup in a stable epoch still removes what it should. */
  it("removes what it read when the generation is KNOWN and UNCHANGED", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, requestRaw("11111111-1111-4111-8111-111111111111", "us"));
    const io = makeRequestOrganizerIo(server, toServerPath, TEST_META_ID);
    const records = (await io.listMetaRecords()).records;

    await expect(io.remove(records.map((r) => r.ref))).resolves.toBeUndefined();
    expect(server.tree.get(META)!.messages,
      "the refusal fired on a folder nothing happened to").toHaveLength(0);
  });

  /**
   * THE DECIDED FAIL-OPEN ARM, the same one `removeClaims` takes: a connection that never states
   * a UIDVALIDITY proves nothing, and refusing would make the drain impossible there for ever.
   */
  it("PROCEEDS when the connection hides the generation", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, requestRaw("11111111-1111-4111-8111-111111111111", "us"));
    const blind = new Proxy(server, {
      get(target, prop, recv) {
        if (prop === "mailbox") {
          const m = Reflect.get(target, prop, recv) as { exists?: number } | false;
          return m === false ? false : { exists: m.exists };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof server;

    const io = makeRequestOrganizerIo(blind, toServerPath, TEST_META_ID);
    const records = (await io.listMetaRecords()).records;
    await expect(io.remove(records.map((r) => r.ref)),
      "a drain became impossible on a connection that never reports the generation")
      .resolves.toBeUndefined();
    expect(server.tree.get(META)!.messages).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("the settings cleanup and the folder's numbering", () => {
  /**
   * `RawProfileMessage` has carried its `generation` since mail 0094 — and the cleanup threw it
   * away: `writeOrganizerProfile` maps the records to bare refs and `removeProfiles` compared
   * nothing. So the one path that already HAD the epoch in hand was the one that discarded it.
   */
  it("REFUSES a proven renumbering, and a stranger's document survives", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, profileDoc("ours-before-the-renumber"));
    const io = makeProfileIo(server, toServerPath, TEST_META_ID);

    const records = await io.listProfileMessages();
    expect(records).toHaveLength(1);

    server.renumber(META);
    server.seed(META, profileDoc("a-stranger"));

    const err = await io.removeProfiles(records.map((r) => r.ref))
      .then(() => null, (e: unknown) => e);
    expect(err, "a stale list was used to delete by uid").toBeInstanceOf(ProfileUnavailableError);
    expect((err as Error).message).toContain(META_FOLDER);

    expect(server.tree.get(META)!.messages.map((m) => m.raw).join("\n"),
      "a stranger's settings document was expunged by uid coincidence").toContain("a-stranger");
  });

  /** THE POSITIVE CONTROL: cleanup in a stable epoch still prunes the older copies. */
  it("removes what it read when the generation is KNOWN and UNCHANGED", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, profileDoc("an-older-copy"));
    const io = makeProfileIo(server, toServerPath, TEST_META_ID);
    const records = await io.listProfileMessages();

    await expect(io.removeProfiles(records.map((r) => r.ref))).resolves.toBeUndefined();
    expect(server.tree.get(META)!.messages).toHaveLength(0);
  });

  /** The fail-open arm, for the reason the request half states. */
  it("PROCEEDS when the connection hides the generation", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, profileDoc("an-older-copy"));
    const blind = new Proxy(server, {
      get(target, prop, recv) {
        if (prop === "mailbox") {
          const m = Reflect.get(target, prop, recv) as { exists?: number } | false;
          return m === false ? false : { exists: m.exists };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof server;

    const io = makeProfileIo(blind, toServerPath, TEST_META_ID);
    const records = await io.listProfileMessages();
    await expect(io.removeProfiles(records.map((r) => r.ref))).resolves.toBeUndefined();
    expect(server.tree.get(META)!.messages).toHaveLength(0);
  });

  /**
   * AND THE WRITE PATH CARRIES ON. `writeOrganizerProfile` logs a failed cleanup and returns
   * `written: true` — the new document IS in the folder — so a refusal here must not turn into a
   * rewrite loop. The refusal is reported, the write stands, and nothing of the stranger's goes.
   */
  it("leaves the new document standing when the cleanup refuses across an epoch", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    /* A READABLE document of ours: the write removes only the current document it replaces, so
       the cleanup that must refuse across the renumber is that one. */
    server.seed(META, formatProfileMessage(makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["before"], signature: null },
      { updatedAt: new Date(NOW.getTime() - 60_000), producer: { kind: "cloud", version: "test" } },
    ), { installId: "us" }));
    const io = makeProfileIo(server, toServerPath, TEST_META_ID);
    const lines: string[] = [];

    // The folder is replaced between the read this write takes and the cleanup at its end.
    const staged = {
      ...io,
      appendProfile: async (raw: string): Promise<void> => {
        server.renumber(META);
        server.seed(META, profileDoc("a-stranger"));
        await io.appendProfile(raw);
      },
    };

    const out = await writeOrganizerProfile({
      io: staged, installId: "us", log: (event: string): void => { lines.push(event); },
      doc: makeProfileDoc(
        { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null },
        { updatedAt: NOW, producer: { kind: "cloud", version: "test" } },
      ),
    });

    expect(out.written, "a refused cleanup was reported as a failed write").toBe(true);
    if (!out.written) throw new Error("unreachable — the assertion above settles it");
    expect(out.removed).toBe(0);
    expect(out.owed, "a refused cleanup is owed to the next tidy").toBe(true);
    expect(lines).toContain("profile_cleanup_failed");
    expect(server.tree.get(META)!.messages.map((m) => m.raw).join("\n")).toContain("a-stranger");
  });
});
