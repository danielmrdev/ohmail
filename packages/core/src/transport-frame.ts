/**
 * `@trafficflow/core/transport-frame` — THE BYTE THE TRANSPORT REFUSES ON, in one place.
 *
 * The local engine is reached over a length-prefixed stdio frame codec (`apps/sidecar/src/
 * frame.ts`), whose cap is fatal: the stream has no resync point. The number lives HERE because
 * the thing that BUILDS a response has to know it too — a page correct by every row rule is still
 * undeliverable if its bytes do not fit, and two literals in two packages is how that stayed
 * invisible for a release. Constants only and no imports: three graphs read this leaf, and
 * anything it reached would travel into all three.
 */

/**
 * The largest body one frame carries. A send's attachments cross it twice as base64 — the change
 * the window records, then the send itself — so it carries 40 MiB of files with room for the
 * message; a `/sync` page is bounded apart, by {@link SYNC_PAGE_MAX_BYTES}, and this is never the
 * answer to a page that does not fit.
 */
export const TRANSPORT_FRAME_MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * What one `/sync` page may weigh on the wire. Sized against what the API returns rather than
 * "big enough": `DEFAULT_SYNC_BATCH_MAX_BYTES` in the IMAP adapter is 32 MB. Match it and stop.
 */
export const SYNC_PAGE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * What a frame carries BESIDES the rows, held back from the page's own budget: the response
 * envelope the rows sit in (`asOfSeq`, `nextCursor`, `window`, the array's punctuation), the
 * header JSON and the eight-byte preamble.
 *
 * Reserved rather than measured per page, because the page is built before its envelope exists —
 * and generous by a wide margin: a cursor is a few hundred base64 characters and the header is
 * bounded by `MAX_HEADER_BYTES` (64 KiB) on the same wire.
 */
export const TRANSPORT_FRAME_ENVELOPE_RESERVE_BYTES = 128 * 1024;

/**
 * What the ROWS of one page may weigh. The single number a paginator bounds itself by, and the
 * only correct way to spend {@link SYNC_PAGE_MAX_BYTES}.
 */
export const PAGE_MAX_ROW_BYTES =
  SYNC_PAGE_MAX_BYTES - TRANSPORT_FRAME_ENVELOPE_RESERVE_BYTES;
