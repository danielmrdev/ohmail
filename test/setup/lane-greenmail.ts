import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLaneGreenmail, readLaneGreenmail } from "../../scripts/lib/lane-greenmail-env.mjs";

/**
 * THIS CHECKOUT'S OWN GREENMAIL, applied before any test module evaluates. When
 * `scripts/lane-greenmail.sh` has written `.lane-greenmail.env`, its four variables replace the
 * environment's, so `greenmailConfig()`, `greenmailPorts()`, every file reading `process.env` and
 * every child those spawn dial the same server. A malformed file fails every file by name.
 */
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const lane = readLaneGreenmail(ROOT);
const overrode = applyLaneGreenmail(process.env, lane);
if (lane !== null && overrode.length > 0) {
  process.stderr.write(`[greenmail] this checkout has its own GreenMail (${lane.project}); `
    + `ignoring the environment's ${overrode.join(", ")}. Remove it with scripts/lane-greenmail.sh --drop ${ROOT}.\n`);
}
