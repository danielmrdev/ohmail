import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { readAwayAnswer } from "../src/net/away";
import type { ConnectedSession } from "../src/net/pairing";
import { awayRefusalLine, awaySaveBody } from "../src/ui/away-form";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";

/**
 * THE PHONE'S AWAY SCREEN SAYS A REFUSED CHANGE — the read's `change` reaches it apart from the
 * row, because the row is what a save sends back whole, and the sentence is the web's, in both
 * languages.
 */

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function serve(body: Record<string, unknown>): Promise<ConnectedSession> {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const origin = await new Promise<string>((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const a = server!.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`);
    });
  });
  return {
    profile: { origin, apiBase: null },
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  } as unknown as ConnectedSession;
}

const ROW = {
  enabled: false, body: "Back Monday.", startsAt: null, endsAt: null, audience: "screened_in",
  throttle: "per_day", piles: ["INBOX"], updatedAt: "2026-09-26T08:00:00.000Z",
};

describe("the away read on a reader", () => {
  it("carries the refusal beside the row, and the row a save sends stays clean", async () => {
    const answer = await readAwayAnswer(await serve({
      ...ROW, change: { state: "refused", holder: "work-laptop", refusal: "unreadable" },
    }));
    expect(answer!.refused, "the refusal was dropped").toEqual({ holder: "work-laptop", unreadable: true });
    const put = awaySaveBody(answer!.row, { enabled: true, body: "Back Monday.", endsAt: null })!;
    expect("change" in put).toBe(false);
  });

  it("CONTROL: an asked or absent change is no refusal", async () => {
    expect((await readAwayAnswer(await serve({ ...ROW, change: { state: "asked", holder: null, refusal: null } })))!.refused).toBeNull();
    expect((await readAwayAnswer(await serve(ROW)))!.refused).toBeNull();
  });

  it("a refusal the holder read and turned away is not called unreadable", async () => {
    const answer = await readAwayAnswer(await serve({ ...ROW, change: { state: "refused", holder: null, refusal: "other" } }));
    expect(answer!.refused).toEqual({ holder: null, unreadable: false });
  });
});

describe("the screen's line", () => {
  it("is the sentence for the holder the read named, and nothing without a refusal", () => {
    expect(awayRefusalLine({ holder: "work-laptop", unreadable: true })).toBe(EN.awayRefused("work-laptop", true));
    expect(awayRefusalLine({ holder: null, unreadable: false })).toBe(EN.awayRefusedUnknown(false));
    expect(awayRefusalLine(null)).toBeNull();
  });
});

describe("the sentence is the web's", () => {
  it("in English and German, named and unnamed, both refusals", () => {
    const w = (m: typeof en, k: string) => (m.settings.screening as Record<string, string>)[k]!;
    expect(EN.awayRefused("work-laptop", true)).toBe(w(en, "refusedUnreadable").replace("{name}", "work-laptop"));
    expect(EN.awayRefusedUnknown(true)).toBe(w(en, "refusedUnreadableUnknown"));
    expect(EN.awayRefused("work-laptop", false)).toBe(w(en, "refusedOther").replace("{name}", "work-laptop"));
    expect(EN.awayRefusedUnknown(false)).toBe(w(en, "refusedOtherUnknown"));
    expect(DE.awayRefused("work-laptop", true)).toBe(w(de, "refusedUnreadable").replace("{name}", "work-laptop"));
    expect(DE.awayRefusedUnknown(true)).toBe(w(de, "refusedUnreadableUnknown"));
    expect(DE.awayRefused("work-laptop", false)).toBe(w(de, "refusedOther").replace("{name}", "work-laptop"));
    expect(DE.awayRefusedUnknown(false)).toBe(w(de, "refusedOtherUnknown"));
  });
});
