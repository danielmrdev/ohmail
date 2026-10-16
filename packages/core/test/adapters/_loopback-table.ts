/**
 * THE TABLE: every form a host on THIS COMPUTER is typed or reached by, and the lookalikes that
 * must never pass for one. Shared so the TLS exemption (`imap.tls-floor.test.ts`), the window's copy
 * of the predicate and the probe's local wait (`packages/api`) are held to the same rows. This
 * computer is an address that IS loopback, and the exact name `localhost`, which every dial pins.
 */
export const LOOPBACK_ADMITTED: readonly string[] = [
  "127.0.0.1", "127.0.0.2", "127.1.2.3", "127.255.255.255",
  "localhost", "LocalHost", "localhost.", " 127.0.0.1 ",
  "::1", "[::1]", "0:0:0:0:0:0:0:1",
];

export const LOOPBACK_LOOKALIKES: readonly string[] = [
  // Reaches loopback on Linux and macOS and is still not exempt: see `loopbackHarnessReason`.
  "0.0.0.0",
  "::ffff:127.0.0.1", "::2", "fe80::1",
  // A name under `.localhost` is still a name: a resolver that is not this host's answers it
  // anywhere (H2, measured: `gw.localhost` connected to 172.17.0.1 and took LOGIN in clear).
  "greenmail.localhost", "db.test.localhost", "davmail.localhost", "foo.localhost",
  // Attacker-chosen names that a substring or suffix test would wave through.
  "127.0.0.1.attacker.net", "localhost.evil-com.example", "notlocalhost", "mylocalhost", "localhost-relay.io",
  "128.0.0.1", "27.0.0.1", "1270.0.0.1", "127.0.0.256", "127.0.0", "127.0.0.1:993",
  // The person's own network is not this computer: a LAN or RFC 1918 host gets nothing here.
  "192.168.1.10", "10.0.0.5", "172.16.0.1",
  "", "   ",
];
