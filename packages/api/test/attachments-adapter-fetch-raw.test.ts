import { describe, it, expect, vi, afterEach } from "vitest";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { FORWARD_MAX_RAW_BYTES } from "@trafficflow/services/mail";
import { makeOpenAdapter } from "../src/attachments-adapter.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * `makeOpenAdapter` exposes `fetchRaw`, bound to the ImapAdapter, under the same clock and teardown
 * as `fetchPart`. A forward whose stored words were let go reads the whole original through it;
 * without the pass-through that forward refuses on every host, and dropping the ceiling here would
 * leave FORWARD_MAX_RAW_BYTES enforced nowhere that can stop a read.
 */
const locator = { folder: "INBOX", ref: "1:7" } as const;

// The creds lookup + decrypt and an always-admitting connection counter, as in the seam file.
function fakeDeps(): ApiDeps {
  const row = {
    transport: "imap",
    secretEnc: Buffer.from("enc"),
    keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u@example.invalid" },
  };
  return {
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
      // `acquireImapSlot`: returns a post-increment count of 1, i.e. "admitted".
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{ failures: 1 }]) }),
        }),
      }),
      // `releaseImapSlot`: accepted and discarded.
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    },
    keyProvider: { decrypt: async () => "secret-not-printed" },
    // The cap is an injected port now. Always-admit, because this file is about what `fetchPart`
    // options reach the ImapAdapter; the cap has its own file (`attachments-imap-cap.at2`),
    // which passes the REAL counter.
    services: { imapAdmission: { acquire: async () => true, release: async () => {} } },
  } as unknown as ApiDeps;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("makeOpenAdapter forwards fetchRaw", () => {
  it("passes the locator and the service's ceiling through to the ImapAdapter", async () => {
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    const raw = new Uint8Array([1, 2, 3]);
    const fetchRaw = vi.spyOn(ImapAdapter.prototype, "fetchRaw").mockResolvedValue(raw);

    const handle = await makeOpenAdapter(fakeDeps())("mailbox-1");
    expect(typeof handle.fetchRaw).toBe("function");
    await expect(handle.fetchRaw!(locator, { maxBytes: FORWARD_MAX_RAW_BYTES })).resolves.toBe(raw);
    expect(fetchRaw).toHaveBeenCalledWith(locator, { maxBytes: FORWARD_MAX_RAW_BYTES });
  });

  it("a throw destroys the socket and latches: the later close() sends no LOGOUT", async () => {
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
    const close = vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    const forceClose = vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => undefined);
    vi.spyOn(ImapAdapter.prototype, "fetchRaw").mockRejectedValue(new Error("read failed"));

    const handle = await makeOpenAdapter(fakeDeps())("mailbox-1");
    await expect(handle.fetchRaw!(locator, { maxBytes: 10 })).rejects.toThrow("read failed");
    expect(forceClose).toHaveBeenCalledTimes(1);
    await handle.close();
    expect(close).not.toHaveBeenCalled();
  });
});
