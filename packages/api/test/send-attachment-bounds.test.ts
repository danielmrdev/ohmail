import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxes, drafts } from "@trafficflow/db";
import type { AttachmentStagingStorage } from "@trafficflow/db/cloud";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { makeAttachmentStagingPort, SEND_MAX_ATTACHMENT_PARTS } from "@trafficflow/services";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * ═══ THE TWO ATTACHMENT LISTS ON `POST /drafts/:id/send`, BOUNDED AT THE DOOR ══════════════
 *
 * ## What was open
 *
 * `readStagedIds` filtered the array to non-empty strings and passed it on — no `Set`, no length
 * ceiling — and resolution then walked the REQUEST ARRAY with `await storage.download()` inside
 * the loop. One email-verified account could stage a single attachment declared as ONE BYTE and
 * then send a draft naming that one valid ticket thousands of times: the declared total stayed far
 * under every byte cap in the path (the declaration is one byte, however often it is repeated),
 * and the process made one object-storage round trip per occurrence. The amplification factor was
 * the array length, bought with a single authenticated request. The message that went out carried
 * the same file once per occurrence, which is a plain correctness bug on the same line.
 *
 * ## Why the BYTE cap was never going to close this, for either list
 *
 * It does not bound a list's LENGTH:
 *
 *  · a staged ticket may declare one byte — the mint's floor is a positive integer;
 *  · an INLINE entry carrying no `contentBase64` decodes to zero bytes, so any number of them sum
 *    to zero and clear every ceiling there is. For that list the count is the ONLY bound, which is
 *    why it is ruled here too rather than left as "the byte cap already handles it".
 *
 * ## The two rulings under test, and why they differ
 *
 *  · **A repeated STAGED id is collapsed, not refused.** It names an object, so naming it twice
 *    names one file. A skip rather than a 400 is the ruling the product already made one surface
 *    up — `ComposeAttach` answers a re-picked file with *"THE SAME FILE TWICE IS A SKIP, NOT A
 *    SECOND ROW"*, in the muted register, because nothing went wrong. A 400 here would contradict
 *    the form the user is looking at and spend a composed message on a client bug.
 *  · **INLINE entries are counted, never deduplicated.** They CARRY their bytes, so a duplicate
 *    costs the caller twice and is charged twice against the cap — nothing to amplify. Collapsing
 *    them would mean hashing every attachment on the send path to undo what the compose form
 *    already did.
 *
 * ## Both rulings are borrowed, not invented
 *
 * `PATCH /messages` already caps a client-supplied id array (`MARK_SEEN_MAX_IDS`), and it settles
 * the two questions this route would otherwise answer alone: it refuses on the **raw** array with
 * **`payload_too_large`/413**, then deduplicates what survives — *"the same id twice is one update
 * and one change"*. This route follows it exactly. The ceiling bounds how many references one
 * request may NAME; the dedupe decides how many files those references ARE. Two id lists on one
 * API disagreeing about either would be a distinction a client has to learn per route.
 *
 * ## The mutations these were watched against, and what each one actually did
 *
 *  · **neuter `refuseOverLongList`** → all three over-length tests answer **200**. The inline case
 *    is the instructive one: a long list of entries that decode to zero bytes are accepted and delivered with
 *    every byte ceiling in the path satisfied, which is precisely the claim that the byte cap
 *    already bounds that list, being false.
 *  · **drop the `dedupeStagedIds` call in `readStagedIds`** → the repeat tests keep their download
 *    count of 1, because `SendService` deduplicates as well. That is the layering working, and it
 *    is recorded rather than hidden: a mutation coming back green reads exactly like a guard that
 *    does not guard. The amplification is therefore mutation-watched where the loop is —
 *    `packages/services/test/attachment-staging-store.test.ts` (five downloads for one object) and
 *    `packages/services/test/send-staged-dedupe.pg.test.ts` (fifty, on real Postgres, with both
 *    layers removed).
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

