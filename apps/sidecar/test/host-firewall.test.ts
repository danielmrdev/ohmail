import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readUfwSources, ufwVerdict, type UfwSources } from "../src/host-firewall.js";
import { maybeStartLanListener } from "../src/host-lan.js";
import { ensureLanIdentity, type LanIdentity } from "../src/host-lan-tls.js";

/**
 * The LAN door has a TLS identity now and will not open a socket without one — see
 * `host-lan-tls.ts`. These tests are about the FIREWALL verdict, so they take a throwaway
 * identity in a throwaway directory; nothing here depends on which key it is.
 */
const idDirs: string[] = [];
afterAll(() => { for (const d of idDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function identity(): LanIdentity {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-fw-id-"));
  idDirs.push(dir);
  const out = ensureLanIdentity(dir);
  if (out.kind !== "identity") throw new Error(`no identity: ${out.refusal.reason}`);
  return out.identity;
}

/**
 * One address this machine really holds and that the bind rules accept — not loopback (the host
 * door's own bind) and not the wildcard. Read at runtime because the test box is not fixed; a
 * machine with no external IPv4 cannot exercise the door half at all, and says so by skipping
 * rather than by passing.
 */
const LOCAL_IPV4: string | null =
  Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .find((iface) => iface.family === "IPv4" && !iface.internal)?.address ?? null;

/**
 * THE HONESTY GUARD for same-network access.
 *
 * The defect: arming *Also allow same-network access* binds the port and does not open the host
 * firewall, so on a default-deny distribution the feature reports itself ON and nothing on the
 * network can reach it. The claim under test is therefore not "the door binds" — it always did —
 * but **the app never says the door is reachable when it has read that it is not**.
 *
 * ── THE CASE THAT MATTERS MOST IS `selfProbeWouldHaveLied` ───────────────────────────────────
 *
 * The natural implementation is a self-probe, and it is wrong for a reason no unit test can show:
 * a connection from this machine to an address this machine holds is routed over `lo`, and ufw's
 * first rule accepts everything on `lo`. So the probe succeeds through a closed firewall.
 * Measured in the Omarchy 4.0.2 guest rather than argued — the transcript is in
 * `host-firewall.ts`'s header, and the case below pins the CONSEQUENCE: these exact three files,
 * which is the state a self-probe reports as fine, must produce `blocks`.
 */

/** The measured Omarchy 4.0.2 files, trimmed to what the reader looks at. */
const CONF_ENABLED = "# /etc/ufw/ufw.conf\nENABLED=yes\nLOGLEVEL=low\n";
const CONF_DISABLED = "# /etc/ufw/ufw.conf\nENABLED=no\nLOGLEVEL=low\n";
const DEFAULTS_DROP = 'IPV6=yes\nDEFAULT_INPUT_POLICY="DROP"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\n';
const DEFAULTS_ACCEPT = 'IPV6=yes\nDEFAULT_INPUT_POLICY="ACCEPT"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\n';

/** `user.rules` as ufw writes it, with whichever tuples a case wants. */
const rulesWith = (...tuples: string[]): string =>
  [
    "*filter",
    ":ufw-user-input - [0:0]",
    "### RULES ###",
    "",
    ...tuples.flatMap((t) => [`### tuple ### ${t}`, "-A ufw-user-input -j ACCEPT", ""]),
    "### END RULES ###",
    "COMMIT",
  ].join("\n");

/** The exact rule set the guest carried while port 6245 was unreachable from off-box. */
const OMARCHY_CLOSED = rulesWith(
  "allow udp 53317 0.0.0.0/0 any 0.0.0.0/0 in",
  "allow tcp 53317 0.0.0.0/0 any 0.0.0.0/0 in",
  "allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in",
);

/** The same box after `sudo ufw allow 6245/tcp` — the command the pane now prints. */
const OMARCHY_OPEN = rulesWith(
  "allow tcp 53317 0.0.0.0/0 any 0.0.0.0/0 in",
  "allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in",
  "allow tcp 6245 0.0.0.0/0 any 0.0.0.0/0 in",
);

/**
 * Admits ANY inbound TCP port. The door cases bind on port 0, so the verdict is asked about
 * whichever ephemeral port the kernel handed out — a rule naming 6245 would not be about it.
 */
const OMARCHY_OPEN_ANY = rulesWith("allow tcp any 0.0.0.0/0 any 0.0.0.0/0 in");

const sources = (conf: string | null, defaults: string | null, rules: string | null): UfwSources =>
  ({ conf, defaults, rules });

const verdict = (s: UfwSources, port = 6245, address: string | null = "10.0.2.15") =>
  ufwVerdict({ port, address, sources: s, unitActive: null });

describe("the firewall reading — what the pane is allowed to claim", () => {
  it("selfProbeWouldHaveLied: the measured Omarchy state reads as BLOCKED, with the command", () => {
    // This is the run that produced the gap. A self-probe against this exact machine answered
    // `HELLO-FROM-LAN-DOOR`; a connection from off-box timed out. The files say which one is true.
    const v = verdict(sources(CONF_ENABLED, DEFAULTS_DROP, OMARCHY_CLOSED));
    expect(v.state).toBe("blocks");
    expect(v).toHaveProperty("remedy", "sudo ufw allow 6245/tcp");
  });

  it("the same box after the remedy reads as allowing — the command actually resolves it", () => {
    expect(verdict(sources(CONF_ENABLED, DEFAULTS_DROP, OMARCHY_OPEN)).state).toBe("allows");
  });

  it("ufw turned off is inactive, not blocked — no rule is needed and none is demanded", () => {
    expect(verdict(sources(CONF_DISABLED, DEFAULTS_DROP, OMARCHY_CLOSED)).state).toBe("inactive");
  });

  it("a stopped unit outranks the file's ENABLED=yes", () => {
    const v = ufwVerdict({
      port: 6245,
      address: null,
      sources: sources(CONF_ENABLED, DEFAULTS_DROP, OMARCHY_CLOSED),
      unitActive: false,
    });
    expect(v.state).toBe("inactive");
  });

  it("a default-ACCEPT input policy allows with no rule at all — the advice would be false", () => {
    expect(verdict(sources(CONF_ENABLED, DEFAULTS_ACCEPT, OMARCHY_CLOSED)).state).toBe("allows");
  });

  it("NO FILES is `unreadable`, never `allows` — macOS, Windows, nftables, no firewall", () => {
    // The overclaim this whole module exists to remove, in its second disguise: a machine this
    // code knows nothing about must not be reported as verified-open.
    expect(verdict(sources(null, null, null)).state).toBe("unreadable");
  });

  it("enforcing with unreadable rules is `unreadable` — absence of a rule is not evidence", () => {
    expect(verdict(sources(CONF_ENABLED, DEFAULTS_DROP, null)).state).toBe("unreadable");
  });

  it("an unrecognised rules format is `unreadable`, but an EMPTY rule set blocks", () => {
    expect(verdict(sources(CONF_ENABLED, DEFAULTS_DROP, "something else entirely")).state)
      .toBe("unreadable");
    expect(verdict(sources(CONF_ENABLED, DEFAULTS_DROP, rulesWith())).state).toBe("blocks");
  });

  it("an unreadable default policy withholds the verdict rather than guessing DROP", () => {
    expect(verdict(sources(CONF_ENABLED, null, OMARCHY_CLOSED)).state).toBe("unreadable");
    // ...but a covering rule settles it without needing the policy at all.
    expect(verdict(sources(CONF_ENABLED, null, OMARCHY_OPEN)).state).toBe("allows");
  });

  it("reads the rule shapes ufw actually writes: ranges, lists, `any`, and `limit`", () => {
    const covering = [
      "allow tcp 6000:6300 0.0.0.0/0 any 0.0.0.0/0 in",
      "allow tcp 80,6245,443 0.0.0.0/0 any 0.0.0.0/0 in",
      "allow any 6245 0.0.0.0/0 any 0.0.0.0/0 in",
      "allow tcp any 0.0.0.0/0 any 0.0.0.0/0 in",
      // `limit` admits — it is an allow that rate-limits. SSH ships this way.
      "limit tcp 6245 0.0.0.0/0 any 0.0.0.0/0 in",
      // Pinned to the address the door actually bound.
      "allow tcp 6245 10.0.2.15 any 0.0.0.0/0 in",
    ];
    for (const tuple of covering) {
      expect(verdict(sources(CONF_ENABLED, DEFAULTS_DROP, rulesWith(tuple))).state, tuple)
        .toBe("allows");
    }
  });

  it("refuses the near-misses: wrong protocol, outbound, deny, another address, next port", () => {
    const notCovering = [
      "allow udp 6245 0.0.0.0/0 any 0.0.0.0/0 in",
      "allow tcp 6245 0.0.0.0/0 any 0.0.0.0/0 out",
      "deny tcp 6245 0.0.0.0/0 any 0.0.0.0/0 in",
      "reject tcp 6245 0.0.0.0/0 any 0.0.0.0/0 in",
      "allow tcp 6245 192.168.1.9 any 0.0.0.0/0 in",
      "allow tcp 6246 0.0.0.0/0 any 0.0.0.0/0 in",
      "allow tcp 6246:6300 0.0.0.0/0 any 0.0.0.0/0 in",
    ];
    for (const tuple of notCovering) {
      expect(verdict(sources(CONF_ENABLED, DEFAULTS_DROP, rulesWith(tuple))).state, tuple)
        .toBe("blocks");
    }
  });

  /**
   * ── THE FOUR SHAPES REVIEW FOUND, EACH MEASURED ON A REAL ufw BEFORE IT WAS FIXED ──────────
   *
   * Round one called the patch incorrect and was right four times over in this function alone.
   * The tuples below are verbatim `/etc/ufw/user.rules` output from the Omarchy guest, produced
   * by running the actual `ufw` commands rather than by writing down what the format ought to be
   * — which matters, because the report's guess at the app-profile layout (`dapp=`/`sapp=`) was
   * not what ufw wrote (`MailHost - in`, two bare positional fields). The defect was real and the
   * detail was not, and only the machine could tell the difference.
   */
  it("an application-profile rule ADMITS — the packaging path this module recommends", () => {
    // `ufw allow MailHost` → two positional fields before the direction. A fixed-index read took
    // `MailHost` for the direction and rejected it, so a machine that opened the port the
    // recommended way was told nothing could reach it.
    const tuple = "allow tcp 6245 0.0.0.0/0 any 0.0.0.0/0 MailHost - in";
    expect(verdict(sources(CONF_ENABLED, DEFAULTS_DROP, rulesWith(tuple))).state).toBe("allows");
  });

  it("a comment after the direction does not hide it", () => {
    const tuple = "allow tcp 6245 0.0.0.0/0 any 0.0.0.0/0 in comment=616c6c6f77";
    expect(verdict(sources(CONF_ENABLED, DEFAULTS_DROP, rulesWith(tuple))).state).toBe("allows");
  });

  it("a CIDR destination containing the bound address ADMITS", () => {
    // `ufw allow to 10.0.2.0/24 port 6245` — an ordinary way to open a port to one's own subnet.
    const tuple = "allow tcp 6245 10.0.2.0/24 any 0.0.0.0/0 in";
    expect(verdict(sources(CONF_ENABLED, DEFAULTS_DROP, rulesWith(tuple))).state).toBe("allows");
    // ...and one that does NOT contain it still blocks.
    const other = "allow tcp 6245 192.168.9.0/24 any 0.0.0.0/0 in";
    expect(verdict(sources(CONF_ENABLED, DEFAULTS_DROP, rulesWith(other))).state).toBe("blocks");
  });

  it("an interface-qualified rule counts ONLY for that interface — the asymmetry flips here", () => {
    // `ufw allow in on enp0s2 …` → `in_enp0s2`. Accepting it for a door bound elsewhere reports a
    // reachable door over a firewall dropping every packet to it: a false SERVING, which is the
    // overclaim this module exists to remove, not the annoyance the rest of it tolerates.
    const tuple = "allow tcp 6245 0.0.0.0/0 any 0.0.0.0/0 in_enp0s2";
    const rules = rulesWith(tuple);
    const on = (iface: string | null) =>
      ufwVerdict({
        port: 6245, address: "10.0.2.15", sources: sources(CONF_ENABLED, DEFAULTS_DROP, rules),
        unitActive: null, boundInterface: iface,
      }).state;
    expect(on("enp0s2")).toBe("allows");
    expect(on("wlan0")).toBe("blocks");
    // An unknown interface does not count — the one place this module refuses to be generous.
    expect(on(null)).toBe("blocks");
  });

  it("a wildcard interface qualifier matches by prefix — `in_en+` covers `enp0s2`", () => {
    // Measured, not assumed: `ufw allow in on en+ …` writes `### tuple ### … in_en+` and
    // `-A ufw-user-input -i en+ …` beneath it, and iptables' `+` is a prefix wildcard. Reading it
    // literally reported a machine blocked while the port was open.
    const rules = rulesWith("allow tcp 6245 0.0.0.0/0 any 0.0.0.0/0 in_en+");
    const on = (iface: string | null) =>
      ufwVerdict({
        port: 6245, address: "10.0.2.15", sources: sources(CONF_ENABLED, DEFAULTS_DROP, rules),
        unitActive: null, boundInterface: iface,
      }).state;
    expect(on("enp0s2")).toBe("allows");
    expect(on("eth0")).toBe("blocks");
  });

  it("readUfwSources never throws on a machine that has none of these files", () => {
    const got = readUfwSources({ conf: "/nope/a", defaults: "/nope/b", rules: "/nope/c" });
    expect(got).toEqual({ conf: null, defaults: null, rules: null });
  });
});

describe.skipIf(LOCAL_IPV4 === null)("the LAN door reports the blocked state, and only when it read one", () => {
  /** A real bind on a real interface — the log is what is under test, but the bind must happen. */
  const runDoor = async (s: UfwSources): Promise<{ event: string; detail: unknown }[]> => {
    const lines: { event: string; detail: unknown }[] = [];
    const listener = await maybeStartLanListener(
      {
        hostState: { armed: true, port: 0 },
        lanState: { address: LOCAL_IPV4, reason: null },
        handleLan: () => Promise.resolve(new Response("ok")),
        lanIdentity: identity(),
      },
      (event, detail) => void lines.push({ event, detail }),
      undefined,
      () => s,
    );
    await listener?.close();
    return lines;
  };

  it("a blocked firewall produces host_lan_firewall_blocked AFTER host_lan_listening", async () => {
    const lines = await runDoor(sources(CONF_ENABLED, DEFAULTS_DROP, rulesWith()));
    expect(lines.map((l) => l.event)).toEqual(["host_lan_listening", "host_lan_firewall_blocked"]);
    // The remedy names the port the door actually bound, not the one that was configured.
    const detail = lines[1]!.detail as { port: number; reason: string };
    expect(detail.reason).toContain(`sudo ufw allow ${detail.port}/tcp`);
    // The census's rule, restated where it can be watched: the operator's interface address
    // identifies their network and never appears on a line.
    expect(JSON.stringify(lines)).not.toContain(LOCAL_IPV4);
  });

  it("an open firewall says nothing at all — no nagging over a machine that is fine", async () => {
    const lines = await runDoor(sources(CONF_DISABLED, DEFAULTS_DROP, rulesWith()));
    expect(lines.map((l) => l.event)).toEqual(["host_lan_listening"]);
  });

  it("a machine this code cannot read says nothing — silence, never a claim", async () => {
    const lines = await runDoor(sources(null, null, null));
    expect(lines.map((l) => l.event)).toEqual(["host_lan_listening"]);
  });

  /**
   * ── THE REMEDY HAS TO BE CONFIRMABLE, WHICH THE FIRST VERSION'S WAS NOT ────────────────────
   *
   * Review's sharpest finding: the pane printed `sudo ufw allow <port>/tcp`, the operator ran it,
   * and the warning stayed until the engine restarted — the verdict was read once at bind and
   * never again. An app that tells somebody how to fix something and cannot then see that they
   * did it is worse than one that stays quiet, because it teaches them the advice does not work.
   */
  it("running the printed command clears the warning, without restarting anything", async () => {
    const lines: { event: string; detail: unknown }[] = [];
    // The machine changes underneath the door, exactly as it does when the operator runs the
    // command: blocked at bind, open by the next look.
    let open = false;
    const listener = await maybeStartLanListener(
      {
        hostState: { armed: true, port: 0 },
        lanState: { address: LOCAL_IPV4, reason: null },
        handleLan: () => Promise.resolve(new Response("ok")),
        lanIdentity: identity(),
      },
      (event, detail) => void lines.push({ event, detail }),
      undefined,
      () => sources(CONF_ENABLED, DEFAULTS_DROP, open ? OMARCHY_OPEN_ANY : rulesWith()),
      5,
    );
    expect(lines.map((l) => l.event)).toEqual(["host_lan_listening", "host_lan_firewall_blocked"]);
    open = true;
    await new Promise((done) => setTimeout(done, 60));
    await listener?.close();
    // Recovery re-emits the ORDINARY listening signal, so the pane and the tray return to serving
    // through the path they already have — no new state, and no restart.
    expect(lines.map((l) => l.event)).toEqual([
      "host_lan_listening", "host_lan_firewall_blocked", "host_lan_listening",
    ]);
    // And it is announced ONCE: a steady verdict says nothing, so an ordinary machine's log is
    // unchanged and a blocked one does not repeat itself every fifteen seconds.
    expect(lines.filter((l) => l.event === "host_lan_firewall_blocked")).toHaveLength(1);
  });

  it("an unreadable re-check NEVER clears the warning — silence is not evidence of opening", async () => {
    // The recovery path's own overclaim: if a file briefly cannot be read, `ufwVerdict` answers
    // `unreadable`, and a first version treated anything-but-blocks as recovery — announcing a
    // reachable door because a read failed. Only a POSITIVE verdict may clear a warning.
    const lines: { event: string; detail: unknown }[] = [];
    let readable = true;
    const listener = await maybeStartLanListener(
      {
        hostState: { armed: true, port: 0 },
        lanState: { address: LOCAL_IPV4, reason: null },
        handleLan: () => Promise.resolve(new Response("ok")),
        lanIdentity: identity(),
      },
      (event) => void lines.push({ event, detail: null }),
      undefined,
      () => (readable
        ? sources(CONF_ENABLED, DEFAULTS_DROP, rulesWith())
        : sources(null, null, null)),
      5,
    );
    expect(lines.map((l) => l.event)).toEqual(["host_lan_listening", "host_lan_firewall_blocked"]);
    readable = false;
    await new Promise((done) => setTimeout(done, 60));
    await listener?.close();
    // Unchanged: the blocked warning still stands, because nothing said the firewall opened.
    expect(lines.map((l) => l.event)).toEqual(["host_lan_listening", "host_lan_firewall_blocked"]);
  });

  it("a steady verdict never repeats itself, in either direction", async () => {
    const lines: { event: string; detail: unknown }[] = [];
    const listener = await maybeStartLanListener(
      {
        hostState: { armed: true, port: 0 },
        lanState: { address: LOCAL_IPV4, reason: null },
        handleLan: () => Promise.resolve(new Response("ok")),
        lanIdentity: identity(),
      },
      (event) => void lines.push({ event, detail: null }),
      undefined,
      () => sources(CONF_ENABLED, DEFAULTS_DROP, rulesWith()),
      5,
    );
    await new Promise((done) => setTimeout(done, 60));
    await listener?.close();
    expect(lines.map((l) => l.event)).toEqual(["host_lan_listening", "host_lan_firewall_blocked"]);
  });
});
