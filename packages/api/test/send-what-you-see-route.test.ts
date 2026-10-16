import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { drafts } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

/**
 * ═══ THE SEND NAMES THE ROW IT WAS COMPOSED AGAINST, THROUGH THE ROUTE ══════════════════════
 *
 * Two windows hold one draft. The second one's autosave commits between the first's final save
 * and its press, and the send route reads the ROW — so the message that leaves is the other
 * window's, to the other window's recipients, reported as sent. The press carries
 * `ifContentRevision`, the route threads it to the reservation, and a row that has moved off it
 * is refused with nothing delivered.
 *
 * Driven through `createApp` rather than the service, because the refusal is only as real as the
 * pipeline the route runs.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** A fake send adapter — no network. Counts deliveries and keeps what each one carried. */
function fakeAdapter() {
  const state = { sendCalls: 0, delivered: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      state.delivered.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* no-op */ },
  });
  return { factory, state };
}

async function world() {
  const { factory, state } = fakeAdapter();
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });
  const [d] = await db.insert(drafts).values({
    accountId: s.accountId, mailboxId, subject: "the invoice",
    body: "Here is the invoice you asked for.",
    to: [{ name: null, address: "chosen@example.com" }], status: "draft",
  } as never).returning();
  const draftId = d!.id;
  const read = async (): Promise<{ contentRevision: string }> =>
    (await (await H(req("GET", `/drafts/${draftId}`, { bearer: s.token }), deps)).json()) as { contentRevision: string };
  return { db, deps, s, draftId, state, read };
}

describe("POST /drafts/:id/send — the version this press was composed against", () => {
  it("refuses a row another window rewrote in between, and delivers nothing", async () => {
    const { db, deps, s, draftId, state, read } = await world();
    const mine = (await read()).contentRevision;

    // The other window's delayed autosave lands: different words, a different recipient.
    const put = await H(req("PUT", `/drafts/${draftId}`, {
      bearer: s.token,
      body: JSON.stringify({ body: "scratch notes — do not send", to: [{ name: null, address: "someone-else@example.com" }] }),
    }), deps);
    expect(put.status).toBe(200);

    const res = await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token,
      headers: { "idempotency-key": "send-stale" },
      body: JSON.stringify({ ifContentRevision: mine }),
    }), deps);

    expect(state.delivered.map((m) => m.text), "the other window's words left under this press").toEqual([]);
    expect(state.sendCalls).toBe(0);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("draft_changed");

    // Still sendable: the author reviews it and presses again.
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.status).toBe("draft");
  });

  it("sends when the revision is the row's own", async () => {
    const { deps, s, draftId, state, read } = await world();
    const res = await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token,
      headers: { "idempotency-key": "send-fresh" },
      body: JSON.stringify({ ifContentRevision: (await read()).contentRevision }),
    }), deps);

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("sent");
    expect(state.sendCalls).toBe(1);
  });

  it("sends a press that names no revision — the field is unstated, not refused", async () => {
    const { deps, s, draftId, state } = await world();
    const res = await H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": "send-bare" },
    }), deps);

    expect(res.status).toBe(200);
    expect(state.sendCalls).toBe(1);
  });

  /**
   * A token that was never a revision is a bad REQUEST, not a changed draft: answering 409 would
   * tell the person their draft moved when what happened is that their client sent nonsense.
   */
  it("answers 400 for a value that could never be a revision, and sends nothing", async () => {
    const { deps, s, draftId, state } = await world();
    for (const bad of ["", "not-a-revision", "A".repeat(64), "a".repeat(63)]) {
      const res = await H(req("POST", `/drafts/${draftId}/send`, {
        bearer: s.token,
        headers: { "idempotency-key": `send-bad-${bad.length}-${bad.slice(0, 3)}` },
        body: JSON.stringify({ ifContentRevision: bad }),
      }), deps);
      expect(res.status, `a malformed revision was taken for one: ${JSON.stringify(bad)}`).toBe(400);
    }
    expect(state.sendCalls).toBe(0);
  });
});
