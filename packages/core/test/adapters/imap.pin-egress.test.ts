import { describe, expect, it } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";

/**
 * THE SUITE'S EGRESS GUARD SEES THE PRODUCT'S OWN PIN. `ImapConfig.pin` reaches imapflow as
 * `tls.lookup` under the stored NAME, so a guard judging the name admitted a dial a mutated door
 * had pinned anywhere. `224.0.0.1` stands for "not this machine": the kernel refuses a TCP connect
 * to a multicast address before any packet leaves, so nothing leaves either way. The name is
 * `ip6-localhost`, one the guard admits by name: `localhost` itself is now always dialled at
 * 127.0.0.1 whatever the pin says (`loopbackDialPin`), so it can no longer carry this case.
 */

const ELSEWHERE = "224.0.0.1";

describe("an IMAP dial pinned off this machine is refused by the suite's guard", () => {
  for (const pin of [[ELSEWHERE], [ELSEWHERE, "224.0.0.2"], ["ff02::1", ELSEWHERE]]) {
    it(`pinned to ${pin.join(" and ")}`, async () => {
      const adapter = new ImapAdapter({
        host: "ip6-localhost", port: 993, secure: true, pin, auth: { user: "u", pass: "fixture" },
      });
      const err = await adapter.connect().then(() => null, (e: unknown) => e as NodeJS.ErrnoException);
      await adapter.close().catch(() => {});
      expect(err, "the dial must fail").not.toBeNull();
      expect(String(err!.code ?? err!.message), "the guard admitted a dial it never judged")
        .toMatch(/^EXTERNAL_NETWORK_BLOCKED/);
    });
  }
});
