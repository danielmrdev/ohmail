import { describe, expect, it, vi } from "vitest";
import { ownAddressesOf, readMailboxes } from "../src/net/mailboxes";

/**
 * THE PHONE'S OWN-ADDRESS SET IS THE SERVER'S (REVIEW-026 HIGH-1): `GET /mailboxes` says per row
 * whether the address is the account's own (`addressIsOwn`: neither erased nor removed), and the
 * world's set reads that answer. A removed mailbox is still listed (its row says so) and is not
 * own; a server older than the field leaves every listed address own, as before (the control).
 */
const session = (rows: unknown[]) => ({
  profile: { origin: "https://srv.test", accountId: "a" },
  fetch: vi.fn(async () => ({ status: 200, json: async () => ({ items: rows }) }) as unknown as Response),
}) as never;

describe("the phone's own addresses", () => {
  it("leaves out a mailbox the server does not count as own, and keeps the rest", async () => {
    const rows = await readMailboxes(session([
      { id: "m1", address: "live@own.test", addressIsOwn: true },
      { id: "m2", address: "removed@own.test", status: "disabled", addressIsOwn: false },
    ]));
    expect(rows!.map((r) => [r.address, r.addressIsOwn ?? true])).toEqual([["live@own.test", true], ["removed@own.test", false]]);
    expect(ownAddressesOf(rows!)).toEqual(["live@own.test"]);
  });

  it("CONTROL: a server that sends no field counts every listed address", async () => {
    const rows = await readMailboxes(session([{ id: "m1", address: "a@own.test" }, { id: "m2", address: "b@own.test" }]));
    expect(ownAddressesOf(rows!)).toEqual(["a@own.test", "b@own.test"]);
  });
});
