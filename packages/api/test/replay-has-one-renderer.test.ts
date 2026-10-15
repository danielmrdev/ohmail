import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// ONE scanner, left to right over strings, templates and both comment forms — a `//` inside a
// string is never read as a comment, and blanking rather than deleting keeps `file:line` true.
import * as scan from "../../../scripts/lib/source-scan.mjs";
import { storedResponse, type StoredIdempotent } from "@trafficflow/api";

/**
 * ═══ A REPLAY IS RENDERED IN ONE PLACE, SO IT CANNOT LOSE WHAT IT STORED ════════════════════
 *
 * Idempotency has three owners — the policy that decides a request is a retry, the transactional
 * write that stores the answer, and the shaping that turns that answer back into a response — and
 * for one route they disagreed. `DELETE /rules/:id` read the stored row and then built its own
 * 204, because the shared path could not make a bodiless response. Since mail 0094 that route has
 * TWO statuses: on an account whose every live mailbox another install organizes, a delete is
 * a QUEUED answer and the rule stays live on the machine that runs it. So the retry of a queued delete
 * answered "the rule is gone" about a rule that was still filing mail, and nothing on the surface
 * disagreed.
 *
 * The fix is not a rule about what routes should do. It is that {@link storedResponse} is the
 * only function that turns a stored row into a response, and it takes the WHOLE row — so there is
 * no field for a caller to shape with. This file is what keeps that true: a route that starts
 * reading `responseStatus` or `responseJson` to build an answer is named here by file and line.
 */

const SRC = join(import.meta.dirname, "..", "src");

/** Every `.ts` under `packages/api/src`, recursively, with its text comment-blanked. */
function sources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(join(dir, e.name), `${rel}${e.name}/`); continue; }
      if (!e.name.endsWith(".ts")) continue;
      out.push({ path: `${rel}${e.name}`, text: scan.withoutComments(readFileSync(join(dir, e.name), "utf8")) });
    }
  };
  walk(SRC, "");
  return out;
}

/**
 * The renderer's own home. Named rather than derived, because the point of the census is that
 * there is exactly ONE, and a derived list of "files allowed to do this" would grow silently.
 */
const THE_RENDERER = "idempotency.ts";

/** The stored row's fields. Reading one of these is shaping a response the layer owns. */
const STORED_FIELDS = ["responseStatus", "responseJson"] as const;

describe("a replay is rendered in one place", () => {
  it("no module outside the renderer reads a stored response's status or body", () => {
    const offenders: string[] = [];
    for (const { path, text } of sources()) {
      if (path === THE_RENDERER) continue;
      for (const field of STORED_FIELDS) {
        // `.responseStatus` — a READ off a value. The claim sites pass these as OBJECT KEYS
        // (`responseStatus: 202`), which is the storage owner doing its job and is not a hit.
        const re = new RegExp(`\\.\\s*${field}\\b`, "g");
        for (const m of text.matchAll(re)) {
          offenders.push(`${path}:${scan.lineOf(text, m.index)} reads .${field}`);
        }
      }
    }
    expect(
      offenders,
      "a module outside the idempotency layer is building a replay from a stored row's fields — "
      + "the class it drops is a person being told a queued change is done; call storedResponse()",
    ).toEqual([]);
  });

  it("the renderer answers with the STORED class, not a status of its own", () => {
    // The positive control for the census above: the mechanism it protects, driven directly.
    // A queued mutation and a completed one, through the one function, with nothing routing.
    const queued: StoredIdempotent = {
      requestHash: "h", responseStatus: 202, responseJson: { pending: true, travel: { pending: [] } }, seq: null,
    } as StoredIdempotent;
    const done: StoredIdempotent = {
      requestHash: "h", responseStatus: 204, responseJson: {}, seq: 41,
    } as StoredIdempotent;

    const q = storedResponse(queued);
    expect(q.status).toBe(202);
    expect(q.headers.get("x-sync-seq")).toBeNull();

    const d = storedResponse(done);
    expect(d.status).toBe(204);
    expect(d.body).toBeNull();               // a 204 carrying a body is unsendable, not merely odd
    expect(d.headers.get("x-sync-seq")).toBe("41");
  });
});