const MIB = 1024 * 1024;

/** A send adapter that records the message — no network, ever. */
function fakeAdapter() {
  const state = { sendCalls: 0, sent: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      state.sent.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to release */ },
  });
  return { factory, state };
}

/**
 * An in-memory bucket that COUNTS DOWNLOADS PER OBJECT PATH.
 *
 * The count is the whole point of this fixture. "One attachment came back" and "one request went
 * to object storage" are two different claims, and only the second is about the cost an
 * authenticated caller can make this process incur — so the guards assert the port's own tally
 * rather than inferring it from the delivered message.
 */
function countingStorage() {
  const objects: Record<string, Uint8Array> = {};
  const downloads: Record<string, number> = {};
  const storage: AttachmentStagingStorage = {
    async signUpload(objectPath) {
      return {
        uploadUrl: `https://storage.example/${objectPath}?token=t`,
        uploadMethod: "PUT",
        uploadHeaders: { "x-upsert": "false" },
      };
    },
    async download(objectPath) {
      downloads[objectPath] = (downloads[objectPath] ?? 0) + 1;
      const bytes = objects[objectPath];
      if (!bytes) throw new Error("no such object");
      return bytes;
    },
    async remove(paths) {
      for (const p of paths) delete objects[p];
    },
  };
  return { storage, objects, downloads, total: () => Object.values(downloads).reduce((a, b) => a + b, 0) };
}

/**
 * A signed-in account, a mailbox, a draft, and the REAL staging port over the counting bucket.
 *
 * The port is `makeAttachmentStagingPort` rather than a stub because the property under test runs
 * through its `fetch` — a hand-written fake would be free to answer once per distinct id whatever
 * the code does, which is the assertion pretending to be the fixture.
 */
async function armed(smtpMaxSizeBytes: number | null = 25 * MIB) {
  const { factory, state } = fakeAdapter();
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
  const s = await seedSession(db, { now: FIXED_NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: "mila@lichtgrat.example", smtpMaxSizeBytes,
  }).returning();
  const bucket = countingStorage();
  const port = makeAttachmentStagingPort({ db, storage: bucket.storage });

  /**
   * Mint a ticket AND put its bytes in the bucket — a completed client-side upload.
   *
   * A DISTINCT KEY PER FILE, because the mint's identity is its `Idempotency-Key`: two files
   * staged under one key are one ticket, which is the whole point of the key and is not what a
   * multi-file fixture means.
   */
  let staged = 0;
  async function stage(filename: string, size: number): Promise<string> {
    const grant = await port.mint({
      accountId: s.accountId, filename, contentType: "application/octet-stream",
      sizeBytes: size, now: FIXED_NOW, idempotencyKey: `bounds:att:${staged++}`,
    });
    const objectPath = new URL(grant.uploadUrl).pathname.replace(/^\//, "");
    bucket.objects[objectPath] = new Uint8Array(size).fill(7);
    return grant.id;
  }

  async function newDraft(): Promise<string> {
    const [d] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId: mb!.id, subject: "with a file", body: "here",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
    }).returning();
    return d!.id;
  }

  const armedDeps = {
    ...deps,
    services: { ...deps.services!, attachmentStaging: () => port },
  } as ApiDeps;

  const send = (draftId: string, body: unknown, key: string): Promise<Response> =>
    H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": key }, body: JSON.stringify(body),
    }), armedDeps);

  return { db, s, bucket, stage, newDraft, send, sent: state };
}

