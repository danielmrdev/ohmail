import { describe, expect, it } from "vitest";
import { discloseLocalSyncFailures, LOCAL_CONNECTION_DEAD_AFTER_MS } from "../src/engine.js";

/**
 * THE LOCAL DOOR'S OVERLAY, ARM BY ARM, IN ITS ORDER. A mailbox with no password on this install
 * read "Connected. The first sync has not finished yet." on the rail, because the overlay left it
 * alone and the row claimed health. It now carries the block the hosted organizer writes for the
 * same fact, `awaiting_credentials`, with the runtime's own clock — below the refusals and the
 * unusable stored password, above the outage. Each mailbox below carries its arm AND every arm
 * under it, so the winner is the order, named five times.
 */

const AT = new Date("2026-09-29T08:00:00.000Z");
const OLD = new Date(AT.getTime() - LOCAL_CONNECTION_DEAD_AFTER_MS - 60_000);
const SINCE = new Date("2026-09-29T07:55:00.000Z");

type State = Parameters<typeof discloseLocalSyncFailures>[1][number];
type Connection = State["connection"];

/** Every arm set at once; a mailbox takes the ones from its position down. */
const EVERY: Connection = {
  signInRefused: true,
  plaintextRefused: true,
  credentialBlocked: { state: "unreadable", confirmed: true },
  needsCredential: true,
  needsCredentialSince: SINCE,
  unreachableSince: OLD,
};
const FROM = ["signInRefused", "plaintextRefused", "credentialBlocked", "needsCredential", "unreachableSince"] as const;

function connectionFrom(position: number): Connection {
  const c: Connection = { signInRefused: false, unreachableSince: null };
  for (const arm of FROM.slice(position)) {
    if (arm === "needsCredential") { c.needsCredential = true; c.needsCredentialSince = SINCE; }
    else if (arm === "credentialBlocked") c.credentialBlocked = EVERY.credentialBlocked;
    else if (arm === "plaintextRefused") c.plaintextRefused = true;
    else if (arm === "signInRefused") c.signInRefused = true;
    else c.unreachableSince = OLD;
  }
  return c;
}

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: "connected", organizerRole: "organizer", organizeConsentedAt: "2026-09-01T00:00:00.000Z",
  errorCode: null, errorDetail: null, syncBlockedReason: null, syncBlockedSince: null, ...over,
});

async function overlay(rows: object[], states: State[]): Promise<Array<Record<string, unknown>>> {
  const res = new Response(JSON.stringify({ items: rows }), { headers: { "content-type": "application/json" } });
  const out = await discloseLocalSyncFailures(res, states, AT);
  return ((await out.json()) as { items: Array<Record<string, unknown>> }).items;
}

const said = (r: Record<string, unknown>) => ({
  status: r.status, errorCode: r.errorCode ?? null, errorDetail: r.errorDetail ?? null,
  block: r.syncBlockedReason ?? null, since: r.syncBlockedSince ?? null, outage: r.unreachableSince ?? null,
});

describe("the local door's overlay", () => {
  it("names the five arms in order: each outranks every one below it", async () => {
    const ids = FROM.map((_, i) => `mbx-${i}`);
    const items = await overlay(ids.map((id) => row(id)), ids.map((id, i) => ({ mailboxId: id, connection: connectionFrom(i) })));
    expect(items.map(said)).toEqual([
      { status: "error", errorCode: "auth", errorDetail: null, block: null, since: null, outage: null },
      { status: "error", errorCode: "connect", errorDetail: "MAILBOX_PLAINTEXT_REFUSED", block: null, since: null, outage: null },
      { status: "error", errorCode: "connect", errorDetail: "MAILBOX_CREDENTIAL_UNREADABLE", block: null, since: null, outage: null },
      { status: "connected", errorCode: null, errorDetail: null, block: "awaiting_credentials", since: SINCE.toISOString(), outage: null },
      { status: "error", errorCode: "connect", errorDetail: null, block: null, since: null, outage: OLD.toISOString() },
    ]);
  });

  it("an unconfirmed unusable password overlays nothing, and so hides the no-password block too", async () => {
    const [item] = await overlay([row("m")], [{
      mailboxId: "m",
      connection: { ...connectionFrom(3), credentialBlocked: { state: "unreadable", confirmed: false } },
    }]);
    expect(said(item!)).toEqual({ status: "connected", errorCode: null, errorDetail: null, block: null, since: null, outage: null });
  });

  it("the block is said of a reader too, and never over a block the row already carries", async () => {
    const items = await overlay(
      [row("reader", { organizerRole: "reader", organizeConsentedAt: null }),
        row("held", { syncBlockedReason: "clock_off", syncBlockedSince: "2026-09-29T07:00:00.000Z" })],
      [{ mailboxId: "reader", connection: connectionFrom(3) }, { mailboxId: "held", connection: connectionFrom(3) }],
    );
    expect(items.map((i) => [i.syncBlockedReason, i.syncBlockedSince])).toEqual([
      ["awaiting_credentials", SINCE.toISOString()],
      ["clock_off", "2026-09-29T07:00:00.000Z"],
    ]);
  });

  it("a disabled row is not overlaid, and a state with no clock overlays nothing", async () => {
    const items = await overlay(
      [row("gone", { status: "disabled" }), row("unclocked")],
      [
        { mailboxId: "gone", connection: connectionFrom(3) },
        { mailboxId: "unclocked", connection: { signInRefused: false, unreachableSince: null, needsCredential: true } },
      ],
    );
    expect(items.map(said)).toEqual([
      { status: "disabled", errorCode: null, errorDetail: null, block: null, since: null, outage: null },
      { status: "connected", errorCode: null, errorDetail: null, block: null, since: null, outage: null },
    ]);
  });
});
