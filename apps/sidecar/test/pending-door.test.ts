import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdoptedDoor, DoorFileError } from "../src/adopted-door.js";
import { enforceMirrorOwner, MIRROR_OWNER_FILE, readMirrorOwner } from "../src/cloud-engine.js";
import { cloudConfigFromEnv } from "../src/main.js";

/**
 * THE PENDING DOOR'S THREE PIECES THAT NEED NO ENGINE: the environment that says "identity
 * pending" rather than an empty address, the door file its first claim CREATES once, and the
 * mirror-owner record a pending launch must not wipe. The engine-level walk is
 * `slow/cloud-approval-adopt.test.ts`.
 */

const HOSTED = "https://api.ohmail.app";
const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-pending-door-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { chmodSync(d, 0o700); } catch { /* already writable */ }
    rmSync(d, { recursive: true, force: true });
  }
});

describe("the door file a pending claim creates", () => {
  it("is created once, private, in the shape the shell reads, with no staging file left", () => {
    const dir = tempDir();
    const door = join(dir, "config.json");
    expect(createAdoptedDoor(door, HOSTED, "mila@ohmail.test")).toBe("created");
    expect(JSON.parse(readFileSync(door, "utf8"))).toEqual({ mode: "cloud", cloudUrl: HOSTED, address: "mila@ohmail.test" });
    if (process.platform !== "win32") expect(statSync(door).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["config.json"]);
    // A retried claim for the same account finds its own door and is not refused.
    expect(createAdoptedDoor(door, HOSTED, "  Mila@ohmail.test ")).toBe("same");
  });

  it("never replaces a door somebody chose during the wait, readable or not", () => {
    for (const other of [
      JSON.stringify({ mode: "local", imap: { host: "imap.example.test", user: "someone" } }),
      JSON.stringify({ mode: "cloud", cloudUrl: HOSTED, address: "other@ohmail.test" }),
      "{ torn",
    ]) {
      const dir = tempDir();
      const door = join(dir, "config.json");
      writeFileSync(door, other);
      let caught: unknown = null;
      try { createAdoptedDoor(door, HOSTED, "mila@ohmail.test"); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(DoorFileError);
      expect((caught as DoorFileError).code).toBe("door_changed");
      expect(readFileSync(door, "utf8")).toBe(other);
      expect(readdirSync(dir)).toEqual(["config.json"]);
    }
  });

  it("says it could not save, by code, when the folder refuses the write", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const dir = tempDir();
    chmodSync(dir, 0o500);
    let caught: unknown = null;
    try { createAdoptedDoor(join(dir, "config.json"), HOSTED, "mila@ohmail.test"); } catch (err) { caught = err; }
    expect((caught as DoorFileError).code).toBe("door_not_saved");
    expect((caught as DoorFileError).message).not.toContain(dir);
  });
});

describe("a pending launch keeps the mirror owner it finds", () => {
  function owned(dir: string, owner: string, base = HOSTED): void {
    mkdirSync(join(dir, "pgdata"), { recursive: true });
    writeFileSync(join(dir, "pgdata", "PG_VERSION"), "17\n");
    writeFileSync(join(dir, MIRROR_OWNER_FILE), JSON.stringify({ address: owner, base, account: null }));
  }

  it("a directory another account owns still names that account after a pending launch", () => {
    const dir = tempDir();
    owned(dir, "first@ohmail.test");
    expect(enforceMirrorOwner(dir, null, HOSTED, undefined, { identityPending: true })).toBe(false);
    expect(existsSync(join(dir, "pgdata"))).toBe(true);
    // The claim compares against this: a record rewritten as nobody's would be ADOPTED by B.
    expect(readMirrorOwner(dir)).toBe("first@ohmail.test");
  });

  it("the control: an address-less launch that is NOT pending (the paired door) names nobody", () => {
    const dir = tempDir();
    owned(dir, "first@ohmail.test");
    enforceMirrorOwner(dir, null, HOSTED);
    expect(readMirrorOwner(dir)).toBeNull();
  });

  it("a mirror from another server is discarded and the pending record names nobody", () => {
    const dir = tempDir();
    owned(dir, "first@example.com", "https://ohmail.example.com/api");
    expect(enforceMirrorOwner(dir, null, HOSTED, undefined, { identityPending: true })).toBe(true);
    expect(existsSync(join(dir, "pgdata"))).toBe(false);
    expect(readMirrorOwner(dir)).toBeNull();
  });
});

describe("the environment says identity pending, never an empty address", () => {
  const base = {
    OHMAIL_MODE: "cloud", OHMAIL_DATA_DIR: "/tmp/does-not-need-to-exist", OHMAIL_CLOUD_URL: HOSTED,
  };

  it("the pending door carries no address and its door file", () => {
    const cfg = cloudConfigFromEnv({ ...base, OHMAIL_IDENTITY_PENDING: "1", OHMAIL_DOOR_FILE: "/tmp/x/config.json" });
    expect(cfg.address).toBeNull();
    expect(cfg.identityPending).toEqual({ doorFile: "/tmp/x/config.json" });
  });

  it("a flag beside an address or a pin, or without its door file, refuses to launch", () => {
    const pending = { ...base, OHMAIL_IDENTITY_PENDING: "1", OHMAIL_DOOR_FILE: "/tmp/x/config.json" };
    expect(() => cloudConfigFromEnv({ ...pending, OHMAIL_MAILBOX_ADDRESS: "mila@ohmail.test" })).toThrow(/stale/);
    expect(() => cloudConfigFromEnv({ ...pending, OHMAIL_HOST_PIN: "A".repeat(43) })).toThrow(/stale/);
    expect(() => cloudConfigFromEnv({ ...base, OHMAIL_IDENTITY_PENDING: "1" })).toThrow(/OHMAIL_DOOR_FILE/);
  });

  it("only the exact flag is the pending door: a near miss is an ordinary door and wants its address", () => {
    const saved = process.env.OHMAIL_MAILBOX_ADDRESS;
    delete process.env.OHMAIL_MAILBOX_ADDRESS;
    try {
      for (const nearMiss of ["true", "yes", "0", " 1"]) {
        expect(() => cloudConfigFromEnv({ ...base, OHMAIL_IDENTITY_PENDING: nearMiss, OHMAIL_DOOR_FILE: "/tmp/x" }))
          .toThrow(/OHMAIL_MAILBOX_ADDRESS/);
      }
      const hosted = cloudConfigFromEnv({ ...base, OHMAIL_MAILBOX_ADDRESS: "mila@ohmail.test" });
      expect(hosted.identityPending).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.OHMAIL_MAILBOX_ADDRESS = saved;
    }
  });
});
