/**
 * EVERY API RESPONSE CARRIES `X-Content-Type-Options: nosniff`.
 *
 * Found by a pass over the LIVE surface: `api.ohmail.app` returned only
 * `strict-transport-security` on a 401, while the webapp returns a full set (CSP with
 * `frame-ancestors 'none'`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, HSTS). So the
 * hardening was done where it matters most and the API was the gap.
 *
 * ── SEVERITY, STATED SO NOBODY INFLATES IT LATER ───────────────────────────────────────────
 *
 * This is defence in depth, not a fix for a live vector. Every JSON body is served
 * `application/json` and a modern browser honours that. The header is here because its absence is
 * a standard audit finding and because the cost is one line at a chokepoint.
 *
 * **The one surface where sniffing genuinely could matter is attachments**, whose bytes AND
 * declared `Content-Type` are chosen by the SENDER — the shape exactly. Two things were checked
 * before deciding severity, and both are recorded because they are what keeps this low:
 *
 *  1. `contentDisposition()` (`routes/attachments.ts:26-31`) always emits `attachment; filename=…`
 *     and **never `inline`**, so a browser downloads rather than renders. That is what closes the
 *     stored-XSS-via-render vector, and it closed it before this test existed.
 *  2. The attachment routes build their own `Response` and so **bypass `jsonResponse` entirely** —
 *     which is why asserting the header only on the JSON envelope would have missed the one
 *     surface that actually matters. That asymmetry is the substance of that change.
 *
 * ── WHAT IS DELIBERATELY NOT ASSERTED ──────────────────────────────────────────────────────
 *
 * CSP, `X-Frame-Options` and `Referrer-Policy` are NOT set on the API and this test does not want
 * them: with every response `application/json` there is nothing to frame and nothing to navigate
 * from. Asserting inert headers would make the suite look stricter than the reasoning behind it.
 */
import { describe, it, expect, vi } from "vitest";
import { attachments as attachmentsTbl } from "@trafficflow/db";
import { AttachmentsService } from "@trafficflow/services";
import { ACCOUNT_HEADER, createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { errorResponse, jsonResponse } from "../src/responses.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeDeps, seedSession, seedMessage, req, FIXED_NOW } from "./helpers.js";

const NOSNIFF = "nosniff";

describe("nosniff on the API's responses", () => {
  it("jsonResponse sets it, so every route that uses the envelope inherits it", () => {
    const r = jsonResponse({ ok: true });
    expect(r.headers.get("X-Content-Type-Options")).toBe(NOSNIFF);
    expect(r.headers.get("Content-Type")).toBe("application/json");
  });

  it("errorResponse inherits it — the shape the live 401 was missing", () => {
    const r = errorResponse("unauthorized", 401, "authentication required");
    expect(r.status).toBe(401);
    expect(r.headers.get("X-Content-Type-Options")).toBe(NOSNIFF);
  });

  it("a caller's own headers do not displace it", () => {
    // `jsonResponse` seeds `new Headers(init.headers)` and then sets its own, so a route passing
    // `X-Sync-Seq` or a cache directive must not end up dropping this one.
    const r = jsonResponse({ ok: true }, { headers: { "Cache-Control": "no-store" }, seq: 7 });
    expect(r.headers.get("X-Content-Type-Options")).toBe(NOSNIFF);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("X-Sync-Seq")).toBe("7");
  });

  /**
   * The attachment routes are asserted at SOURCE rather than by driving the route, because reaching
   * them needs a stored blob, a KEK and a session — and the claim under test is structural: the
   * route must not build a raw `Response` without the header. A source assertion states exactly
   * that, and it fails when someone adds a fourth attachment response and forgets.
   */
  it("every raw Response in the attachment routes sets it — they bypass the envelope", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/routes/attachments.ts", import.meta.url)),
      "utf8",
    );
    const raw = src.match(/new Response\(/g)?.length ?? 0;
    const sniff = src.match(/X-Content-Type-Options/g)?.length ?? 0;
    // Anti-vacuity: if the file stopped building raw responses this test would pass on nothing.
    expect(raw, "attachments.ts no longer builds raw Responses — re-decide this assertion").toBeGreaterThanOrEqual(3);
    expect(
      sniff,
      `attachments.ts builds ${raw} raw Response(s) but sets X-Content-Type-Options ${sniff} time(s). ` +
        "These bytes and their Content-Type are SENDER-CHOSEN and bypass jsonResponse, so the " +
        "envelope's header does not cover them.",
    ).toBeGreaterThanOrEqual(raw);
    // And the disposition that actually closes the render vector is still `attachment`, never inline.
    expect(src).toContain('`attachment; filename=');
    expect(src).not.toContain("inline;");
  });
});

