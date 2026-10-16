import { describe, expect, it } from "vitest";
import { addressBook, type EntityReader } from "@ohmail/client-engine";

/**
 * THE WIRE'S VERDICT IS READ ON THE CLIENT. `MessageDTO.authVerdict` is what the message's own
 * provider said about its claimed author; the address book used to state "nobody asked" for
 * every mirror row, so a sender whose `From` their own provider called forged ranked as somebody
 * who had written to us. Only `"fail"` demotes — absent, `null` and `"pass"` read as before.
 */

function readerOf(messages: unknown[]): EntityReader {
  return {
    get: () => undefined,
    list: <T,>(type: string): T[] => (type === "message" ? messages : []) as T[],
    entries: () => [],
  } as unknown as EntityReader;
}

const at = new Date(Date.now() - 86_400_000).toISOString();
const msg = (id: string, address: string, over: Record<string, unknown> = {}) => ({
  id, folder: "INBOX", to: [], cc: [], date: at, from: { address, name: null }, ...over,
});

describe("a forged From is a claim, never a correspondent", () => {
  it("a `fail` verdict on the wire demotes its author to a sender's claim", () => {
    const book = addressBook(readerOf([msg("f", "forged@x.invalid", { authVerdict: "fail" })]));
    expect(book.find((e) => e.address === "forged@x.invalid")?.evidence).toBe("sender_named");
  });

  it("CONTROL — absent, null and pass read exactly as before: they wrote to us", () => {
    const book = addressBook(readerOf([
      msg("a", "absent@x.invalid"),
      msg("n", "null@x.invalid", { authVerdict: null }),
      msg("p", "pass@x.invalid", { authVerdict: "pass" }),
    ]));
    const by = new Map(book.map((e) => [e.address, e.evidence]));
    expect([by.get("absent@x.invalid"), by.get("null@x.invalid"), by.get("pass@x.invalid")])
      .toEqual(["they_wrote", "they_wrote", "they_wrote"]);
  });
});
