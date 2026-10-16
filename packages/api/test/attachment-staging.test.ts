import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createApp, apiRoutes, type ApiDeps, type AttachmentStagingPort } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import { ServiceError, SEND_UNMEASURED_MESSAGE_BYTES, attachmentBudgetFor } from "@trafficflow/services/mail";
import { mailboxes } from "@trafficflow/db";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * ═══ `POST /attachments/staging` — THE MINT, AND THE THREE THINGS IT MUST REFUSE ═══════════
 *
 * The route exists so hosted attachment bytes stop riding the send request body. It writes a row
 * and creates storage cost, which puts it squarely inside the "An unverified account must not be able to generate meaningful cost" invariant — *an unverified account
 * must not be able to generate meaningful cost* — and its ceiling has to be the same number the
 * compose form promises and the send enforces, or the product states something it will refuse.
 *
 * ## The guards, and the mutation each was watched against
 *
 *  · **HOSTED ONLY, from the route table.** Mutation: add the module to `routes/local.ts` → the
 *    membership test goes red. This is the strongest form of "the standalone door never stages":
 *    the local engine has no such route to reach, so the refusal is not a check that could be
 *    forgotten.
 *  · **An unverified account is refused.** Mutation: change `cost` to `"read"` → the gate test
 *    goes red (and the frozen census in `spend-gate.test.ts` goes red twice over).
 *  · **The ceiling is the MAILBOX's announced SIZE.** Mutation: pass the constant instead of
 *    `null` as the surface → the 6 MB-against-a-25 MB-mailbox case is refused and goes red.
 *  · **An unconfigured deployment answers 503, not 404.** Mutation: drop the guard → the mint
 *    throws an unrelated 500 on a host with no port.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

const MIB = 1024 * 1024;

/** A staging port over an in-memory bucket — no storage, no network, real shape. */
function fakePort() {
  const minted: Array<{
    accountId: string; filename: string; sizeBytes: number; idempotencyKey: string;
    contentSha256: string | null;
  }> = [];
  /** The real port's replay, modelled: one id per (account, key). */
  const idFor = new Map<string, string>();
  const port: AttachmentStagingPort = {
    async mint(input) {
      minted.push({
        accountId: input.accountId, filename: input.filename, sizeBytes: input.sizeBytes,
        idempotencyKey: input.idempotencyKey, contentSha256: input.contentSha256 ?? null,
      });
      const seen = `${input.accountId}\n${input.idempotencyKey}`;
      const id = idFor.get(seen) ?? randomUUID();
      idFor.set(seen, id);
      return {
        id,
        uploadUrl: `https://storage.example/staging/${input.accountId}/${id}?token=t`,
        uploadMethod: "PUT",
        uploadHeaders: { "content-type": input.contentType, "x-upsert": "false" },
        expiresAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
    },
    source: {
      async declare() { return []; },
      async fetch() { return []; },
    },
  };
  return { port, minted };
}

async function armed(smtpMaxSizeBytes: number | null, opts: { withPort?: boolean } = {}) {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: "mila@lichtgrat.example", smtpMaxSizeBytes,
  }).returning();
  const { port, minted } = fakePort();
  const withPort = opts.withPort !== false;
  return {
    db, s, mailboxId: mb!.id, minted,
    deps: {
      ...deps,
      services: { ...deps.services!, ...(withPort ? { attachmentStaging: () => port } : {}) },
    } as ApiDeps,
  };
}

/** A mint request. `key` defaults to a fresh one — a caller testing something else wants that. */
const mint = (
  d: ApiDeps, token: string, body: Record<string, unknown>, key = randomUUID(),
): Promise<Response> =>
  H(req("POST", "/attachments/staging", {
    bearer: token, body: JSON.stringify(body), headers: { "idempotency-key": key },
  }), d);

/** The same request WITHOUT the header — what a client that has not reloaded sends. */
const mintUnkeyed = (
  d: ApiDeps, token: string, body: Record<string, unknown>,
): Promise<Response> =>
  H(req("POST", "/attachments/staging", { bearer: token, body: JSON.stringify(body) }), d);