describe("a staged ticket named many times is ONE download and ONE attachment", () => {
  it("50 repeats of one ticket: the object is fetched once and the file rides once", async () => {
    const a = await armed();
    const id = await a.stage("invoice.pdf", 1);
    const draftId = await a.newDraft();

    const res = await a.send(draftId, { stagedAttachmentIds: Array(50).fill(id) }, "repeat-50");

    // Inside the ceiling, so the ruling under test here is the DEDUPE and nothing else: 50 namings
    // of one ticket are one file, and the message sends.
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("sent");
    // THE AMPLIFICATION ASSERTION.
    expect(a.bucket.total()).toBe(1);
    // The correctness half: the recipient gets the file once.
    expect(a.sent.sent[0]!.attachments).toHaveLength(1);
    expect(a.sent.sent[0]!.attachments![0]!.filename).toBe("invoice.pdf");
  });

  it("a one-byte ticket repeated is not admitted by weighing one byte 100 times", async () => {
    // The exact shape of the report: the declared total is what bounds the fetch, and repeating a
    // one-byte declaration kept every occurrence under the byte cap however long the list got.
    // Deduplicated, the declared total and the fetched total are the same number again.
    const a = await armed(3 * MIB);
    const id = await a.stage("tiny.bin", 1);
    const res = await a.send(
      await a.newDraft(),
      { stagedAttachmentIds: Array(SEND_MAX_ATTACHMENT_PARTS).fill(id) },
      "repeat-tiny",
    );
    expect(res.status).toBe(200);
    expect(a.bucket.total()).toBe(1);
  });

  it("repeats COUNT toward the ceiling — the cap reads the list as sent, not as resolved", async () => {
    // The half the dedupe does not soften, and the ordering `MARK_SEEN_MAX_IDS` already chose.
    // 101 namings of one ticket is one file, and it is still refused: the ceiling is a statement
    // about how many references a request may carry, made before anything is interpreted.
    const a = await armed();
    const id = await a.stage("invoice.pdf", 1);

    const res = await a.send(
      await a.newDraft(),
      { stagedAttachmentIds: Array(SEND_MAX_ATTACHMENT_PARTS + 1).fill(id) },
      "repeat-over-cap",
    );

    expect(res.status).toBe(413);
    expect(a.bucket.total()).toBe(0);
    expect(a.sent.sendCalls).toBe(0);
  });

  it("a legitimate multi-file staged send is unchanged: one download each, in order", async () => {
    const a = await armed();
    const first = await a.stage("first.bin", 16);
    const second = await a.stage("second.bin", 32);
    const third = await a.stage("third.bin", 48);

    const res = await a.send(
      await a.newDraft(),
      { stagedAttachmentIds: [first, second, third] },
      "three-files",
    );

    expect(res.status).toBe(200);
    expect(a.bucket.total()).toBe(3);
    expect(a.sent.sent[0]!.attachments!.map((x) => x.filename))
      .toEqual(["first.bin", "second.bin", "third.bin"]);
  });

  it("interleaved duplicates keep first-appearance order and fetch each object once", async () => {
    const a = await armed();
    const first = await a.stage("first.bin", 16);
    const second = await a.stage("second.bin", 32);

    const res = await a.send(
      await a.newDraft(),
      { stagedAttachmentIds: [second, first, second, first, second] },
      "interleaved",
    );

    expect(res.status).toBe(200);
    expect(a.bucket.total()).toBe(2);
    expect(a.sent.sent[0]!.attachments!.map((x) => x.filename))
      .toEqual(["second.bin", "first.bin"]);
  });
});

