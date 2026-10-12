/**
 * The one sentence Settings → New mail renders, chosen from the wake state and the platform.
 *
 * Pure, so a test can assert every state has a sentence and none claims a wake this build cannot
 * deliver. A `switch` over the union, so a new {@link WakeState} fails to compile here rather than
 * rendering nothing. iOS has no distributor to choose, so its sentence names none.
 */
import { Copy } from "../copy";
import type { WakeState } from "../net/push";

export function wakeSentence(state: WakeState, os: string): string {
  switch (state.k) {
    case "no_distributor": return os === "ios" ? Copy.wakeNoPushIos : Copy.wakeNoDistributor;
    case "not_supported_here": return Copy.wakeDesktopHost;
    case "server_has_no_key": return Copy.wakeServerNoKey;
    case "on": return Copy.wakeOn;
    // `row_remains` is "we could not take it back", not "we could not set it up": its own remedy.
    case "off": return state.reason === "row_remains" ? Copy.wakeRowRemains : Copy.wakeOff(state.reason);
  }
}
