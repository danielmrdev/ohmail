import { describe, expect, it } from "vitest";
import { organizeHere } from "../src/net/mailboxes";
import type { ConnectedSession } from "../src/net/pairing";

/**
 * THE PHONE'S AGREE CARRIES WHAT ITS SCREEN SAID. "Organize on this phone" states that agreeing moves
 * the last window's mail from undecided senders to the Screener, so the person's press says so to the
 * door (`screenBacklog`) beside the person's own marker, and the engine's organizer sweeps after its
 * promotion. The engine's own claim press (`pressOwnRoute` in `apps/sidecar/src/mobile.ts`) never sends
 * `screenBacklog` and so never sweeps.
 */

describe("the phone's consent press", () => {
  it("names the screen's rule to the door", async () => {
    const sent: Array<{ url: string; body: unknown }> = [];
    const session = {
      profile: { origin: "http://127.0.0.1:1", apiBase: null },
      fetch: async (url: string, init?: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
        return new Response(JSON.stringify({ outcome: "authorized" }), { status: 200 });
      },
    } as unknown as ConnectedSession;
    expect(await organizeHere(session, "mb-1")).toEqual({ kind: "authorized" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toMatch(/\/local\/mailboxes\/mb-1\/organize$/);
    expect(sent[0]!.body).toEqual({ consent: "person", screenBacklog: true });
  });
});
