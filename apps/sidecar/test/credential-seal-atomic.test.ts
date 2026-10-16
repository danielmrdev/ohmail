import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticKeyProvider } from "@trafficflow/core";
import { loadSealedTokens, sealTokens } from "../src/cloud-auth.js";

/**
 * THE SEAL IS THE PREVIOUS COMPLETE FILE OR THE NEW COMPLETE FILE — never a prefix of either.
 *
 * `cloud-tokens.seal` is the only credential a relaunch has. Written in place, a process killed
 * mid-write left half an envelope, which `loadSealedTokens` reads as "this key does not open that
 * file" — a session lost to an interruption rather than to a refusal. `fs-atomic.ts` stages and
 * renames, so the fault below costs the ROTATION and not the session.
 */

/** Armed only for the seal's own rename, so nothing else in the process can meet it. */
let renameFaultFor: string | null = null;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: import("node:fs").PathLike, to: import("node:fs").PathLike): void => {
      if (renameFaultFor !== null && String(to) === renameFaultFor) {
        throw Object.assign(new Error("the test refused this rename"), { code: "EIO" });
      }
      actual.renameSync(from, to);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  renameFaultFor = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-seal-atomic-"));
  dirs.push(d);
  return d;
}
const aKek = (): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

describe("the token seal is written atomically", () => {
  it("a fault between the staging write and the rename leaves the OLD seal whole and readable", async () => {
    const dir = tmp();
    const path = join(dir, "cloud-tokens.seal");
    const kp = new StaticKeyProvider({ 1: aKek() });
    await sealTokens(path, kp, { accessToken: "old-access", refreshToken: "old-refresh" });
    expect(await loadSealedTokens(path, kp)).toEqual({ accessToken: "old-access", refreshToken: "old-refresh" });

    renameFaultFor = path;
    await expect(
      sealTokens(path, kp, { accessToken: "rotated", refreshToken: "new-refresh" }),
      "a seal that cannot land must REFUSE rather than report itself done",
    ).rejects.toThrow();
    renameFaultFor = null;

    // THE WHOLE POINT: the launch that follows this crash still has a credential.
    expect(
      await loadSealedTokens(path, kp),
      "the interrupted rotation must cost the rotation, never the session",
    ).toEqual({ accessToken: "old-access", refreshToken: "old-refresh" });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp")), "the staging file is cleaned up").toEqual([]);
  });

  it("an ordinary seal lands whole, private, and with nothing staged left behind", async () => {
    const dir = tmp();
    const path = join(dir, "cloud-tokens.seal");
    const kp = new StaticKeyProvider({ 1: aKek() });
    await sealTokens(path, kp, { accessToken: "a", refreshToken: "r" });

    const parsed = JSON.parse(readFileSync(path, "utf8")) as { ciphertext: string; keyVersion: number };
    expect(typeof parsed.ciphertext).toBe("string");
    expect(parsed.keyVersion).toBe(1);
    expect(statSync(path).mode & 0o777, "the mode rides the staging file, never a readable window").toBe(0o600);
    expect(readdirSync(dir)).toEqual(["cloud-tokens.seal"]);
    expect(await loadSealedTokens(path, kp)).toEqual({ accessToken: "a", refreshToken: "r" });
  });
});
