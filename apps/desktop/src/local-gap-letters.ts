/**
 * ANSWERING THE GAP OFFER FROM THIS WINDOW (mail 0151) — the desktop half of one shared line, on
 * the organizer notice's argument: the published bundle aliases the Cloud client to a refusing
 * stub, so the wire is injected here. `POST /mailboxes/:id/gap-letters` is served out of this
 * machine's store on the standalone door and forwarded to the account on the hosted one. The
 * request and its refusal contract are `gapLettersVia`'s; this binds the bridge.
 */
import { bridgeFetch } from "./bridge-fetch.js";
import { gapLettersVia } from "./gap-letters-wire.js";

export const gapLettersOverBridge = gapLettersVia(bridgeFetch);
