import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

describe("away-responder", () => {
  it("default GET is the disabled shape (never configured)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/away-responder", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const dto = await res.json();
    // WHOLE-OBJECT, not field-by-field: the default shape is what a client that has never
    // configured a responder is told about itself, so a field appearing in it silently is a claim
    // nobody reviewed. `audience` had to be added here deliberately, which is the point.
    expect(dto).toEqual({
      enabled: false, body: null, startsAt: null, endsAt: null,
      audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: null,
    });
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     THE PILE SCOPE OVER THE WIRE (mail 0096)
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("PUT stores the piles it is given, and GET reads them back", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const put = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, body: "Back Monday.", piles: ["INBOX", "ohmail/News"] }),
    }), deps);
    expect(put.status).toBe(200);
    expect((await put.json()).piles).toEqual(["INBOX", "ohmail/News"]);
    const got = await H(req("GET", "/away-responder", { bearer: s.token }), deps);
    expect((await got.json()).piles).toEqual(["INBOX", "ohmail/News"]);
  });

  /**
   * A PILE THE ENGINE REFUSES IS A 400 NAMING THE FIELD, never a stored row.
   *
   * Two guards, deliberately: this one turns a bad request into an answer somebody can act on,
   * and the column's CHECK makes the member unrepresentable whichever writer produced it. Both
   * are worth having — the offered set is the engine's own constant, so a control cannot offer a
   * pile the rule will not act on, but a hand-written request is not a control.
   */
  it("PUT with a pile outside the closed set → 400, and nothing is stored", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    for (const bad of [["ohmail/Screened"], ["INBOX", "ohmail/Quarantine"],
      ["inbox"], [""], [null], "INBOX"]) {
      const res = await H(req("PUT", "/away-responder", {
        bearer: s.token, body: JSON.stringify({ enabled: true, body: "Back Monday.", piles: bad }),
      }), deps);
      expect(res.status, `piles=${JSON.stringify(bad)} was accepted`).toBe(400);
    }
    // …and the account still has no responder row at all.
    const got = await H(req("GET", "/away-responder", { bearer: s.token }), deps);
    expect((await got.json()).enabled).toBe(false);
  });

  /**
   * RECEIPTS AND THE SCREENER ARE STORABLE PILES (mail 0101) — the positive control for the
   * refusal above, because a list of refusals says nothing about what the door admits.
   */
  it("PUT stores the two piles added in 0.16.1, and GET reads them back", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const put = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({
        enabled: true, body: "Back Monday.", audience: "everyone",
        piles: ["INBOX", "ohmail/Receipts", "ohmail/Screener"],
      }),
    }), deps);
    expect(put.status).toBe(200);
    expect((await put.json()).piles)
      .toEqual(["INBOX", "ohmail/Receipts", "ohmail/Screener"]);
    const got = await H(req("GET", "/away-responder", { bearer: s.token }), deps);
    expect((await got.json()).piles)
      .toEqual(["INBOX", "ohmail/Receipts", "ohmail/Screener"]);
  });

  /**
   * THE SCREENER PILE NEEDS `everyone`, and the 400 names the rule rather than the field alone.
   *
   * A `screened_in` responder never answers a waiting stranger, so the pair states a scope no
   * pass can act on. Receipts beside the same narrow audience is the discriminator: the refusal is
   * about one member, not about the audience.
   */
  it("PUT with the Screener pile and the narrow audience → 400 naming the rule", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    for (const audience of [undefined, "screened_in"]) {
      const res = await H(req("PUT", "/away-responder", {
        bearer: s.token,
        body: JSON.stringify({
          enabled: true, body: "Back Monday.", piles: ["INBOX", "ohmail/Screener"],
          ...(audience === undefined ? {} : { audience }),
        }),
      }), deps);
      expect(res.status, `audience=${String(audience)} accepted the Screener pile`).toBe(400);
      expect((await res.json()).error.message).toContain("everyone");
    }
    // The same narrow audience with Receipts is stored — the rule is one member's, not the pile
    // control's.
    const ok = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({
        enabled: true, body: "Back Monday.", piles: ["INBOX", "ohmail/Receipts"],
      }),
    }), deps);
    expect(ok.status).toBe(200);
    expect((await ok.json()).piles).toEqual(["INBOX", "ohmail/Receipts"]);
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     THE END DATE — `endsAt` is the date the pane offers, and the pass switches the row off on it
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  /**
   * AN END DATE ALREADY PAST, WITH THE RESPONDER ON, is refused: it would store a responder that
   * answers nobody while its switch says On. `enabled: false` with the same date is ADMITTED —
   * that is a responder somebody is turning off, and the save that turns it off is the one save
   * nobody may be prevented from making.
   */
  it("PUT enabled with an `endsAt` in the past → 400; the same date with enabled false is stored", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const past = "2026-07-01T00:00:00.000Z";   // FIXED_NOW is 2026-07-28
    const bad = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, body: "Back Monday.", endsAt: past }),
    }), deps);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain("endsAt");

    const off = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: false, body: "Back Monday.", endsAt: past }),
    }), deps);
    expect(off.status).toBe(200);
    expect((await off.json()).endsAt).toBe(past);

    const future = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, body: "Back Monday.", endsAt: "2026-08-30T21:59:59.000Z" }),
    }), deps);
    expect(future.status).toBe(200);
    expect((await future.json()).endsAt).toBe("2026-08-30T21:59:59.000Z");
  });

  /**
   * AN OMITTED `piles` NARROWS TO THE OHBOX — it does not preserve what was stored.
   *
   * `PUT` is a full replace, so a client one release old (which sends no `piles`) resets the scope
   * on every save, including a save that only changes the message text. That is the acceptable
   * direction and the same one an omitted `audience` takes: mail not sent can be sent later, and a
   * reply that reached somebody its owner did not mean cannot be recalled.
   */
  it("an omitted `piles` resets the scope to the Ohbox rather than preserving a wider one", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, body: "Back Monday.", piles: ["INBOX", "ohmail/News"] }),
    }), deps);
    const again = await H(req("PUT", "/away-responder", {
      bearer: s.token, body: JSON.stringify({ enabled: true, body: "Back Tuesday." }),
    }), deps);
    expect((await again.json()).piles).toEqual(["INBOX"]);
  });

  /** An EXPLICIT empty list is stored as asked: "answer nobody" is a state, not an absence. */
  it("an explicit empty `piles` is stored, not replaced by the default", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("PUT", "/away-responder", {
      bearer: s.token, body: JSON.stringify({ enabled: true, body: "Back Monday.", piles: [] }),
    }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).piles).toEqual([]);
  });

  /** A repeated member is one member: the value is a SET, and two spellings of one scope would
   *  otherwise be two different stored rows with no difference in meaning. */
  it("duplicate piles collapse", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, body: "Back Monday.", piles: ["INBOX", "INBOX", "ohmail/News"] }),
    }), deps);
    expect((await res.json()).piles).toEqual(["INBOX", "ohmail/News"]);
  });

  it("PUT enables + persists; a second PUT replaces (upsert)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const put = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({
        enabled: true, body: "Back Monday",
        startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-05T00:00:00.000Z",
      }),
    }), deps);
    expect(put.status).toBe(200);
    const dto = await put.json();
    expect(dto.enabled).toBe(true);
    expect(dto.throttle).toBe("per_day");   // omitted ⇒ the column's own default, not the loosest
    expect(dto.startsAt).toBe("2026-08-01T00:00:00.000Z");
    expect(dto.updatedAt).not.toBeNull();

    // persisted on GET
    const got = await (await H(req("GET", "/away-responder", { bearer: s.token }), deps)).json();
    expect(got.enabled).toBe(true);
    expect(got.body).toBe("Back Monday");

    // second PUT replaces (still one row underneath)
    const put2 = await H(req("PUT", "/away-responder", { bearer: s.token, body: JSON.stringify({ enabled: false }) }), deps);
    const dto2 = await put2.json();
    expect(dto2.enabled).toBe(false);
    // FULL REPLACE, shown on the field that still exists: the second PUT named no dates, so the
    // stored ones are cleared rather than merged. `subject` used to carry this assertion; the
    // responder is reply-only now and has none.
    expect(dto2.startsAt).toBeNull();
    expect(dto2.endsAt).toBeNull();
  });

  /**
   * THE LEGACY CLIENT, and it is a CONTRACT rather than leniency.
   *
   * The responder is reply-only, so `subject` is gone from the DTO. A 0.13 client — a browser tab
   * that has not reloaded, a desktop on the hosted door that has not updated — still PUTs one, and
   * this endpoint is a FULL REPLACE. Refusing the field would 400 that client's every save,
   * INCLUDING the save that turns the responder OFF, which is the one save nobody may be prevented
   * from making. So it is accepted, ignored, and counted in the log.
   *
   * The other PUTs in this file deliberately keep sending `subject` for the same reason: they are
   * free coverage of the path an older client actually takes.
   */
  it("a client that still sends `subject` is not refused — the field is ignored, not rejected", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const put = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, subject: "Out of office", body: "Back Monday" }),
    }), deps);

    expect(put.status).toBe(200);
    const dto = await put.json();
    expect(dto.enabled).toBe(true);
    expect(dto.body).toBe("Back Monday");
    // Not stored, and not echoed back — the DTO has no such field at all.
    expect("subject" in dto).toBe(false);
  });

  it("throttle: stored when named, and an OMITTED one is the column's DEFAULT", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    for (const throttle of ["always", "per_message", "per_day", "per_week"]) {
      const put = await H(req("PUT", "/away-responder", {
        bearer: s.token,
        body: JSON.stringify({ enabled: true, body: "Back Monday", throttle }),
      }), deps);
      expect(put.status, `throttle=${throttle}`).toBe(200);
      expect((await put.json()).throttle, `throttle=${throttle}`).toBe(throttle);
    }

    /* OMITTED means `per_day`, and unlike `audience` that is deliberately NOT the narrowest member.
       A full replace that does not mention the rate cannot surprise: `per_day` is the column's own
       DEFAULT and what every row migrated by 0087 carries. Inferring `always` from silence would
       multiply how often a stranger hears from this address; inferring `per_week` would throttle
       somebody who never asked for it. */
    const omitted = await H(req("PUT", "/away-responder", {
      bearer: s.token, body: JSON.stringify({ enabled: true, body: "Back Monday" }),
    }), deps);
    expect((await omitted.json()).throttle).toBe("per_day");
  });

  it("throttle: a member nobody enumerated is a 400 naming the field", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, body: "Back", throttle: "hourly" }),
    }), deps);
    expect(res.status).toBe(400);
  });

  it("audience: stored when named, and an OMITTED one resets to the NARROW member", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const wide = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, subject: "Out", body: "Back Monday", audience: "everyone" }),
    }), deps);
    expect((await wide.json()).audience).toBe("everyone");

    // A FULL REPLACE that does not name the audience is not a merge: it stores `screened_in`. This
    // is the direction that must never go the other way — a client that predates the field must not
    // silently preserve `everyone`, and an omission must never WIDEN. Watched red by defaulting
    // `validAudience` to the stored value.
    const narrow = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, subject: "Out", body: "Back Monday" }),
    }), deps);
    expect((await narrow.json()).audience).toBe("screened_in");
  });

  it("PUT with an unknown audience → 400, and the stored row is untouched", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, subject: "Out", body: "Back", audience: "everyone" }),
    }), deps);

    for (const audience of ["all", "EVERYONE", "", 1, true]) {
      const bad = await H(req("PUT", "/away-responder", {
        bearer: s.token,
        body: JSON.stringify({ enabled: true, subject: "Out", body: "Back", audience }),
      }), deps);
      expect(bad.status, `audience ${JSON.stringify(audience)}`).toBe(400);
    }

    // A refused write changed nothing — the validator throws before the upsert, so `updatedAt` did
    // not move either. That matters more here than for a normal 400: `updatedAt` is the responder's
    // enablement episode, so a refused request that bumped it would re-arm a reply to everybody.
    const still = await (await H(req("GET", "/away-responder", { bearer: s.token }), deps)).json();
    expect(still.audience).toBe("everyone");
  });

  it("PUT with startsAt > endsAt → 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const bad = await H(req("PUT", "/away-responder", {
      bearer: s.token,
      body: JSON.stringify({ enabled: true, startsAt: "2026-08-10T00:00:00.000Z", endsAt: "2026-08-01T00:00:00.000Z" }),
    }), deps);
    expect(bad.status).toBe(400);
  });

  it("each account's away-responder is independent", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW, token: "a-tok" });
    const b = await seedSession(db, { now: FIXED_NOW, token: "b-tok" });

    await H(req("PUT", "/away-responder", { bearer: a.token, body: JSON.stringify({ enabled: true, body: "A away" }) }), deps);
    // b is untouched
    const bDto = await (await H(req("GET", "/away-responder", { bearer: b.token }), deps)).json();
    expect(bDto.enabled).toBe(false);
    expect(bDto.body).toBeNull();
    // a is set
    const aDto = await (await H(req("GET", "/away-responder", { bearer: a.token }), deps)).json();
    expect(aDto.body).toBe("A away");
  });
});
