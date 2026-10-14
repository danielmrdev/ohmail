import { handleApiRequest } from "../../src/handler.js";

/**
 * `/events` GETS ITS OWN ROUTE MODULE for exactly one number: `maxDuration`.
 *
 * The catch-all (`app/[[...path]]/route.ts`) declares 60 s, which is right for everything
 * request-shaped — a slow IMAP LOGIN, a sequential `download-all` — and wrong for a held SSE
 * stream, whose whole value grows with its lifetime: every reconnect is a new invocation and a
 * new baseline read, so a 30-second cycle costs 120 invocations per tab-hour where a 270-second
 * one costs ~13. On Fluid compute a stream that spends its life parked on `await` bills active
 * CPU, not wall clock, so the long lifetime is the cheap direction, not the expensive one.
 *
 * 300 here and 270 s in `PROD_SSE_LIFETIME_MS` (`src/config.ts`), and the 30-second margin is
 * the contract: the SERVER must end the stream (a clean close is an ordinary `EventSource`
 * reconnect on the `retry:` hint), never the platform (a kill is a dropped socket the client
 * reads as an error). `loadHostConfig` refuses a `TF_SSE_LIFETIME_MS` that would breach the
 * margin, and `host-wiring.test.ts` pins the relation between this export and that constant.
 *
 * Everything else is the catch-all's contract verbatim — same handler, same runtime, same
 * region, every method exported so a non-GET `/events` still gets the API's own JSON 405
 * rather than a framework page. `packages/api` still owns what `/events` IS; this file owns
 * only how long the platform lets one invocation of it live.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const preferredRegion = "fra1";

export async function GET(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function HEAD(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function POST(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function PUT(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function PATCH(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function DELETE(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function OPTIONS(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
