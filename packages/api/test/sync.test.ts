import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function createRule(deps: ApiDeps, token: string, match = "a@b.example"): Promise<{ id: string; seq: string }> {
  const res = await H(req("POST", "/rules", {
    bearer: token,
    body: JSON.stringify({ kind: "sender", match, destination: "INBOX" }),
  }), deps);
  expect(res.status).toBe(201);
  const dto = await res.json();
  return { id: dto.id, seq: res.headers.get("x-sync-seq")! };
}

describe("GET /sync", () => {
  it("round-trips a rule create → cursor advances → empty tail with the same cursor", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const { id } = await createRule(deps, s.token);

    // First /sync from bootstrap sees the create.
    const first = await H(req("GET", "/sync?since=0", { bearer: s.token }), deps);
    expect(first.status).toBe(200);
    const body1 = await first.json();
    expect(body1.changes.creates.map((c: { id: string }) => c.id)).toContain(id);
    expect(body1.changes.creates[0].type).toBe("rule");
    expect(body1.hasMore).toBe(false);
    const cursor = body1.cursor;
    expect(cursor).toBeTruthy();

    // Tailing from that cursor is empty and returns the SAME cursor.
    const second = await H(req("GET", `/sync?since=${encodeURIComponent(cursor)}`, { bearer: s.token }), deps);
    const body2 = await second.json();
    expect(body2.changes.creates).toHaveLength(0);
    expect(body2.changes.updates).toHaveLength(0);
    expect(body2.cursor).toBe(cursor);
    expect(body2.hasMore).toBe(false);
  });

  it("a malformed cursor → 410 cursor_expired", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/sync?since=not-a-valid-cursor", { bearer: s.token }), deps);
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("cursor_expired");
  });

  it("?types= filters to the named EntityType (unknown tokens ignored)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await createRule(deps, s.token);

    // rule is included; a bogus type token is dropped, leaving only 'rule'.
    const res = await H(req("GET", "/sync?since=0&types=rule,bogus", { bearer: s.token }), deps);
    const body = await res.json();
    expect(body.changes.creates.every((c: { type: string }) => c.type === "rule")).toBe(true);
    expect(body.changes.creates.length).toBeGreaterThan(0);

    // filtering to a different type yields nothing.
    const res2 = await H(req("GET", "/sync?since=0&types=message", { bearer: s.token }), deps);
    const body2 = await res2.json();
    expect(body2.changes.creates).toHaveLength(0);
  });

  /**
   * `tag` IS A NAMEABLE TYPE, and it was not.
   *
   * An unknown token is DROPPED rather than refused, which makes a missing entry silent in the
   * worst way: a caller asking for `types=message,tag` was answered with messages alone and had
   * no way to distinguish that from an account with no tags. The one caller that names its types
   * is the desktop's mirror of a hosted account, so the symptom was an empty tag rail on the
   * desktop over an account whose browser tab showed several.
   *
   * Asserted through the route rather than over the constant, so the test fails for the reason a
   * user would notice — the tag is absent from the answer — rather than because a list changed.
   */
  it("?types=tag is honoured rather than silently dropped", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    /* A RULE AS WELL AS A TAG, and that is what makes the assertion bite. A `types=` list whose
       every token is unknown collapses to "no filter at all" — so with `tag` unrecognised the
       answer still CONTAINS the tag, alongside everything else, and an assertion that only looked
       for the tag would pass over the defect. What separates the two readings is whether the rule
       came back with it. */
    const rule = await createRule(deps, s.token);
    const made = await H(req("POST", "/tags", {
      bearer: s.token,
      body: JSON.stringify({ name: "Invoices" }),
    }), deps);
    expect(made.status).toBe(201);
    const tag = await made.json();

    const res = await H(req("GET", "/sync?since=0&types=tag", { bearer: s.token }), deps);
    const body = await res.json();
    const ids = body.changes.creates.map((c: { id: string }) => c.id);
    expect(ids).toContain(tag.id);
    expect(ids, "an unrecognised `tag` token collapses the filter and lets everything through")
      .not.toContain(rule.id);
  });

  /**
   * `settings` IS A NAMEABLE TYPE — `tag`'s trap, closed for the next member the same day it
   * joined the union. The one caller that names its types is the desktop's mirror of a hosted
   * account, and the settings entity is the doorbell that lets a consent knob flipped on the
   * web reach an open desktop window; a filter that silently dropped the token would starve
   * exactly that path while every test that feeds changes to the mirror directly stayed green.
   * The rule rides along for the tag test's reason: an all-unknown list collapses to "no
   * filter", so only the rule's ABSENCE separates "honoured" from "collapsed".
   */
  it("?types=settings is honoured rather than silently dropped", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const rule = await createRule(deps, s.token);

    const flipped = await H(req("PATCH", "/consent/settings", {
      bearer: s.token,
      body: JSON.stringify({ blockRemoteImages: true }),
    }), deps);
    expect(flipped.status).toBe(200);

    const res = await H(req("GET", "/sync?since=0&types=settings", { bearer: s.token }), deps);
    const body = await res.json();
    const all = [...body.changes.creates, ...body.changes.updates];
    const settingsRows = all.filter((c: { type: string }) => c.type === "settings");
    expect(settingsRows.length, "the settings doorbell never crossed the route filter").toBeGreaterThan(0);
    expect(all.map((c: { id: string }) => c.id), "an unrecognised token collapses the filter")
      .not.toContain(rule.id);
    expect(body.changes.deletes.filter((c: { type: string }) => c.type === "settings")).toHaveLength(0);
  });

  it("requires a session (401 unauthenticated)", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/sync?since=0"), deps);
    expect(res.status).toBe(401);
  });
});

