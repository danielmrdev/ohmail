/**
 * THE DELETE FORWARDING carries its opts — the K52 gap row: `stableActions.deleteMessage`
 * (state/live.ts) forwards an OPTIONAL `{ onCommitted? }`, and the reader's leave-on-commit
 * rides that arg. Because it is optional, a forwarding rewritten to `(id) => …deleteMessage(id)`
 * still TYPECHECKS while silently dropping it, so the reader would stop leaving when the delete
 * window closes and — one layer down — the quiet commit's own opts could stop reaching the
 * engine. The typechecker cannot watch an optional arg being dropped; this test does.
 */
import { describe, expect, it } from "vitest";
import { stableActions } from "../src/state/live";
import type { WorldActions } from "../src/state/world";

function recording(seen: Array<{ id: string; opts: unknown }>): WorldActions {
  // Only the members this test drives carry a body; the rest are no-ops, since stableActions
  // wraps the WHOLE surface and the test asserts one arm.
  const noop = (): void => undefined;
  const base = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "deleteMessage") {
          return (id: string, opts?: { onCommitted?: () => void }) => {
            seen.push({ id, opts });
          };
        }
        if (prop === "trashList") return async () => ({ state: "unavailable" as const });
        if (prop === "trashRestore") return async () => false;
        if (prop === "sendReply" || prop === "sendForward")
          return () => Promise.resolve({ outcome: "sent" as const });
        if (prop === "withdrawSend") return () => Promise.resolve("withdrawn" as const);
        if (prop === "cancelSchedule") return () => Promise.resolve(true);
        if (prop === "sendOutcome") return () => "unknown" as const;
        return noop;
      },
    },
  );
  return base as WorldActions;
}

describe("stableActions forwards deleteMessage's opts, not just its id", () => {
  it("passes the onCommitted opts object through to the delegate", () => {
    const seen: Array<{ id: string; opts: unknown }> = [];
    const actions = stableActions(() => recording(seen));
    const onCommitted = () => undefined;
    actions.deleteMessage("m1", { onCommitted });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe("m1");
    // The whole point: the opts object — and its onCommitted — reach the delegate. A forwarding
    // that dropped the arg would leave this undefined and still compile.
    expect(seen[0]!.opts).toEqual({ onCommitted });
    expect((seen[0]!.opts as { onCommitted?: () => void }).onCommitted).toBe(onCommitted);
  });

  it("a bare delete (no opts) forwards undefined, not a fabricated object", () => {
    const seen: Array<{ id: string; opts: unknown }> = [];
    const actions = stableActions(() => recording(seen));
    actions.deleteMessage("m2");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.opts).toBeUndefined();
  });
});