describe("the mint route is HOSTED ONLY, and that is a property of the tables", () => {
  it("is on `apiRoutes` and NOT on `localRoutes`", () => {
    const key = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;
    expect(apiRoutes.map(key)).toContain("POST /attachments/staging");
    // THE LOAD-BEARING HALF. A standalone install has no request body between its compose form
    // and its own SMTP dial, so it has nothing to stage around — and a desktop that could reach
    // this route would be putting somebody's attachment bytes into hosted storage.
    expect(localRoutes.map(key)).not.toContain("POST /attachments/staging");
  });

  it("`routes/local.ts` does not even IMPORT the module — the routes are never built", () => {
    // The same reason the file itself gives for being a distinct import list rather than a filter:
    // a filter would still load every module to build the list it discards.
    const src = readFileSync(new URL("../src/routes/local.ts", import.meta.url), "utf8");
    expect(src).not.toContain("attachment-staging");
  });

  it("declares `cost: \"work\"` — a spender, in the gated remainder", () => {
    const route = apiRoutes.find((r) => r.pattern === "/attachments/staging");
    expect(route?.cost).toBe("work");
  });
});

describe("an unverified account may not mint an upload grant", () => {
  it("403 email_unverified, and nothing is minted", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, {
      now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false,
    });
    const { port, minted } = fakePort();
    const withPort = { ...deps, services: { ...deps.services!, attachmentStaging: () => port } } as ApiDeps;
    const res = await mint(withPort, s.token, {
      mailboxId: randomUUID(), filename: "a.bin", contentType: "text/plain", sizeBytes: 10,
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("email_unverified");
    expect(minted).toEqual([]);
  });
});