/**
 * The bootstrap reader, over HTTP. The behaviour of the projection, the window and the
 * consistency point is asserted where it lives (`packages/services/test/sync-snapshot*.ts`);
 * what is asserted HERE is the wiring: the route exists at two segments without shadowing
 * `/sync`, its account comes from the session and from nothing else, its cursor survives a
 * round trip through a query string, and a bad one is the same 410 the delta gives.
 */
describe("GET /sync/snapshot", () => {
  it("serves the delta vocabulary — op:create at seq === asOfSeq — plus the window", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await createRule(deps, s.token);

    const res = await H(req("GET", "/sync/snapshot", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();

    // The window crosses the wire whole — both floors and the row ceiling. Pinned as a LITERAL
    // here and against the constant next door, because this is the route's own byte shape.
    expect(body.window).toEqual({ days: 90, minRows: 5000, maxRows: 10_000 });
    expect(typeof body.asOfSeq).toBe("number");
    expect(body.nextCursor).toBeNull();
    expect(body.changes.map((c: { id: string }) => c.id)).toContain(id);
    for (const c of body.changes) {
      expect(c.op).toBe("create");
      expect(c.seq).toBe(body.asOfSeq);
    }

    // The delta cursor a client uses next IS `asOfSeq`, and tailing from it is empty — which is
    // the whole handoff between the two routes, asserted rather than assumed.
    const tail = await H(req("GET", `/sync?since=${encodeURIComponent(
      Buffer.from(String(body.asOfSeq), "utf8").toString("base64url"),
    )}`, { bearer: s.token }), deps);
    const tailBody = await tail.json();
    expect(tailBody.changes.creates).toHaveLength(0);
  });

  /**
   * `?phase=tail` REACHES THE SERVICE. What the tail IS lives in
   * `packages/services/test/sync-snapshot.test.ts`; what is asserted here is that the query
   * parameter is read at all and that only the one value is admitted — a route that parsed it
   * into nothing would leave every service guard passing and the client walking the whole
   * mailbox.
   *
   * The VOCABULARY is decided HERE and only here — `input-bounds-census` asks for a caller-chosen
   * value's bound at the read, and `getSnapshot` reads presence rather than spelling — so this is
   * the control for it.
   *
   * WATCHED RED by deleting the `phase` spread from the handler's `getSnapshot` call (the tail
   * arm), and by `?? undefined` in place of the `=== "tail"` test (every misspelling becomes a
   * tail, because `getSnapshot` then sees a value where it expects none).
   */
  it("reads `?phase=tail`, and admits no other value", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id: ruleId } = await createRule(deps, s.token);

    const tail = await (await H(req("GET", "/sync/snapshot?phase=tail", { bearer: s.token }), deps)).json();
    // The tail carries no page-1 live state — the rule is the one row this fixture has.
    expect(tail.changes.map((c: { id: string }) => c.id)).not.toContain(ruleId);

    // ANY other spelling is the ordinary walk, which is the safe direction for a parameter a
    // future client might get wrong. The last pair pins the FIRST value winning — a repeated
    // parameter is read once, and reading the last one would flip this answer.
    for (const q of ["phase=TAIL", "phase=tale", "phase=", "phase=window&phase=tail"]) {
      const body = await (await H(req("GET", `/sync/snapshot?${q}`, { bearer: s.token }), deps)).json();
      expect(body.changes.map((c: { id: string }) => c.id), q).toContain(ruleId);
    }
  });

  it("pages through `?cursor=` — the opaque string survives a query string intact", async () => {
    // The cursor is base64url and therefore needs no escaping, which is exactly the kind of
    // claim that is true until somebody changes the encoding. Driven end to end here.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await seedMessage(db, {
        accountId: s.accountId, mailboxId,
        date: new Date(FIXED_NOW.getTime() - i * 60_000), subject: `p${i}`,
      });
      ids.push(m.id);
    }
    await createRule(deps, s.token);

    const seen: string[] = [];
    let url = "/sync/snapshot?limit=1";
    let asOfSeq: number | null = null;
    for (let guard = 0; ; guard += 1) {
      const body = await (await H(req("GET", url, { bearer: s.token }), deps)).json();
      if (asOfSeq === null) asOfSeq = body.asOfSeq; else expect(body.asOfSeq).toBe(asOfSeq);
      seen.push(...body.changes
        .filter((c: { type: string }) => c.type === "message")
        .map((c: { id: string }) => c.id));
      if (body.nextCursor === null) break;
      url = `/sync/snapshot?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`;
      if (guard > 20) throw new Error("snapshot paging did not terminate");
    }
    expect(seen).toEqual(ids);   // newest first, exactly once each
  });

  it("a malformed cursor → 410 cursor_expired, exactly as the delta does", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/sync/snapshot?cursor=not-a-valid-cursor", { bearer: s.token }), deps);
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("cursor_expired");
  });

  it("scopes to the SESSION's account — there is no account parameter to pass", async () => {
    // Two real sessions in one database. The second must not see the first's rule, and the
    // request carries nothing that could ask it to.
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW });
    const { id } = await createRule(deps, a.token);

    const mine = await H(req("GET", "/sync/snapshot", { bearer: a.token }), deps);
    expect((await mine.json()).changes.map((c: { id: string }) => c.id)).toContain(id);

    const theirs = await H(req("GET", "/sync/snapshot", { bearer: b.token }), deps);
    const theirBody = await theirs.json();
    expect(theirs.status).toBe(200);
    expect(theirBody.changes.map((c: { id: string }) => c.id)).not.toContain(id);
  });

  it("requires a session (401 unauthenticated)", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/sync/snapshot"), deps);
    expect(res.status).toBe(401);
  });

  it("does not shadow, and is not shadowed by, `GET /sync`", async () => {
    // Two segments against one. A router that matched on prefix would serve one of these as the
    // other, and both answer 200 with a plausible JSON body — so the discriminator is the SHAPE.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const delta = await (await H(req("GET", "/sync?since=0", { bearer: s.token }), deps)).json();
    const snap = await (await H(req("GET", "/sync/snapshot", { bearer: s.token }), deps)).json();
    expect(delta.cursor).toBeDefined();
    expect(delta.window).toBeUndefined();
    expect(snap.window).toBeDefined();
    expect(snap.cursor).toBeUndefined();
  });
});

