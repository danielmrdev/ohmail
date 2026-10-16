import type { CloudAuth, CloudSessionReading } from "../../src/cloud-auth.js";

const LIVE: CloudSessionReading = { state: "live", code: null, since: "2026-01-01T00:00:00.000Z" };

/**
 * The session half of a `CloudAuth` double: live, nothing scheduled, nothing to stop. The mirror
 * and the proxy never ask for it; a double carries it so it stays the whole interface.
 */
export const idleSession: Pick<CloudAuth, "session" | "renewNow" | "stop"> = {
  session: () => LIVE,
  renewNow: async () => LIVE,
  stop: () => undefined,
};