describe("the ceiling is the SENDING MAILBOX's announced SIZE", () => {
  it("6 MB against a mailbox that announced 25 MB is MINTED — the whole point of the slice", async () => {
    const { deps, s, mailboxId, minted } = await armed(25 * MIB);
    const res = await mint(deps, s.token, {
      mailboxId, filename: "holiday.mov", contentType: "video/quicktime", sizeBytes: 6 * MIB,
    });
    expect(res.status).toBe(201);
    const grant = await res.json() as { id: string; uploadUrl: string; expiresAt: string };
    expect(grant.id).toBeTruthy();
    expect(grant.uploadUrl).toContain("token=");
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(FIXED_NOW.getTime());
    expect(minted).toHaveLength(1);
    expect(minted[0]!.sizeBytes).toBe(6 * MIB);
  });

  it("REFUSES above that number, and the message names it", async () => {
    const { deps, s, mailboxId, minted } = await armed(4 * MIB);
    const res = await mint(deps, s.token, {
      mailboxId, filename: "big.bin", contentType: "application/octet-stream", sizeBytes: 9 * MIB,
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("payload_too_large");
    // The EFFECTIVE number, which is the announcement's budget for raw bytes — `SIZE` bounds the
    // encoded message, and a refusal naming the face value would name a limit nothing measured
    // this upload against.
    expect(body.error.message).toContain(String(attachmentBudgetFor(4 * MIB)));
    expect(minted).toEqual([]);
  });

  it("a mailbox that announced NOTHING counts as the assumed provider SIZE, never as unbounded", async () => {
    // An unknown limit read as no limit lets somebody upload a file their own mail server will
    // refuse; read as the inline 3 MB it refused a 4 MB video a server takes. It is the budget of
    // a provider-typical announcement.
    const { deps, s, mailboxId } = await armed(null);
    const assumed = attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES);
    const ok = await mint(deps, s.token, {
      mailboxId, filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 5 * MIB,
    });
    expect(ok.status).toBe(201);
    const no = await mint(deps, s.token, {
      mailboxId, filename: "big.bin", contentType: "text/plain", sizeBytes: assumed + 1,
    });
    expect(no.status).toBe(413);
  });

  it("a FOREIGN mailbox id is a 404 — the ceiling cannot be borrowed from another account", async () => {
    const { deps, s, minted } = await armed(25 * MIB);
    const res = await mint(deps, s.token, {
      mailboxId: randomUUID(), filename: "a.bin", contentType: "text/plain", sizeBytes: 10,
    });
    expect(res.status).toBe(404);
    expect(minted).toEqual([]);
  });
});

describe("the request shape", () => {
  it("a missing or non-positive size is 400", async () => {
    const { deps, s, mailboxId } = await armed(25 * MIB);
    for (const sizeBytes of [undefined, 0, -1, 1.5, "10"]) {
      const res = await mint(deps, s.token, {
        mailboxId, filename: "a.bin", contentType: "text/plain", ...(sizeBytes === undefined ? {} : { sizeBytes }),
      });
      expect(res.status, `sizeBytes=${String(sizeBytes)}`).toBe(400);
    }
  });

  it("a missing mailboxId is 400 — the ceiling has no source without it", async () => {
    const { deps, s } = await armed(25 * MIB);
    const res = await mint(deps, s.token, { filename: "a.bin", contentType: "text/plain", sizeBytes: 10 });
    expect(res.status).toBe(400);
  });
});

/**
 * ═══ THE PER-ACCOUNT QUOTA REACHES THE WIRE INTACT (SEC3-MONEY-2) ══════════════════════════
 *
 * The quota, its lock and its numbers are decided in `@trafficflow/db/cloud` and guarded on real
 * Postgres in two files. What this route owes the client is that the refusal survives the error
 * envelope with the field the client's default would get wrong — see the reasoning on
 * `errorResponse` in `packages/api/src/responses.ts`, which exists for exactly this case.
 *
 * Mutation: drop `retryable` from `errorResponse`'s output (or from the `ServiceError` the port
 * throws) → the field is absent, the engine falls back to `status === 429 ⇒ retry`, and a
 * mutation queue spins against a refusal only time can lift.
 */
describe("an account at its staging quota", () => {
  it("answers 429 and marks the refusal NON-RETRYABLE on the wire", async () => {
    const { deps, s, mailboxId } = await armed(25 * MIB);
    const atQuota = {
      ...deps,
      services: {
        ...deps.services!,
        attachmentStaging: () => ({
          async mint(): Promise<never> {
            throw new ServiceError(
              "staging_quota_exceeded", 429,
              "This account already has 500 attachments uploaded and waiting, which is the limit " +
                "of 500. Uploads are released 24 hours after they are made, oldest first.",
              { limit: "tickets", cap: 500, outstanding: 500 },
              false,
            );
          },
          source: { async declare() { return []; }, async fetch() { return []; } },
        } as unknown as AttachmentStagingPort),
      },
    } as ApiDeps;

    const res = await mint(atQuota, s.token, {
      mailboxId, filename: "holiday.mov", contentType: "video/quicktime", sizeBytes: 6 * MIB,
    });
    expect(res.status).toBe(429);
    const body = await res.json() as {
      error: { code: string; message: string; retryable?: boolean; details?: unknown };
    };
    expect(body.error.code).toBe("staging_quota_exceeded");
    // THE FIELD. Without it `retryable` is absent and the client's own heuristic
    // (`status >= 500 || status === 429`) turns this into a retry loop.
    expect(body.error.retryable).toBe(false);
    expect(body.error.message).toContain("24 hours");
    expect(body.error.details).toMatchObject({ limit: "tickets", cap: 500 });
  });
});

describe("a deployment with no object storage", () => {
  it("answers 503 and not 404 — the route exists, the deployment is incomplete", async () => {
    // 404 would send the client down the inline fallback while reporting nothing an operator
    // could act on. 503 says which of the two it is.
    const { deps, s, mailboxId } = await armed(25 * MIB, { withPort: false });
    const res = await mint(deps, s.token, {
      mailboxId, filename: "a.bin", contentType: "text/plain", sizeBytes: 10,
    });
    expect(res.status).toBe(503);
  });
});

/**
 * ═══ THE DURABLE TICKET NEEDS A STABLE KEY, OR A RETRY BUYS A SECOND ONE ═══════════════════
 *
 * A mint writes a DURABLE ROW and hands back a grant to put bytes in a bucket somebody pays for.
 * Under a random id, a retry after a lost response mints a second row, uploads a second copy and
 * takes a second helping of the per-account quota — and the client cannot tell the two apart,
 * because the only thing that ever named the first ticket was the response it did not receive.
 * That is a durable record whose KEY is not durable, which is the same defect as a send lock that
 * lives in the component that issued it.
 *
 * The key is required here rather than through `withIdempotency`, and the route's own header says
 * why: that middleware replays a STORED RESPONSE, and this response contains a signed URL with a
 * lifetime of its own. The key is spent instead on the ticket's PRIMARY KEY — proven against real
 * Postgres in `attachment-staging-idempotency.pg.test.ts`, because the replay is a uniqueness
 * property and PGlite's single connection cannot exercise the concurrent half of it.
 */
describe("the mint takes an Idempotency-Key like every other create", () => {
  /**
   * WATCHED RED by deleting the `if (!idempotencyKey)` refusal: the request is served, a ticket
   * is minted under a key the server invented, and the retry story is back where it started.
   */
  it("400s without one, and mints nothing", async () => {
    const { deps, s, mailboxId, minted } = await armed(null);
    const res = await mintUnkeyed(deps, s.token, {
      mailboxId, filename: "a.bin", contentType: "application/octet-stream", sizeBytes: 10,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    expect(minted, "a ticket was minted for a request with no key").toEqual([]);
  });

  /** A blank header is no header. Trimmed, because `Idempotency-Key: ` is a client bug, not a key. */
  it("400s on a blank or whitespace key", async () => {
    const { deps, s, mailboxId, minted } = await armed(null);
    const res = await mint(deps, s.token, {
      mailboxId, filename: "a.bin", contentType: "application/octet-stream", sizeBytes: 10,
    }, "   ");
    expect(res.status).toBe(400);
    expect(minted).toEqual([]);
  });

  /**
   * The digest input is bounded on a route an authenticated caller can drive.
   *
   * WATCHED RED by removing the length check: a 200 KB header is hashed into a primary key.
   */
  it("400s on an absurd key rather than hashing it", async () => {
    const { deps, s, mailboxId, minted } = await armed(null);
    const res = await mint(deps, s.token, {
      mailboxId, filename: "a.bin", contentType: "application/octet-stream", sizeBytes: 10,
    }, "k".repeat(256));
    expect(res.status).toBe(400);
    expect(minted).toEqual([]);
  });

  /**
   * THE KEY REACHES THE PORT VERBATIM. The route is the only place it can be lost, and losing it
   * would be silent: the port would mint under `undefined` for every request on the deployment,
   * which is worse than no key at all — every caller would collide on one ticket.
   *
   * WATCHED RED by dropping `idempotencyKey` from the `mint(...)` call: the port sees `undefined`.
   */
  it("passes the caller's key through to the port, unchanged", async () => {
    const { deps, s, mailboxId, minted } = await armed(null);
    const res = await mint(deps, s.token, {
      mailboxId, filename: "a.bin", contentType: "application/octet-stream", sizeBytes: 10,
    }, "send-key-1:att:0");
    expect(res.status).toBe(201);
    expect(minted).toHaveLength(1);
    expect(minted[0]!.idempotencyKey).toBe("send-key-1:att:0");
  });

  /**
   * TWO KEYS, TWO TICKETS — the vacuity guard for the case above. An implementation that answered
   * one id for everything would pass "a retry gets the same ticket" and would be catastrophic.
   */
  it("different keys are different tickets", async () => {
    const { deps, s, mailboxId } = await armed(null);
    const body = {
      mailboxId, filename: "a.bin", contentType: "application/octet-stream", sizeBytes: 10,
    };
    const first = await mint(deps, s.token, body, "send-key-1:att:0");
    const second = await mint(deps, s.token, body, "send-key-1:att:1");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await first.json() as { id: string }).id)
      .not.toBe((await second.json() as { id: string }).id);
  });

  /**
   * IT DOES NOT MOUNT `withIdempotency`, and that is a decision rather than an omission — see the
   * route header. Asserted from the route table so a future edit that "tidies it up" by adding the
   * flag has to read the reason first: the middleware replays a stored response, and this response
   * carries a signed URL that expires.
   */
  /**
   * THE DECLARED DIGEST (cloud 0041). The route is the only place it can be lost, and it
   * is OPTIONAL by design: a client that states none is judged at the send on size alone, which
   * is what every shipped client does today.
   */
  it("passes a declared digest through to the port, and none is null", async () => {
    const { deps, s, mailboxId, minted } = await armed(null);
    const digest = "b".repeat(64);
    const body = {
      mailboxId, filename: "a.bin", contentType: "application/octet-stream", sizeBytes: 10,
    };
    expect((await mint(deps, s.token, { ...body, contentSha256: digest })).status).toBe(201);
    expect((await mint(deps, s.token, body)).status).toBe(201);
    expect(minted.map((m) => m.contentSha256)).toEqual([digest, null]);
  });

  it("400s on a digest that is not 64 lowercase hex, and mints nothing", async () => {
    const { deps, s, mailboxId, minted } = await armed(null);
    for (const bad of ["B".repeat(64), "abc", "g".repeat(64), "a".repeat(63)]) {
      const res = await mint(deps, s.token, {
        mailboxId, filename: "a.bin", contentType: "application/octet-stream", sizeBytes: 10,
        contentSha256: bad,
      });
      expect(res.status, bad).toBe(400);
    }
    expect(minted).toHaveLength(0);
  });

  it("does NOT carry `options.idempotent` — the key is spent on the row, not on a replay", () => {
    const route = apiRoutes.find((r) => r.pattern === "/attachments/staging");
    expect(route?.options?.idempotent).toBeFalsy();
  });
});