describe("GET /sync stamps devices.last_synced_at — the device_sync_stale alert's input", () => {
  async function seedDeviceSession(db: Awaited<ReturnType<typeof makeDeps>>["db"]) {
    const base = await seedSession(db, { now: FIXED_NOW });
    const { devices } = await import("@trafficflow/db");
    const [dev] = await db.insert(devices).values({
      accountId: base.accountId, userId: base.userId, kind: "macos", label: "ohmail for Mac",
    }).returning();
    const { seedSessionFor } = await import("./helpers.js");
    const s = await seedSessionFor(db, {
      accountId: base.accountId, userId: base.userId, now: FIXED_NOW, deviceId: dev!.id,
    });
    return { ...s, accountId: base.accountId, deviceId: dev!.id, devices };
  }

  it("only the COMMITTED horizon stamps: the final page does not, the empty tail after it does", async () => {
    const { db, deps } = await makeDeps();
    const { token, deviceId, devices } = await seedDeviceSession(db);
    await createRule(deps, token);

    // The final page: rows handed over, hasMore false — but the client has not committed them.
    const final = await H(req("GET", "/sync?since=0", { bearer: token }), deps);
    const finalBody = await final.json();
    expect(finalBody.hasMore).toBe(false);
    expect(finalBody.changes.creates.length).toBeGreaterThan(0);
    const [afterFinal] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(afterFinal!.lastSyncedAt,
      "a page handed over is not a page applied — the final page must not stamp").toBeNull();

    // The empty tail: the client PRESENTS the horizon cursor, which both mirrors write only
    // after committing the page it names. That is the proof, and that is what stamps.
    const tail = await H(req("GET", `/sync?since=${encodeURIComponent(finalBody.cursor)}`, { bearer: token }), deps);
    expect((await tail.json()).hasMore).toBe(false);
    const [afterTail] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(afterTail!.lastSyncedAt, "a presented horizon is a committed drain — stamp it").not.toBeNull();
  });

  it("a page mid-backlog (hasMore: true) stamps NOTHING — requests are not convergence", async () => {
    const { db, deps } = await makeDeps();
    const { token, deviceId, devices } = await seedDeviceSession(db);
    // Two rules, page limit 1: the first page says hasMore=true. Two senders, because a second
    // create of one key answers the existing rule and records nothing.
    await createRule(deps, token);
    await createRule(deps, token, "c@d.example");

    const res = await H(req("GET", "/sync?since=0&limit=1", { bearer: token }), deps);
    expect((await res.json()).hasMore).toBe(true);

    const [dev] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(dev!.lastSyncedAt,
      "a mirror stuck re-paging a backlog forever must never look current").toBeNull();
  });

  it("the stamp is throttled in the statement — a poll 20s later rewrites nothing", async () => {
    const { db, deps } = await makeDeps();
    const { token, deviceId, devices } = await seedDeviceSession(db);
    await createRule(deps, token);
    const horizon = (await (await H(req("GET", "/sync?since=0", { bearer: token }), deps)).json()).cursor;
    const poll = `/sync?since=${encodeURIComponent(horizon)}`;

    await H(req("GET", poll, { bearer: token }), deps);
    const [first] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(first!.lastSyncedAt).not.toBeNull();

    const later = { ...deps, now: () => new Date(FIXED_NOW.getTime() + 20_000) };
    await H(req("GET", poll, { bearer: token }), later);
    const [second] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(second!.lastSyncedAt!.getTime(),
      "inside the five-minute window the row must not be rewritten").toBe(first!.lastSyncedAt!.getTime());

    const past = { ...deps, now: () => new Date(FIXED_NOW.getTime() + 6 * 60_000) };
    await H(req("GET", poll, { bearer: token }), past);
    const [third] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(third!.lastSyncedAt!.getTime(),
      "past the window the stamp advances").toBeGreaterThan(first!.lastSyncedAt!.getTime());
  });
});

