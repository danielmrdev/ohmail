import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * THE RUNTIME IS VENDORED WITHOUT A NETWORK, OR IT IS NOT VENDORED AT ALL.
 *
 * `scripts/vendor-node.mjs` fetched `SHASUMS256.txt` and the archive from nodejs.org, which a
 * sandboxed packaging build cannot do: it resolves only declared, checksummed sources, and it has
 * no network at the moment it builds. So the script gained an offline arm — `OHMAIL_NODE_ARCHIVES`
 * names a directory holding the release archives — and with the manifest out of reach the only
 * thing left to verify against is the digest list PINS carries in the script itself.
 *
 * Which makes PINS load-bearing, and a pin nobody checks is worse than no pin: it would refuse a
 * CORRECT archive on the first offline build. This file is what watches each arm.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "vendor-node.mjs");
const src = readFileSync(SCRIPT, "utf8");

/** The pinned version, read from the script rather than repeated here — this file must say what
 *  that file says, or a bump passes for a check. */
const VERSION = /export const VERSION = process\.env\.OHMAIL_NODE_VERSION \?\? "([^"]+)";/.exec(src)?.[1];

/** PINS, read the same way. The inner pattern demands a 64-hex value, so the version key that
 *  opens the block is not mistaken for an archive. */
function pinsFromSource(text: string): Map<string, string> {
  const block = /const PINS = \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? "";
  return new Map([...block.matchAll(/"([^"]+)":\s*"([0-9a-f]{64})"/g)].map((m) => [m[1]!, m[2]!]));
}

const LINUX_ARCHIVE = `node-${VERSION}-linux-x64.tar.xz`;

type Run = { rc: number; out: string; err: string };

/** One invocation of a copy of the script, with a PATH whose FIRST `curl` refuses and records the
 *  attempt. Offline means offline: a run that reaches the network is a red even when it succeeds. */
function run(root: string, env: Record<string, string>): Run {
  try {
    const out = execFileSync(process.execPath, [join(root, "scripts", "vendor-node.mjs"), "--platform", "linux"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${join(root, "..", "fakebin")}:${process.env.PATH ?? ""}`, ...env },
    });
    return { rc: 0, out, err: "" };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { rc: x.status ?? -1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

let tmp = "";
let archives = "";
let empty = "";
let asIs = "";
let repinned = "";
let curlMarker = "";
let fixtureSha = "";

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ohmail-vendor-node-"));
  archives = join(tmp, "archives");
  empty = join(tmp, "empty");
  curlMarker = join(tmp, "curl-was-called");
  for (const d of [archives, empty, join(tmp, "fakebin")]) mkdirSync(d, { recursive: true });

  /* A `curl` that cannot succeed and leaves a trace. `execFileSync("curl", …)` resolves through
   * PATH, so this is what the script finds first; `tar` still resolves from the real PATH. */
  const fakeCurl = join(tmp, "fakebin", "curl");
  writeFileSync(fakeCurl, `#!/bin/sh\necho called >> ${JSON.stringify(curlMarker)}\nexit 7\n`);
  chmodSync(fakeCurl, 0o755);

  /* A REAL archive of the shape the script unpacks: the runtime at `bin/node`, the licence beside
   * it, one directory deep under the release's own name. Small, and its digest is ours to state. */
  const dir = `node-${VERSION}-linux-x64`;
  const stage = join(tmp, "stage");
  mkdirSync(join(stage, dir, "bin"), { recursive: true });
  const node = join(stage, dir, "bin", "node");
  writeFileSync(node, `#!/bin/sh\necho ${VERSION}\n`);
  chmodSync(node, 0o755);
  writeFileSync(join(stage, dir, "LICENSE"), "fixture licence text\n");
  execFileSync("tar", ["-cJf", join(archives, LINUX_ARCHIVE), "-C", stage, dir]);
  fixtureSha = createHash("sha256").update(readFileSync(join(archives, LINUX_ARCHIVE))).digest("hex");

  /* Two roots, two copies of the SAME script. `ROOT` is derived from the script's own location, so
   * each copy writes its own `build/vendor` and neither can read the other's. The second copy has
   * exactly one literal changed — the linux pin, rewritten to the fixture's own digest — which is
   * what makes the refusal above a measurement of the pin and not of the fixture. */
  asIs = join(tmp, "asis");
  repinned = join(tmp, "repinned");
  const repin = src.replace(new RegExp(`("${LINUX_ARCHIVE}": ")[0-9a-f]{64}`), `$1${fixtureSha}`);
  if (repin === src) throw new Error(`the linux pin line for ${LINUX_ARCHIVE} was not found in the script`);
  for (const [root, text] of [[asIs, src], [repinned, repin]] as const) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "vendor-node.mjs"), text);
  }
});

