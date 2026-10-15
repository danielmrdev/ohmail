import { beforeEach, describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapServer } from "./_metaworld.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import {
  DEFAULT_STALE_AFTER_MS, META_RECORDS_MAX_PER_FETCH, makeLeaseIo, runLeaseGate, type LeaseSelf,
} from "../../src/adapters/organizer-lease.js";

/**
 * ONE ORGANIZER PER MAILBOX, PAST THE 500-RECORD WINDOW. Two installs share one `ohmail/_meta`:
 * A organizes and its claim sits at a low uid; more records than the window, written by another client, land above it.
 * B's gate must still read A and stand down on every cycle while A renews, and take the mailbox
 * only once A's claim has gone stale and the person presses — after which A's own gate reads B. Exactly one holder at
 * every step. MUTATION WATCHED RED: `readMetaRecords` on the window alone (no enumeration) and B
 * claims over a live A.
 */
const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");
const t0 = new Date("2026-10-02T08:00:00.000Z");

beforeEach(() => { resetMetaMemos(); });

type Install = { self: LeaseSelf; organizing: boolean; gate(at: Date, pressedAt?: Date): Promise<string> };

function install(server: MemoryImapServer, installId: string): Install {
  const io = makeLeaseIo(server, toServerPath, { installId, mailboxId: "two-installs" });
  const me: Install = {
    self: { installId, kind: "local", displayName: installId, lastNonce: null },
    organizing: false,
    async gate(at: Date, pressedAt?: Date): Promise<string> {
      const res = await runLeaseGate({
        io, self: me.self, now: at, capabilities: ["requests"], newNonce: () => `${installId}-${at.getTime()}`,
        ...(pressedAt === undefined ? {} : { takeover: { authorizedAt: pressedAt, intent: "takeover" as const } }),
      });
      if (res.nonce !== null) me.self = { ...me.self, lastNonce: res.nonce };
      me.organizing = res.verdict.verdict === "organize";
      return res.verdict.verdict === "organize" ? "organize" : `${res.verdict.verdict}:${res.verdict.by?.installId ?? "nobody"}`;
    },
  };
  return me;
}

describe("two installs over one ohmail/_meta past the window", () => {
  it("B reads A's buried claim on every cycle, and takes the mailbox only once A has lapsed", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const a = install(server, "install-a");
    const b = install(server, "install-b");

    expect(await a.gate(t0)).toBe("organize");
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 20; i++) {
      server.seed(META, `Subject: stray ${i}\r\nX-Other-Client: 1\r\n\r\nbody`, t0);
    }
    expect(server.tree.get(META)!.messages.length).toBeGreaterThan(META_RECORDS_MAX_PER_FETCH);

    for (let cycle = 1; cycle <= 3; cycle++) {
      const at = new Date(t0.getTime() + cycle * 30_000);
      expect(await b.gate(at), `cycle ${cycle}: B claimed over a live A`).toBe("stand_down:install-a");
      expect(await a.gate(new Date(at.getTime() + 1_000))).toBe("organize");
      expect([a.organizing, b.organizing]).toEqual([true, false]);
    }

    const lapsed = new Date(t0.getTime() + 3 * 30_000 + 1_000 + DEFAULT_STALE_AFTER_MS + 60_000);
    // A lapsed claim is offered, never taken unasked; the person's press takes it.
    expect(await b.gate(lapsed)).toBe("available:install-a");
    expect(b.organizing).toBe(false);
    expect(await b.gate(new Date(lapsed.getTime() + 500), lapsed), "B never took over a lapsed claim").toBe("organize");
    expect(await a.gate(new Date(lapsed.getTime() + 1_000))).toBe("stand_down:install-b");
    expect([a.organizing, b.organizing]).toEqual([false, true]);
  });
});