describe("GET /sync stamps sessions.last_synced_at — the session_sync_stale alert's input (mail 0070)", () => {
  it("a DEVICELESS session stamps on the empty tail and not on the final page — the incident's install shape", async () => {
    // The population 0064's device stamp cannot see: a browser-door desktop or plain web tab
    // holds a `device_id IS NULL` session (mail 0061) and no device row at all. The first real
    // staleness incident was exactly this shape — wedged for days, invisible to every
    // device-level signal. The session stamp is what puts it inside an alarm's population.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { sessions } = await import("@trafficflow/db");
    await createRule(deps, s.token);

    const final = await H(req("GET", "/sync?since=0", { bearer: s.token }), deps);
    const finalBody = await final.json();
    expect(finalBody.hasMore).toBe(false);
    const [afterFinal] = await db.select().from(sessions).where(eq(sessions.id, s.sessionId));
    expect(afterFinal!.lastSyncedAt,
      "the final page is handed over, not applied — no stamp yet").toBeNull();

    const tail = await H(req("GET", `/sync?since=${encodeURIComponent(finalBody.cursor)}`, { bearer: s.token }), deps);
    expect((await tail.json()).hasMore).toBe(false);
    const [afterTail] = await db.select().from(sessions).where(eq(sessions.id, s.sessionId));
    expect(afterTail!.lastSyncedAt,
      "a presented horizon is a committed drain — the SESSION stamps even with no device row").not.toBeNull();
  });

  it("a device-backed session stamps BOTH rows — the device alert keeps its population", async () => {
    const { db, deps } = await makeDeps();
    const base = await seedSession(db, { now: FIXED_NOW });
    const { devices, sessions } = await import("@trafficflow/db");
    const [dev] = await db.insert(devices).values({
      accountId: base.accountId, userId: base.userId, kind: "macos", label: "ohmail for Mac",
    }).returning();
    const { seedSessionFor } = await import("./helpers.js");
    const s = await seedSessionFor(db, {
      accountId: base.accountId, userId: base.userId, now: FIXED_NOW, deviceId: dev!.id,
    });
    await createRule(deps, s.token);
    const horizon = (await (await H(req("GET", "/sync?since=0", { bearer: s.token }), deps)).json()).cursor;
    await H(req("GET", `/sync?since=${encodeURIComponent(horizon)}`, { bearer: s.token }), deps);

    const [sess] = await db.select().from(sessions).where(eq(sessions.id, s.sessionId));
    const [device] = await db.select().from(devices).where(eq(devices.id, dev!.id));
    expect(sess!.lastSyncedAt, "the session stamp is universal").not.toBeNull();
    expect(device!.lastSyncedAt, "the device stamp still lands beside it").not.toBeNull();
  });

  it("the session stamp is throttled in the statement, like the device's", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { sessions } = await import("@trafficflow/db");
    await createRule(deps, s.token);
    const horizon = (await (await H(req("GET", "/sync?since=0", { bearer: s.token }), deps)).json()).cursor;
    const poll = `/sync?since=${encodeURIComponent(horizon)}`;

    await H(req("GET", poll, { bearer: s.token }), deps);
    const [first] = await db.select().from(sessions).where(eq(sessions.id, s.sessionId));
    expect(first!.lastSyncedAt).not.toBeNull();

    const later = { ...deps, now: () => new Date(FIXED_NOW.getTime() + 20_000) };
    await H(req("GET", poll, { bearer: s.token }), later);
    const [second] = await db.select().from(sessions).where(eq(sessions.id, s.sessionId));
    expect(second!.lastSyncedAt!.getTime(),
      "inside the five-minute window the row must not be rewritten").toBe(first!.lastSyncedAt!.getTime());

    const past = { ...deps, now: () => new Date(FIXED_NOW.getTime() + 6 * 60_000) };
    await H(req("GET", poll, { bearer: s.token }), past);
    const [third] = await db.select().from(sessions).where(eq(sessions.id, s.sessionId));
    expect(third!.lastSyncedAt!.getTime(),
      "past the window the stamp advances").toBeGreaterThan(first!.lastSyncedAt!.getTime());
  });
});