describe("the pin table is the offline arm's only authority", () => {
  it("names every archive the pinned release can be asked for", () => {
    expect(VERSION, "VERSION could not be read from the script").toBeTruthy();
    const pins = pinsFromSource(src);
    expect([...pins.keys()].sort()).toEqual([
      `node-${VERSION}-darwin-arm64.tar.gz`,
      `node-${VERSION}-darwin-x64.tar.gz`,
      `node-${VERSION}-linux-arm64.tar.xz`,
      `node-${VERSION}-linux-x64.tar.xz`,
      `node-${VERSION}-win-x64.zip`,
    ].sort());
  });

  it("carries a version whose digests were pinned deliberately", () => {
    /* The block is keyed by version, so a bump that forgets the digests leaves the new version
     * unpinned rather than inheriting the old one's — and the assertion above then fails. */
    expect(/const PINS = \{\n\s+"([^"]+)": \{/.exec(src)?.[1]).toBe(VERSION);
  });
});

describe("the offline arm", () => {
  it("refuses when the archive is not in the named directory, and names the file", () => {
    const r = run(asIs, { OHMAIL_NODE_ARCHIVES: empty });
    expect(r.rc).not.toBe(0);
    expect(r.err).toContain(LINUX_ARCHIVE);
    expect(r.err).toContain("Nothing is downloaded in this mode");
    expect(existsSync(curlMarker), "offline reached the network").toBe(false);
  });

  it("refuses an archive whose bytes are not the pinned ones", () => {
    const r = run(asIs, { OHMAIL_NODE_ARCHIVES: archives });
    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("does not match the pinned checksum");
    expect(r.err).toContain(fixtureSha);
    expect(existsSync(curlMarker), "offline reached the network").toBe(false);
  });

  it("refuses a version it holds no digests for", () => {
    const r = run(asIs, { OHMAIL_NODE_ARCHIVES: archives, OHMAIL_NODE_VERSION: "v0.0.0-not-pinned" });
    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("no pinned sha256 digests for v0.0.0-not-pinned");
    expect(existsSync(curlMarker), "offline reached the network").toBe(false);
  });

  /* THE POSITIVE CONTROL, and the reason the three refusals above mean anything: the ordinary case
   * is ADMITTED. Same script, same directory, one pin rewritten to the fixture's own digest. */
  it("accepts the pinned archive and vendors it without a network", () => {
    const r = run(repinned, { OHMAIL_NODE_ARCHIVES: archives });
    expect(r.err).toBe("");
    expect(r.rc).toBe(0);
    expect(r.out).toContain("(offline)");
    expect(r.out).toContain(`${LINUX_ARCHIVE}  sha256 ok (pinned)`);
    expect(existsSync(curlMarker), "offline reached the network").toBe(false);

    const out = join(repinned, "build", "vendor", "node");
    const licence = join(repinned, "build", "vendor", "node.LICENSE");
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).mode & 0o111, "the vendored runtime is not executable").toBeGreaterThan(0);
    expect(readFileSync(licence, "utf8")).toContain("fixture licence");
    if (process.platform === "linux" && process.arch === "x64") {
      expect(r.out).toContain(`runs: ${VERSION}`);
    }
  });
});