describe("the count ceiling — both lists, refused before anything is fetched", () => {
  it(`${SEND_MAX_ATTACHMENT_PARTS + 1} DISTINCT staged ids → 413, naming both numbers`, async () => {
    const a = await armed();
    const ids: string[] = [];
    for (let i = 0; i <= SEND_MAX_ATTACHMENT_PARTS; i += 1) ids.push(await a.stage(`f${i}.bin`, 1));
    expect(ids).toHaveLength(SEND_MAX_ATTACHMENT_PARTS + 1);

    const res = await a.send(await a.newDraft(), { stagedAttachmentIds: ids }, "too-many-staged");

    // 413 and not 400, matching `MARK_SEEN_MAX_IDS` — the same refusal about the same shape of
    // thing, an over-long client-supplied id array on one write.
    expect(res.status).toBe(413);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("payload_too_large");
    // ACTIONABLE: the count it sent and the count it may send. A bare "too many" leaves the client
    // guessing at the number it has to get under.
    expect(body.error.message).toContain(String(SEND_MAX_ATTACHMENT_PARTS + 1));
    expect(body.error.message).toContain(`at most ${SEND_MAX_ATTACHMENT_PARTS}`);
    // Refused at the door: no object was read and no reservation was opened.
    expect(a.bucket.total()).toBe(0);
    expect(a.sent.sendCalls).toBe(0);
  });

  it(`exactly ${SEND_MAX_ATTACHMENT_PARTS} staged ids is ACCEPTED — the ceiling is inclusive`, async () => {
    const a = await armed();
    const ids: string[] = [];
    for (let i = 0; i < SEND_MAX_ATTACHMENT_PARTS; i += 1) ids.push(await a.stage(`f${i}.bin`, 1));

    const res = await a.send(await a.newDraft(), { stagedAttachmentIds: ids }, "exactly-max");

    expect(res.status).toBe(200);
    expect(a.bucket.total()).toBe(SEND_MAX_ATTACHMENT_PARTS);
    expect(a.sent.sent[0]!.attachments).toHaveLength(SEND_MAX_ATTACHMENT_PARTS);
  });

  it(`${SEND_MAX_ATTACHMENT_PARTS + 1} INLINE attachments → 413, though they weigh NOTHING`, async () => {
    // The case the byte cap cannot see. Every entry here decodes to zero bytes, so the total is 0
    // and every ceiling in the path is satisfied — the count is the only thing refusing it.
    const a = await armed();
    const attachments = Array.from({ length: SEND_MAX_ATTACHMENT_PARTS + 1 }, (_, i) => ({
      filename: `empty-${i}.bin`,
    }));

    const res = await a.send(await a.newDraft(), { attachments }, "too-many-inline");

    expect(res.status).toBe(413);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("payload_too_large");
    expect(body.error.message).toContain(`at most ${SEND_MAX_ATTACHMENT_PARTS}`);
    expect(a.sent.sendCalls).toBe(0);
  });

  it(`exactly ${SEND_MAX_ATTACHMENT_PARTS} inline attachments still send`, async () => {
    const a = await armed();
    const attachments = Array.from({ length: SEND_MAX_ATTACHMENT_PARTS }, (_, i) => ({
      filename: `f-${i}.bin`,
      contentType: "application/octet-stream",
      contentBase64: Buffer.from(`file ${i}`).toString("base64"),
    }));

    const res = await a.send(await a.newDraft(), { attachments }, "inline-max");

    expect(res.status).toBe(200);
    expect(a.sent.sent[0]!.attachments).toHaveLength(SEND_MAX_ATTACHMENT_PARTS);
  });

  it("DUPLICATE inline attachments are kept, not collapsed — they carry their own bytes", async () => {
    // The deliberate asymmetry with the staged list. Two identical inline entries are two
    // payloads the caller actually transmitted and is charged for twice; there is no reference to
    // amplify, and the compose form already collapses what a user picked twice.
    const a = await armed();
    const one = {
      filename: "same.bin",
      contentType: "application/octet-stream",
      contentBase64: Buffer.from("identical").toString("base64"),
    };

    const res = await a.send(await a.newDraft(), { attachments: [one, one, one] }, "inline-dupes");

    expect(res.status).toBe(200);
    expect(a.sent.sent[0]!.attachments).toHaveLength(3);
  });

  it("an ordinary send with no attachment keys at all is untouched", async () => {
    const a = await armed();
    const res = await a.send(await a.newDraft(), {}, "plain");
    expect(res.status).toBe(200);
    expect(a.sent.sent[0]!.attachments).toBeUndefined();
    expect(a.bucket.total()).toBe(0);
  });
});