describe("POST /sync/pull — the worker doorbell behind Pull-new-mail", () => {
  const stampOf = async (db: Awaited<ReturnType<typeof makeDeps>>["db"], id: string) =>
    (await db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes).where(eq(mailboxes.id, id)))[0]!.at;

  it("stamps sync_requested_at on every CONNECTED mailbox of the caller's account, and only theirs", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mine = await seedMailbox(db, { accountId: s.accountId });
    const disabled = await seedMailbox(db, { accountId: s.accountId });
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, disabled));
    const other = await seedSession(db, { now: FIXED_NOW });
    const theirs = await seedMailbox(db, { accountId: other.accountId });

    const res = await H(req("POST", "/sync/pull", { bearer: s.token, body: "{}" }), deps);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.requested).toBe(1);
    // THE CONTRACT IS PER MAILBOX: each row answers with ITS effective request instant, at the
    // database's own clock — the client compares it only against `lastSyncAt`, which the worker
    // also writes with SQL now(), so no host wall clock enters the settle.
    expect(body.mailboxes).toHaveLength(1);
    expect(body.mailboxes[0].id).toBe(mine);
    // FIXED ISO-8601 UTC on the wire — a bare `::text` renders at the server's DateStyle
    // (space + `+00`), which Date.parse may refuse, turning every baseline NaN and every pull
    // into a 30 s spin. The shape is pinned, not just parseability, so a lenient engine cannot
    // hide a format regression.
    expect(body.mailboxes[0].requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isFinite(Date.parse(body.mailboxes[0].requestedAt))).toBe(true);

    expect(await stampOf(db, mine)).not.toBeNull();
    // A disabled mailbox is not being organized; ringing for it would be a promise nobody keeps.
    expect(await stampOf(db, disabled)).toBeNull();
    // …and somebody else's mailbox is not the caller's to hurry.
    expect(await stampOf(db, theirs)).toBeNull();
  });

  it("a second pull inside the gap re-stamps NOTHING and answers the STANDING stamp as that mailbox's baseline", async () => {
    // The rate limit lives in the UPDATE's own predicate, evaluated against the DATABASE's
    // clock: a stamp younger than the gap is already being answered (the worker's kick scan
    // clears it within seconds of acting), so a held-down refresh degrades to one worker visit
    // per gap, not one per tap. The standing stamp is RETURNED as that mailbox's baseline — a
    // caller waiting on this call's instant would wait on a bar the already-owed visit never
    // aimed at (review 2026-08-26 round 1, finding 1). Mutation evidence: dropping the age
    // predicate from `requestPull` makes the second call move the stamp and turns the equality
    // below red — watched fail on 2026-08-26 when the route landed.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });

    const first = await H(req("POST", "/sync/pull", { bearer: s.token, body: "{}" }), deps);
    const firstBody = await first.json();
    expect(firstBody.requested).toBe(1);
    const stamped = await stampOf(db, mb);
    expect(stamped).not.toBeNull();

    const second = await H(req("POST", "/sync/pull", { bearer: s.token, body: "{}" }), deps);
    const body = await second.json();
    expect(body.requested, "the standing ring is reported, not denied").toBe(1);
    expect((await stampOf(db, mb))!.getTime(), "the stamp did not move inside the gap")
      .toBe(stamped!.getTime());
    // The baseline handed back IS the standing stamp — per mailbox, not this call's clock.
    expect(new Date(body.mailboxes[0].requestedAt).getTime()).toBe(stamped!.getTime());
  });

  it("past the gap — a request the worker has plausibly missed — a pull re-stamps", async () => {
    // The gap is judged by the DATABASE (`now() - interval`), never by a host clock, so the
    // test backdates the stamp in SQL rather than advancing a JS clock the predicate cannot see.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    await H(req("POST", "/sync/pull", { bearer: s.token, body: "{}" }), deps);
    await db.execute(
      sql`update mailboxes set sync_requested_at = now() - interval '10 seconds' where id = ${mb}`,
    );
    const backdated = await stampOf(db, mb);

    const res = await H(req("POST", "/sync/pull", { bearer: s.token, body: "{}" }), deps);
    const body = await res.json();
    expect(body.requested).toBe(1);
    expect((await stampOf(db, mb))!.getTime()).toBeGreaterThan(backdated!.getTime());
  });

  it("an account with no connected mailbox gets requested: 0 and nothing to wait for", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("POST", "/sync/pull", { bearer: s.token, body: "{}" }), deps);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.requested).toBe(0);
    expect(body.mailboxes).toEqual([]);
  });
});
