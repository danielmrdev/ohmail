/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
process.env.NEXT_PUBLIC_API_BASE = "/api";
const { mailboxes } = await import("../app/api-client");
import { OWNER_COOKIE } from "../app/shell/owner-cookie";

/**
 * THE ERASE DOOR ON THE WIRE — the real client, a stubbed `fetch`. The pane's test mocks the
 * client, so this is where `?erase=1` with the typed address in the BODY is held: the address
 * travels exactly as typed (the server compares it, trimmed and case-folded, with the row) and
 * never in the URL, and the removal that keeps the copy sends no erase flag at all.
 */

let calls: Array<{ url: string; method: string; body?: string }> = [];
let answer: () => Response = () => new Response(null, { status: 204 });
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  document.cookie = `${OWNER_COOKIE}=acct-one`;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({
      url: String(url), method: String(init?.method ?? "GET"),
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
    });
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe("mailboxes.erase and mailboxes.remove, as requests", () => {
  it("the erase is a DELETE carrying erase=1, with the typed address in the body and not the URL", async () => {
    answer = () => new Response(JSON.stringify({
      erasing: true, mailboxId: "mb1", messages: 3000, drafts: 1, draftsUnanchored: 0, retained: "",
    }), { status: 202, headers: { "content-type": "application/json" } });
    const receipt = await mailboxes.erase("mb1", " Person+tag@Example.test ");
    expect(calls).toEqual([{
      url: "/api/mailboxes/mb1?erase=1", method: "DELETE",
      body: JSON.stringify({ confirm: " Person+tag@Example.test " }),
    }]);
    expect(receipt).toMatchObject({ erasing: true, mailboxId: "mb1", messages: 3000 });
  });

  it("POSITIVE CONTROL: the removal that keeps the copy is the bare DELETE", async () => {
    await mailboxes.remove("mb1");
    expect(calls).toEqual([{ url: "/api/mailboxes/mb1", method: "DELETE" }]);
  });
});
