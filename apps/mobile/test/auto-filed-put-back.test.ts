/**
 * "FILED AUTOMATICALLY" ON THE PHONE (row 140) — the web Settings row's route pair. The read
 * narrows the page and answers `null` for a read it could not make, never an empty list (which
 * would say nothing was filed); Put back sends exactly the ids pressed and reads the answer's two
 * lists; the sentence after it says where the mail goes, in both languages.
 */
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { putBackAutoFiled, readAutoFiled } from "../src/net/auto-filed";
import type { ConnectedSession } from "../src/net/pairing";
import { autoFiledSaid } from "../src/ui/auto-filed-said";
import { DECKS } from "../src/copy";

function server(answer: { get: number; getBody: unknown }) {
  const posts: unknown[] = [];
  const s = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(answer.get, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.getBody));
      return;
    }
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => {
      const body = JSON.parse(raw) as { messageIds: string[] };
      posts.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ putBack: body.messageIds, requested: [] }));
    });
  });
  return { s, posts };
}
const listen = (s: Server): Promise<string> => new Promise((resolve) => {
  s.listen(0, "127.0.0.1", () => {
    const a = s.address();
    resolve(`http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`);
  });
});
const sessionFor = (origin: string): ConnectedSession => ({
  profile: { origin, apiBase: null },
  fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
}) as unknown as ConnectedSession;

describe("the route pair", () => {
  it("reads the page, drops a row with no id, and Put back sends exactly the ids pressed", async () => {
    const { s, posts } = server({ get: 200, getBody: { items: [
      { messageId: "m1", from: "news@shop.test", subject: "Deals", to: "ohmail/News" },
      { from: "x@shop.test", to: "ohmail/News" },
    ], more: false } });
    const origin = await listen(s);
    try {
      const session = sessionFor(origin);
      expect(await readAutoFiled(session)).toEqual({
        items: [{ messageId: "m1", from: "news@shop.test", subject: "Deals", to: "ohmail/News" }], more: false,
      });
      expect(await putBackAutoFiled(session, ["m1"])).toEqual({ putBack: ["m1"], requested: [] });
      expect(posts).toEqual([{ messageIds: ["m1"] }]);
    } finally { s.close(); }
  });

  it("a read that could not be made is null, never an empty list (the control)", async () => {
    const { s } = server({ get: 404, getBody: { error: { code: "not_found" } } });
    const origin = await listen(s);
    try {
      expect(await readAutoFiled(sessionFor(origin))).toBeNull();
    } finally { s.close(); }
  });
});

describe("the sentence after a press", () => {
  it("says where the mail goes, and names a request as a request", () => {
    expect(autoFiledSaid({ k: "done", n: 2 })).toContain("2 messages go back to your Screener");
    expect(autoFiledSaid({ k: "requested" })).toContain("install that organizes");
    expect(autoFiledSaid(null)).toBeNull();
    expect(DECKS.de.autoFiledPutBackDone(1)).toContain("1 Nachricht kommt");
  });
});
