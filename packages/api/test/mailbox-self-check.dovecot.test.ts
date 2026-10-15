import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CONDSTORE_HOST, CONDSTORE_PORT } from "../../core/test/adapters/_imapenv.js";
import { serverShapeSuite } from "./_self-check-suite.js";

/**
 * The self-check against DOVECOT — the shared CONDSTORE service (`_imapenv.ts`'s endpoint, the
 * GreenMail lock's box), or a lane's own when `OHMAIL_LANE_DOVECOT_ENV` names an env FILE
 * holding `SELFCHECK_DOVECOT_HOST`/`_PORT`/`_PASS`, so a fixture password never rides a command
 * line. Its static passdb admits any user at that password; each case is a fresh maildir.
 */
function endpoint(): { host: string; port: number; pass: string } {
  const file = process.env.OHMAIL_LANE_DOVECOT_ENV;
  if (file) {
    const vars = Object.fromEntries(readFileSync(file, "utf8").split("\n")
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1]!, m[2]!.trim()]));
    return { host: vars.SELFCHECK_DOVECOT_HOST ?? "127.0.0.1", port: Number(vars.SELFCHECK_DOVECOT_PORT), pass: vars.SELFCHECK_DOVECOT_PASS ?? "" };
  }
  return { host: CONDSTORE_HOST, port: CONDSTORE_PORT, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" };
}

serverShapeSuite(() => {
  const e = endpoint();
  return { name: "Dovecot", host: e.host, port: e.port, user: () => `rc-${randomUUID()}`, pass: e.pass };
});