/**
 * `X-Ohmail-Account` — the second header this API sets on its own behalf, and the one with a
 * SECURITY meaning rather than a hardening one. Its own censuses are in
 * `account-header-census.test.ts`; what belongs here, in the file that enumerates what this API
 * puts on a response, are the two facts a reader of the envelope needs.
 *
 * The layering is the substance: this header is set ABOVE the pipelines, in `createApp.handle`,
 * and NOT in the envelope. That is deliberate and it is the opposite choice from `nosniff` above.
 * `nosniff` belongs on the envelope because every JSON body needs it and the raw responses set it
 * themselves. This one cannot live there at all — the attachment routes, the SSE stream and the
 * OAuth redirect all build their own `Response` and would silently miss it, which is precisely the
 * asymmetry an earlier change was written about, one header along. Adding it to `jsonResponse` would make the
 * envelope's responses carry it TWICE over and the raw ones carry it by luck.
 */
describe("X-Ohmail-Account — the account a response was issued for", () => {
  it("the envelope does NOT set it — it is not a per-response decision", () => {
    expect(jsonResponse({ ok: true }).headers.get(ACCOUNT_HEADER)).toBeNull();
    expect(errorResponse("unauthorized", 401, "nope").headers.get(ACCOUNT_HEADER)).toBeNull();
  });

  /**
   * A SUCCESSFUL raw byte response, not a 404 wearing one's clothes.
   *
   * This case previously asked for a random attachment id. That 404s inside `resolvePart`, and the
   * route catches it into `errorResponse` — so the assertion was made against the JSON envelope on
   * a route whose whole point is that it BYPASSES the envelope, and a regression confined to the
   * successful byte path would not have moved it. The fixture below reaches
   * `routes/attachments.ts`'s `new Response(toBody(body), …)`: a real message with a native
   * locator and a real attachment row, and the fetch itself stubbed at the service seam.
   *
   * **WHAT THIS FIXTURE DOES NOT COVER, stated rather than implied:** it stubs
   * `AttachmentsService.fetchBytes`, so it proves the ROUTE builds and returns a raw byte
   * response that carries the header — `routes/attachments.ts`'s `new Response(toBody(body), …)`
   * — and proves nothing about IMAP, the part resolver or the byte ceiling, which have their own
   * suites. Reaching that line for real needs an encrypted credential envelope no fixture in this
   * repository writes, and inventing one here would put the encryption in the test rather than
   * the claim.
   */
  it("a successful RAW byte response carries it — the path that bypasses the envelope", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { id: messageId } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    const [att] = await db.insert(attachmentsTbl).values({
      accountId: s.accountId, messageId, filename: "note.txt",
      contentType: "text/plain", sizeBytes: 5, inline: false, partId: "2",
    }).returning();
    const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    vi.spyOn(AttachmentsService.prototype, "fetchBytes").mockResolvedValue({
      contentType: "text/plain", filename: "note.txt", body: bytes,
    } as Awaited<ReturnType<AttachmentsService["fetchBytes"]>>);

    const app = createApp(apiRoutes);
    const drive = (path: string): Promise<Response> =>
      app.handle(req("GET", path, { bearer: s.token }), { ...deps, session: null } as ApiDeps);

    const attachment = await drive(`/attachments/${att!.id}`);
    const enveloped = await drive("/mailboxes");

    // Anti-vacuity: prove it is the BYTE path, not an error rendered as one.
    expect(attachment.status, "the fixture must reach the successful byte path").toBe(200);
    expect(attachment.headers.get("Content-Type")).toBe("text/plain");
    expect(new Uint8Array(await attachment.arrayBuffer())).toEqual(bytes);

    expect(attachment.headers.get(ACCOUNT_HEADER)).toBe(s.accountId);
    expect(enveloped.headers.get(ACCOUNT_HEADER)).toBe(s.accountId);
  });
});
