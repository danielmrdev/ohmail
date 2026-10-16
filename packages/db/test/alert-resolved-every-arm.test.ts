import { describe, expect, it } from "vitest";
import { managedDomain } from "../../../test/support/fixture-credentials.js";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { accounts, drafts, mailboxes, outboundSends } from "@trafficflow/db";
import { alertState } from "../src/cloud.js";
import { runAlertPass, webhookAlertSink, type AlertSink, type ResolutionNotice } from "../src/alerts.js";
import { telegramAlertSink } from "../src/alert-push.js";

/**
 * A CRITICAL THAT RESOLVED IS SAID ON EVERY ARM (ALERT-RESOLVED-NOTICE-IS-MAIL-ONLY). Only the mail
 * arm had `notifyResolved`, and the pass skips a sink without it, so a deployment paging through
 * the webhook or Telegram alone was paged and never told the page was over.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const NOW = new Date("2026-09-29T08:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const TOKEN = "8123456789:AAF-fakefakefakefakefakefakefake0123";

/** A POST recorder standing in for the network: every body the sink sends, in order. */
function recorder(): { bodies: string[]; post: (url: string, body: string) => Promise<{ status: number }> } {
  const bodies: string[] = [];
  return { bodies, post: async (_url: string, body: string) => { bodies.push(body); return { status: 200 }; } };
}

const NOTICE: ResolutionNotice = {
  key: "sends_stuck", kind: "sends_stuck", openedAt: "2026-09-29T06:00:00.000Z",
  resolvedAt: "2026-09-29T06:30:00.000Z", pages: 2,
};
const CTX = { source: "worker", environment: "test", now: NOW };

async function seedStuckSend(db: Db): Promise<void> {
  const [acct] = await db.insert(accounts).values({ name: "Resolved" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    // Synced through the whole test, so the only alert in it is the stuck send.
    accountId: acct!.id, provider: "imap", status: "connected", lastSyncAt: at(4 * HOUR),
    createdAt: new Date(NOW.getTime() - 10 * 24 * HOUR), address: "resolved@example.test",
  }).returning();
  const [draft] = await db.insert(drafts).values({ accountId: acct!.id, mailboxId: mb!.id }).returning();
  await db.insert(outboundSends).values({
    accountId: acct!.id, idempotencyKey: "idem-resolved", draftId: draft!.id,
    mintedMessageId: `<resolved@app.${managedDomain()}>`, status: "pending", createdAt: new Date(NOW.getTime() - HOUR),
  });
}

/** Page, resolve, pass inside the flap floor, then past it: the notice goes once. */
async function throughThePass(sink: AlertSink, bodies: string[]): Promise<{ resolvedBodies: string[]; spent: number }> {
  const db = await makeTestDb();
  await seedStuckSend(db);
  const pass = (ms: number) => runAlertPass(db, { now: at(ms), sinks: [sink], shards: [] });
  await pass(0);
  await db.update(outboundSends).set({ status: "sent" }).where(eq(outboundSends.idempotencyKey, "idem-resolved"));
  await pass(5 * MIN);
  const before = bodies.length;
  await pass(5 * MIN + HOUR + MIN);
  await pass(3 * HOUR);
  const [row] = await db.select({ n: alertState.notifyCount }).from(alertState)
    .where(eq(alertState.alertKey, "sends_stuck"));
  const after = bodies.slice(before);
  expect(after.every((b) => b.includes("resolved: sends_stuck")), "nothing but the notice after the page").toBe(true);
  return { resolvedBodies: after, spent: Number(row?.n) };
}

describe("the webhook arm says a critical resolved", () => {
  it("posts the resolution from the notice alone: a retry from another driver is the same bytes", async () => {
    const r = recorder();
    const sink = webhookAlertSink("https://hooks.example/alert", r.post)!;
    await sink.notifyResolved!([NOTICE], CTX);
    await sink.notifyResolved!([NOTICE], { ...CTX, source: "api", now: at(5 * MIN) });
    expect(r.bodies).toHaveLength(2);
    expect(r.bodies[1]).toBe(r.bodies[0]);
    const body = JSON.parse(r.bodies[0]!) as { title: string; text: string; resolved: Array<{ key: string }> };
    expect(body.title).toBe("ohmail test: 1 resolved");
    expect(body.text).toContain("sends_stuck (sends_stuck) — firing since 2026-09-29T06:00:00.000Z");
    expect(body.resolved.map((n) => n.key)).toEqual(["sends_stuck"]);
  });

  it("a deployment paging through the webhook alone is told, once", async () => {
    const r = recorder();
    const out = await throughThePass(webhookAlertSink("https://hooks.example/alert", r.post)!, r.bodies);
    expect(out.resolvedBodies).toHaveLength(1);
    expect(out.spent, "the told resolution spends the occurrence's page count").toBe(0);
  });
});

describe("the Telegram arm says a critical resolved", () => {
  it("posts the resolution text to the chat, the same bytes on a retry", async () => {
    const r = recorder();
    const sink = telegramAlertSink({ botToken: TOKEN, chatId: "-1001234567890" }, r.post)!;
    await sink.notifyResolved!([NOTICE], CTX);
    await sink.notifyResolved!([NOTICE], { ...CTX, source: "api", now: at(5 * MIN) });
    expect(r.bodies[1]).toBe(r.bodies[0]);
    const body = JSON.parse(r.bodies[0]!) as { chat_id: string; text: string };
    expect(body.chat_id).toBe("-1001234567890");
    expect(body.text).toMatch(/^ohmail test\n\nohmail test — resolved: sends_stuck/);
  });

  it("a deployment paging through Telegram alone is told, once", async () => {
    const r = recorder();
    const out = await throughThePass(telegramAlertSink({ botToken: TOKEN, chatId: "-1001234567890" }, r.post)!, r.bodies);
    expect(out.resolvedBodies).toHaveLength(1);
    expect(out.spent).toBe(0);
  });
});
