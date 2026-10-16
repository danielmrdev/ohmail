import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { RENDERABLE_HUES } from "@trafficflow/services";
import { makeDeps, seedSession, seedMessage, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/**
 * /tags AT THE HTTP LAYER — the round trip that decides whether this feature exists.
 *
 * The service tests prove rows land correctly and the pg tests prove the concurrency. What
 * neither can prove is the thing that was actually broken for the whole of Stage 2: that a tag
 * put on a message through the WIRE comes back through the wire the client reads. The UI's
 * entire read path is `/sync` → `MessageDTO.labels` → `tags.filter(t => labels.includes(t.id))`,
 * and every link in it was present and green while the feature did nothing, because the tag
 * subsystem was served by fixtures and the server's `labels` was a hardcoded `[]`.
 *
 * So the first test is deliberately shaped like a user session rather than like a unit: create,
 * assign, then DRAIN — and assert the tag arrives as an entity AND on the message. That is the
 * "tag it, reload, it is still there" acceptance, expressed at the highest layer that can run
 * deterministically in CI.
 */
describe("/tags — the round trip the UI actually performs", () => {
  it("create → assign → /sync carries BOTH the tag and the message's labels", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const msg = await seedMessage(db, { accountId: s.accountId, subject: "Invoice 41" });

    // A real account starts with NO tags — the state that made the built picker useless.
    const empty = await H(req("GET", "/tags", { bearer: s.token }), deps);
    expect(empty.status).toBe(200);
    expect((await empty.json()).items).toEqual([]);

    const created = await H(req("POST", "/tags", {
      bearer: s.token, body: JSON.stringify({ name: "Invoices", hue: "ochre" }),
    }), deps);
    expect(created.status).toBe(201);
    const tag = await created.json();
    expect(tag.name).toBe("Invoices");
    expect(tag.hue).toBe("ochre");
    // No `className` on the wire — presentation is the client's, derived from `hue`.
    expect(tag).not.toHaveProperty("className");

    const assigned = await H(req("POST", `/messages/${msg.id}/tags`, {
      bearer: s.token, body: JSON.stringify({ tagId: tag.id, assigned: true }),
    }), deps);
    expect(assigned.status).toBe(200);
    expect((await assigned.json()).labels).toEqual([tag.id]);

    // THE DRAIN. This is the "reload" — the client throws away nothing and re-reads from seq 0,
    // exactly as a fresh page load does.
    const sync = await H(req("GET", "/sync?since=0&limit=200", { bearer: s.token }), deps);
    expect(sync.status).toBe(200);
    const body = await sync.json();
    const all = [
      ...body.changes.creates, ...body.changes.updates,
      ...body.changes.moves, ...body.changes.deletes,
    ];

    const tagChange = all.find((c: { type: string; id: string }) => c.type === "tag" && c.id === tag.id);
    expect(tagChange, "the tag never reached /sync — the rail would render nothing").toBeTruthy();
    expect(tagChange.entity.name).toBe("Invoices");
    expect(tagChange.op).not.toBe("delete");   // the RC4 tombstone trap: a type with no materialize case

    const msgChange = all.filter((c: { type: string; id: string }) => c.type === "message" && c.id === msg.id).pop();
    expect(msgChange, "the message never re-drained after being tagged").toBeTruthy();
    expect(msgChange.entity.labels, "labels did not survive the round trip").toEqual([tag.id]);
  });

  it("unassigning removes it from the message on the next drain", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const msg = await seedMessage(db, { accountId: s.accountId });
    const tag = await (await H(req("POST", "/tags", {
      bearer: s.token, body: JSON.stringify({ name: "temp" }),
    }), deps)).json();

    await H(req("POST", `/messages/${msg.id}/tags`, {
      bearer: s.token, body: JSON.stringify({ tagId: tag.id, assigned: true }),
    }), deps);
    const off = await H(req("POST", `/messages/${msg.id}/tags`, {
      bearer: s.token, body: JSON.stringify({ tagId: tag.id, assigned: false }),
    }), deps);
    expect((await off.json()).labels).toEqual([]);
  });

  it("tag-or-create mints the tag under the CLIENT's id and assigns it in one request", async () => {
    // The only way the shared shell can create a tag — it may not import `app/api-client`.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const msg = await seedMessage(db, { accountId: s.accountId });
    const minted = "11111111-2222-4333-8444-555555555555";

    const res = await H(req("POST", `/messages/${msg.id}/tags`, {
      bearer: s.token, body: JSON.stringify({ tagId: minted, name: "Quarterly", assigned: true }),
    }), deps);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tagId).toBe(minted);
    expect(json.labels).toEqual([minted]);

    const listed = await (await H(req("GET", "/tags", { bearer: s.token }), deps)).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].name).toBe("Quarterly");
  });

  it("a duplicate name is 409, case-insensitively — not a silent second tag", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await H(req("POST", "/tags", { bearer: s.token, body: JSON.stringify({ name: "invoices" }) }), deps);
    const dup = await H(req("POST", "/tags", {
      bearer: s.token, body: JSON.stringify({ name: "Invoices" }),
    }), deps);
    expect(dup.status).toBe(409);
  });

  it("deleting a tag clears it from its messages, not just from the tag list", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const msg = await seedMessage(db, { accountId: s.accountId });
    const tag = await (await H(req("POST", "/tags", {
      bearer: s.token, body: JSON.stringify({ name: "doomed" }),
    }), deps)).json();
    await H(req("POST", `/messages/${msg.id}/tags`, {
      bearer: s.token, body: JSON.stringify({ tagId: tag.id, assigned: true }),
    }), deps);

    const del = await H(req("DELETE", `/tags/${tag.id}`, { bearer: s.token }), deps);
    expect(del.status).toBe(204);

    // A client that heard only the tag's delete would keep painting the chip on the row.
    const sync = await H(req("GET", "/sync?since=0&limit=200", { bearer: s.token }), deps);
    const body = await sync.json();
    const all = [
      ...body.changes.creates, ...body.changes.updates,
      ...body.changes.moves, ...body.changes.deletes,
    ];
    const msgChange = all.filter((c: { type: string; id: string }) => c.type === "message" && c.id === msg.id).pop();
    expect(msgChange.entity.labels).toEqual([]);
  });

  it("another account's tag is a 404, and its message cannot be tagged", async () => {
    const { db, deps } = await makeDeps();
    const mine = await seedSession(db, { now: FIXED_NOW });
    const theirs = await seedSession(db, { now: FIXED_NOW });
    const theirMsg = await seedMessage(db, { accountId: theirs.accountId });
    const tag = await (await H(req("POST", "/tags", {
      bearer: mine.token, body: JSON.stringify({ name: "mine" }),
    }), deps)).json();

    // My tag, their message.
    const cross = await H(req("POST", `/messages/${theirMsg.id}/tags`, {
      bearer: mine.token, body: JSON.stringify({ tagId: tag.id, assigned: true }),
    }), deps);
    expect(cross.status).toBe(404);

    // Their session may not see my tag at all.
    const theirList = await (await H(req("GET", "/tags", { bearer: theirs.token }), deps)).json();
    expect(theirList.items).toEqual([]);
  });

  it("every write route refuses an unauthenticated caller", async () => {
    const { deps } = await makeDeps();
    expect((await H(req("GET", "/tags"), deps)).status).toBe(401);
    expect((await H(req("POST", "/tags", { body: JSON.stringify({ name: "x" }) }), deps)).status).toBe(401);
  });

  /**
   * THE HUE SET IS PINNED TO WHAT THE CLIENT CAN PAINT.
   *
   * `TagsService.RENDERABLE_HUES` and `packages/ui`'s `TagHueName` must be one set: a hue the
   * server accepts but `chip.css` has no rule for is an invisible dot, which is why the recolour
   * verb waited on the reconciliation. `test/tag-hues.test.ts` asserts the two lists are equal
   * across all six files that have to agree; what only THIS layer can show is that each member
   * survives the HTTP round trip — validation, storage and the echoed DTO.
   *
   * Driven off `RENDERABLE_HUES` rather than a copy of it, so a hue added to the palette gets
   * this coverage without anyone remembering to widen a literal — which is exactly the kind of
   * forgetting that left the two lists six-against-three. The negative case stays a literal, and
   * `amber` is a deliberate choice: it is one of the names this service accepted BEFORE the
   * reconciliation, so it proves the retired set is still refused rather than merely that some
   * nonsense string is.
   */
  it("accepts exactly the renderable hues and recolours through PATCH", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    expect(RENDERABLE_HUES.length, "the palette is meant to carry a heavy tagger")
      .toBeGreaterThanOrEqual(10);
    for (const hue of RENDERABLE_HUES) {
      const ok = await H(req("POST", "/tags", {
        bearer: s.token, body: JSON.stringify({ name: `t-${hue}`, hue }),
      }), deps);
      expect(ok.status, `${hue} must be accepted`).toBe(201);
      expect((await ok.json()).hue, `${hue} must round-trip byte-identically`).toBe(hue);
    }

    // Every one of them comes back out of the list route wearing the colour it went in with —
    // the read half, which is what the rail and the chips actually consume.
    const listed = await (await H(req("GET", "/tags", { bearer: s.token }), deps)).json();
    expect(
      listed.items.map((t: { name: string; hue: string }) => t.hue).sort(),
      "a hue changed between the write and the read",
    ).toEqual([...RENDERABLE_HUES].sort());

    // A hue with no `chip.css` rule is refused — the invisible-dot case the reconciliation closed.
    const bad = await H(req("POST", "/tags", {
      bearer: s.token, body: JSON.stringify({ name: "invisible", hue: "amber" }),
    }), deps);
    expect(bad.status, "a non-renderable hue must be a 400, not a stored invisible dot").toBe(400);

    // Recolour: PATCH with the hue alone flips it and echoes the new value. Onto one of the hues
    // the palette gained, so the widening is proven on the write path too and not just on create.
    const made = await (await H(req("POST", "/tags", {
      bearer: s.token, body: JSON.stringify({ name: "recolour-me", hue: "moss" }),
    }), deps)).json();
    const patched = await H(req("PATCH", `/tags/${made.id}`, {
      bearer: s.token, body: JSON.stringify({ hue: "iris" }),
    }), deps);
    expect(patched.status).toBe(200);
    const after = await patched.json();
    expect(after.hue).toBe("iris");
    expect(after.name).toBe("recolour-me");   // hue-only PATCH leaves the name alone
  });
});
