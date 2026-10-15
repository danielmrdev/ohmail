import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedContact, seedThread, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

describe("contacts & notes", () => {
  it("list + get + PATCH name", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedContact(db, { accountId: s.accountId, address: "ada@example.com" });

    const listed = await H(req("GET", "/contacts", { bearer: s.token }), deps);
    expect(listed.status).toBe(200);
    const { items } = await listed.json();
    expect(items.map((c: { id: string }) => c.id)).toContain(id);
    expect(items[0].addresses).toEqual(["ada@example.com"]);

    const got = await H(req("GET", `/contacts/${id}`, { bearer: s.token }), deps);
    expect(got.status).toBe(200);
    expect((await got.json()).name).toBeNull();

    const patched = await H(req("PATCH", `/contacts/${id}`, {
      bearer: s.token, body: JSON.stringify({ name: "Ada Lovelace" }),
    }), deps);
    expect(patched.status).toBe(200);
    expect((await patched.json()).name).toBe("Ada Lovelace");

    // persisted
    expect((await (await H(req("GET", `/contacts/${id}`, { bearer: s.token }), deps)).json()).name).toBe("Ada Lovelace");
  });

  it("add a contact note + list it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const contactId = await seedContact(db, { accountId: s.accountId });

    const created = await H(req("POST", `/contacts/${contactId}/notes`, {
      bearer: s.token, body: JSON.stringify({ body: "Met at a conference" }),
    }), deps);
    expect(created.status).toBe(201);
    const note = await created.json();
    expect(note.body).toBe("Met at a conference");
    expect(note.target).toEqual({ kind: "contact", contactId });

    const listed = await H(req("GET", `/contacts/${contactId}/notes`, { bearer: s.token }), deps);
    const { items } = await listed.json();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(note.id);
  });

  it("add a thread note + list it (coexists with /threads/:id and /threads/merge)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const threadId = await seedThread(db, { accountId: s.accountId });

    const created = await H(req("POST", `/threads/${threadId}/notes`, {
      bearer: s.token, body: JSON.stringify({ body: "Waiting on a reply" }),
    }), deps);
    expect(created.status).toBe(201);
    const note = await created.json();
    expect(note.target).toEqual({ kind: "thread", threadId });

    const listed = await H(req("GET", `/threads/${threadId}/notes`, { bearer: s.token }), deps);
    expect((await listed.json()).items).toHaveLength(1);
  });

  it("PATCH /notes/:id edits BOTH note kinds (dual-table lookup)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const contactId = await seedContact(db, { accountId: s.accountId });
    const threadId = await seedThread(db, { accountId: s.accountId });

    const cNote = await (await H(req("POST", `/contacts/${contactId}/notes`, { bearer: s.token, body: JSON.stringify({ body: "a" }) }), deps)).json();
    const tNote = await (await H(req("POST", `/threads/${threadId}/notes`, { bearer: s.token, body: JSON.stringify({ body: "b" }) }), deps)).json();

    const editC = await H(req("PATCH", `/notes/${cNote.id}`, { bearer: s.token, body: JSON.stringify({ body: "a-edited" }) }), deps);
    expect(editC.status).toBe(200);
    const ec = await editC.json();
    expect(ec.body).toBe("a-edited");
    expect(ec.target).toEqual({ kind: "contact", contactId });

    const editT = await H(req("PATCH", `/notes/${tNote.id}`, { bearer: s.token, body: JSON.stringify({ body: "b-edited" }) }), deps);
    expect(editT.status).toBe(200);
    const et = await editT.json();
    expect(et.body).toBe("b-edited");
    expect(et.target).toEqual({ kind: "thread", threadId });
  });

  it("DELETE /notes/:id removes the note (both kinds), then 404", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const contactId = await seedContact(db, { accountId: s.accountId });
    const threadId = await seedThread(db, { accountId: s.accountId });
    const cNote = await (await H(req("POST", `/contacts/${contactId}/notes`, { bearer: s.token, body: JSON.stringify({ body: "a" }) }), deps)).json();
    const tNote = await (await H(req("POST", `/threads/${threadId}/notes`, { bearer: s.token, body: JSON.stringify({ body: "b" }) }), deps)).json();

    expect((await H(req("DELETE", `/notes/${cNote.id}`, { bearer: s.token }), deps)).status).toBe(204);
    expect((await H(req("DELETE", `/notes/${tNote.id}`, { bearer: s.token }), deps)).status).toBe(204);
    // gone in both tables
    expect((await H(req("PATCH", `/notes/${cNote.id}`, { bearer: s.token, body: JSON.stringify({ body: "x" }) }), deps)).status).toBe(404);
    expect((await H(req("DELETE", `/notes/${tNote.id}`, { bearer: s.token }), deps)).status).toBe(404);
  });

  it("empty note body → 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const contactId = await seedContact(db, { accountId: s.accountId });
    const bad = await H(req("POST", `/contacts/${contactId}/notes`, { bearer: s.token, body: JSON.stringify({ body: "   " }) }), deps);
    expect(bad.status).toBe(400);
  });

  it("cross-account contact / thread / note → 404 (IDOR)", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const contactId = await seedContact(db, { accountId: owner.accountId });
    const threadId = await seedThread(db, { accountId: owner.accountId });
    const note = await (await H(req("POST", `/contacts/${contactId}/notes`, { bearer: owner.token, body: JSON.stringify({ body: "secret" }) }), deps)).json();

    // read/patch the contact
    expect((await H(req("GET", `/contacts/${contactId}`, { bearer: other.token }), deps)).status).toBe(404);
    expect((await H(req("PATCH", `/contacts/${contactId}`, { bearer: other.token, body: JSON.stringify({ name: "X" }) }), deps)).status).toBe(404);
    // add a note under someone else's contact/thread (IDOR)
    expect((await H(req("POST", `/contacts/${contactId}/notes`, { bearer: other.token, body: JSON.stringify({ body: "x" }) }), deps)).status).toBe(404);
    expect((await H(req("POST", `/threads/${threadId}/notes`, { bearer: other.token, body: JSON.stringify({ body: "x" }) }), deps)).status).toBe(404);
    // edit/delete a note across accounts
    expect((await H(req("PATCH", `/notes/${note.id}`, { bearer: other.token, body: JSON.stringify({ body: "x" }) }), deps)).status).toBe(404);
    expect((await H(req("DELETE", `/notes/${note.id}`, { bearer: other.token }), deps)).status).toBe(404);

    // owner still intact
    expect((await H(req("GET", `/contacts/${contactId}`, { bearer: owner.token }), deps)).status).toBe(200);
    expect((await (await H(req("GET", `/contacts/${contactId}/notes`, { bearer: owner.token }), deps)).json()).items).toHaveLength(1);
  });
});
