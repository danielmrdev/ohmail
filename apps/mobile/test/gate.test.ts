/**
 * THE FIRST-RUN GATE — the app's two-state rule, pinned.
 *
 * The ruling (2026-08-20): the apps open EMPTY and one connects — no demo data,
 * no mail UI without a session. `gateFor` is the whole routing rule the tabs layout
 * renders from; these tests hold every arm, including the two easy regressions:
 * a cold boot flashing the welcome screen on a paired phone, and a disconnected phone
 * landing in an empty mail UI instead of the connect flow.
 */
import { describe, expect, it } from "vitest";
import { refuse } from "../src/refusal";
import type { ConnectionState } from "../src/net/connection";
import { gateFor } from "../src/state/gate";

const live = { k: "live", session: {} as never } as ConnectionState;

describe("the gate: not-connected means the connect flow owns the screen", () => {
  it("a live session renders mail — profiles or not", () => {
    expect(gateFor(live, 0)).toEqual({ to: "mail" });
    expect(gateFor(live, 2)).toEqual({ to: "mail" });
  });

  it("the launch instant renders NOTHING — never a welcome flash on a paired phone", () => {
    expect(gateFor({ k: "starting" }, 0)).toEqual({ to: "boot" });
    expect(gateFor({ k: "starting" }, 1)).toEqual({ to: "boot" });
  });

  it("nothing paired and idle: first run opens into the welcome/connect flow, never the mail UI", () => {
    expect(gateFor({ k: "idle" }, 0)).toEqual({ to: "welcome" });
  });

  it("a refusal or a death lands on Servers WHATEVER the count — the reason must be visible", () => {
    // The welcome screen carries no status panel; sending a refusal there (as an early cut
    // did when zero profiles remained) hides the sentence that explains what happened —
    // a dead keystore read, a revoked pairing. Servers renders the reason and every remedy,
    // and its add panel covers the zero-profile case.
    expect(gateFor({ k: "refused", reason: refuse("notPairedHere") }, 0)).toEqual({ to: "servers" });
    expect(gateFor({ k: "ended", reason: refuse("notPairedHere") }, 0)).toEqual({ to: "servers" });
    expect(gateFor({ k: "refused", reason: refuse("notPairedHere") }, 2)).toEqual({ to: "servers" });
    expect(gateFor({ k: "ended", reason: refuse("notPairedHere") }, 1)).toEqual({ to: "servers" });
  });

  it("paired but idle: the Servers screen holds the remedies", () => {
    expect(gateFor({ k: "idle" }, 1)).toEqual({ to: "servers" });
  });

  it("a boot or switch in flight is a status, not the mail UI", () => {
    expect(gateFor({ k: "connecting", origin: "http://10.0.0.2:4180" }, 1)).toEqual({
      to: "connecting",
      origin: "http://10.0.0.2:4180",
    });
  });
});
