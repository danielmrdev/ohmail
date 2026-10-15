import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { greenmailEndpoint, readLaneGreenmail } from "../../../scripts/lib/lane-greenmail-env.mjs";
import { serverShapeSuite } from "./_self-check-suite.js";

/**
 * The self-check against GREENMAIL — this checkout's own when `.lane-greenmail.env` exists, else
 * the environment's. GreenMail makes a mailbox for any login, so each case is a fresh user and
 * shares nothing with another. The Dovecot twin runs the same suite.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

serverShapeSuite(() => {
  const gm = greenmailEndpoint(process.env, readLaneGreenmail(REPO_ROOT));
  return {
    name: "GreenMail", host: gm.imapHost, port: gm.imapPort,
    user: () => `rc-${randomUUID()}@trafficflow.test`, pass: "test",
  };
});
