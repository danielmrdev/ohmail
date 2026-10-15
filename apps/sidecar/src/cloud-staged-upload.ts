import type { Diagnostic } from "./log.js";

/**
 * THE HOSTED DOOR'S STAGED UPLOADS. A send too large for one request mints an upload ticket per
 * file (`POST /attachments/staging`, relayed) and PUTs the bytes to the signed URL the ticket
 * carries. The window cannot reach storage — its CSP and offline guard leave it the bridge alone
 * — so the relayed ticket is rewritten here: the signed grant stays in this process, the window
 * is handed a root-relative path under {@link STAGED_UPLOAD_PATH_PREFIX}, and its PUT there is
 * carried to the grant's URL with the grant's own method and headers and no credential of ours.
 * The signed URL never reaches the window and this door PUTs only to URLs the account minted.
 */

/** The path the window PUTs a staged file's bytes to; `bridge-fetch.ts` keeps the same literal. */
export const STAGED_UPLOAD_PATH_PREFIX = "/cloud/staged-upload/";

/** How long one file's PUT may take: a whole file over the person's uplink. */
export const STAGED_UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** Grants kept at once, oldest dropped first; a dropped one is minted again by the client's retry. */
export const STAGED_GRANTS_KEPT = 64;

const TICKET_ID = /^[A-Za-z0-9._~-]{1,128}$/;

interface Grant { url: string; method: string; headers: Record<string, string> }

export interface StagedUploads {
  /** Rewrite a relayed mint's 2xx answer so the window's PUT comes back here. */
  rewriteMint(res: Response): Promise<Response>;
  /** `PUT /cloud/staged-upload/:id` — carry the bytes to the grant this process holds. */
  upload(req: Request): Promise<Response>;
}

const refuse = (status: number, code: string, message: string, retryAfter?: number): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {}),
    },
  });

function headersOf(v: unknown): Record<string, string> | null {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x !== "string") return null;
    out[k] = x;
  }
  return out;
}

export function createStagedUploads(cfg: { fetchImpl?: typeof fetch; log?: Diagnostic } = {}): StagedUploads {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const grants = new Map<string, Grant>();

  return {
    async rewriteMint(res) {
      if (!res.ok) return res;
      const text = await res.text();
      const rebuilt = (body: string): Response => {
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        return new Response(body, { status: res.status, statusText: res.statusText, headers });
      };
      let grant: Record<string, unknown>;
      try {
        grant = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return rebuilt(text);
      }
      const { id, uploadUrl, uploadMethod } = grant;
      const headers = headersOf(grant.uploadHeaders);
      /* A ticket this door cannot carry goes back WITHOUT an upload URL, which the client refuses
         as "could not be prepared" — never with the signed URL the window has no way to reach. */
      if (typeof id !== "string" || !TICKET_ID.test(id) || typeof uploadUrl !== "string"
        || !/^https?:\/\//.test(uploadUrl) || headers === null) {
        const rest = { ...grant };
        delete rest.uploadUrl;
        return rebuilt(JSON.stringify(rest));
      }
      grants.delete(id);
      grants.set(id, {
        url: uploadUrl,
        method: typeof uploadMethod === "string" && uploadMethod !== "" ? uploadMethod : "PUT",
        headers,
      });
      if (grants.size > STAGED_GRANTS_KEPT) grants.delete(grants.keys().next().value!);
      return rebuilt(JSON.stringify({
        ...grant,
        uploadUrl: `${STAGED_UPLOAD_PATH_PREFIX}${id}`,
        uploadMethod: "PUT",
        uploadHeaders: {},
      }));
    },

    async upload(req) {
      const id = new URL(req.url).pathname.slice(STAGED_UPLOAD_PATH_PREFIX.length);
      const grant = TICKET_ID.test(id) ? grants.get(id) : undefined;
      if (!grant) {
        /* Retryable: the client's retry mints the ticket again under the same key, which puts a
           fresh grant here (this process restarted, or the grant aged out of the bound). */
        return refuse(503, "staging_ticket_unknown", "this upload was not prepared here; try again", 1);
      }
      const body = await req.arrayBuffer();
      const started = Date.now();
      let res: Response;
      try {
        res = await fetchImpl(grant.url, {
          method: grant.method,
          headers: grant.headers,
          body,
          signal: AbortSignal.timeout(STAGED_UPLOAD_TIMEOUT_MS),
        });
      } catch (err) {
        cfg.log?.("cloud_staged_upload_failed", {
          err, bytes: body.byteLength, ms: Date.now() - started,
          reason: "an attachment's bytes could not reach the account's storage; the send is retried",
        });
        return refuse(503, "staging_unreachable", "the attachment could not be uploaded", 5);
      }
      void res.body?.cancel().catch(() => undefined);
      cfg.log?.("cloud_staged_upload", { status: res.status, bytes: body.byteLength, ms: Date.now() - started });
      if (res.ok) grants.delete(id);
      const retryAfter = res.headers.get("retry-after");
      return new Response(null, {
        status: res.status === 204 ? 204 : res.ok ? 200 : res.status,
        headers: retryAfter !== null ? { "retry-after": retryAfter } : {},
      });
    },
  };
}
