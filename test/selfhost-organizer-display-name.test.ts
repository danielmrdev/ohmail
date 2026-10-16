import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { organizerDisplayNameFrom } from "../apps/worker/src/config.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A SELF-HOSTED SERVER NAMES ITSELF, NEVER "ohmail Cloud"
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED ON THE RELEASED STACK: a person running their own server on their own machine opened
 * the desktop app and read *"Organized by ohmail Cloud — This computer reads the mailbox; it
 * moves nothing and screens nothing."* The organizer was their own box. The string travels in
 * the claim (`X-Ohmail-Display-Name` in `ohmail/_meta`), so it is also what they see if they open
 * that folder in any other mail client — a hosted service they are not a customer of, named as
 * the thing that took their mail.
 *
 * ── THE TWO WAYS THIS GOES WRONG, AND WHY A DERIVATION TEST ALONE WOULD MISS BOTH ──────────
 *
 * `organizerDisplayNameFrom` was written and is right. What made the untruth ship is the
 * DEPLOYMENT around it, in two places a unit test of the function cannot see:
 *
 *  1. `OHMAIL_ORIGIN` WAS NEVER IN THE ORGANIZER'S CONTAINER. Every `${OHMAIL_ORIGIN}` in the
 *     compose file is an interpolation — resolved on the host, substituted into some OTHER
 *     variable's value — and none of them puts the name in the process environment the worker
 *     reads. So the origin→host fallback, which the compose file's own comment promised
 *     ("unset, the worker still defaults to the origin's host"), could not run at all: an absent
 *     or empty display name returned `undefined`, and `undefined` is `CLOUD_DISPLAY_NAME`.
 *  2. THE `:-${OHMAIL_ORIGIN}` DEFAULT SKIPPED THE PARSE. Handing the origin in as the EXPLICIT
 *     value takes the explicit branch, which is verbatim by design — so where it did work it
 *     named the deployment `https://mail.example.com` rather than `mail.example.com`. A default
 *     that looks like it implements the fallback, and instead makes the fallback unreachable.
 *
 * Both are properties of files, so both are asserted against the files. This is
 * `selfhost-organizer-identity.test.ts`'s shape and its reason: a variable the code reads and the
 * deployment drops is a feature that cannot be turned on.
 *
 * ── HOW TO WATCH IT FAIL ───────────────────────────────────────────────────────────────────
 *
 * Put `:-${OHMAIL_ORIGIN}` back on the compose default and "the default is not the raw origin"
 * goes red; delete the `OHMAIL_ORIGIN:` line from the organizer block and "the container can
 * reach the origin" goes red with the worker answering the hosted name for an empty override —
 * which is the released behaviour exactly. Both mutations were run.
 */

const r = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const COMPOSE = r("../deploy/selfhost/docker-compose.yml");
const ENV_EXAMPLE = r("../deploy/selfhost/.env.example");

const NAME = "TF_ORGANIZER_DISPLAY_NAME";

/** The organizer service's own environment block — the container that opens IMAP and writes claims. */
const organizerBlock = (): string =>
  COMPOSE.split(/^ {2}organizer:$/m)[1]?.split(/^ {2}\w/m)[0] ?? "";

describe("a self-hosted organizer names its own origin", () => {
  describe("the derivation", () => {
    it("an operator's explicit name wins, trimmed, and newlines cannot reach an RFC822 header", () => {
      expect(organizerDisplayNameFrom({ [NAME]: "  Front office server  " })).toBe("Front office server");
      expect(organizerDisplayNameFrom({ [NAME]: "Front\r\noffice" })).toBe("Front office");
    });

    it("no explicit name: the ORIGIN'S HOST, which is the string a person should read", () => {
      // Not the scheme, not the path — "Organized by mail.example.com".
      expect(organizerDisplayNameFrom({ OHMAIL_ORIGIN: "https://mail.example.com" })).toBe("mail.example.com");
      expect(organizerDisplayNameFrom({ OHMAIL_ORIGIN: "https://ohmail.qa-lane.ts.net/" })).toBe("ohmail.qa-lane.ts.net");
      // A bare host is what an operator may well have written, and it is already the answer.
      expect(organizerDisplayNameFrom({ OHMAIL_ORIGIN: "mail.example.com" })).toBe("mail.example.com");
    });

    it("EMPTY IS UNSET, and that is the case the released stack was actually in", () => {
      /* An operator who exported the variable with no value meant "use the default", and the
         compose file now sets exactly that (`:-`). If empty were taken literally the claim would
         carry an empty display name; if it fell through with no origin in the container it
         carries the hosted one. The origin beside it is what makes this answer true. */
      expect(organizerDisplayNameFrom({ [NAME]: "", OHMAIL_ORIGIN: "https://mail.example.com" }))
        .toBe("mail.example.com");
      expect(organizerDisplayNameFrom({ [NAME]: "   ", OHMAIL_ORIGIN: "https://mail.example.com" }))
        .toBe("mail.example.com");
    });

    it("NOTHING AT ALL is undefined — the hosted default, and the only deployment it is true of", () => {
      /* This is the arm the released self-host stack reached, and it is CORRECT here: with no
         origin and no name there is nothing truthful to say. The defect was never this
         function — it was a container in which this was the only reachable arm. */
      expect(organizerDisplayNameFrom({})).toBeUndefined();
    });
  });

  describe("the deployment the operator actually runs", () => {
    it("THE CONTAINER CAN REACH THE ORIGIN — otherwise the derivation above is unreachable code", () => {
      /* A real assignment, not an interpolation into some other variable. The regex anchors on
         the KEY at the start of a line, which `MS_OAUTH_REDIRECT_URI: ${...${OHMAIL_ORIGIN}...}`
         does not satisfy — that distinction is the entire finding. */
      expect(
        organizerBlock(),
        "the organizer container has no OHMAIL_ORIGIN, so an unset display name is the hosted name",
      ).toMatch(/^\s*OHMAIL_ORIGIN:\s*\$\{OHMAIL_ORIGIN/m);
    });

    it("the display name is passed to the ORGANIZER, which is the process that writes claims", () => {
      expect(organizerBlock()).toContain(`${NAME}:`);
      const apiBlock = COMPOSE.split(/^ {2}api:$/m)[1]?.split(/^ {2}\w/m)[0] ?? "";
      expect(apiBlock, "the api writes no claim and has no use for a claim's display name")
        .not.toContain(NAME);
    });

    it("THE DEFAULT IS NOT THE RAW ORIGIN — that spelling skips the host parse", () => {
      /* `${TF_ORGANIZER_DISPLAY_NAME:-${OHMAIL_ORIGIN}}` reads as "fall back to the origin" and
         does the opposite of what the fallback does: it arrives as the EXPLICIT value, which is
         taken verbatim, so every banner in the deployment reads `https://mail.example.com`. */
      expect(organizerBlock()).not.toMatch(
        new RegExp(`${NAME}:\\s*\\$\\{${NAME}:-\\$\\{OHMAIL_ORIGIN\\}\\}`),
      );
      // Unset is the resting state and must not be a hard refusal: the origin already answers it.
      expect(organizerBlock()).toMatch(new RegExp(`${NAME}:\\s*\\$\\{${NAME}:-\\s*\\}`));
    });

    it("the .env template tells the operator what it is and that empty is the right answer", () => {
      expect(ENV_EXAMPLE).toContain(`${NAME}=`);
      expect(ENV_EXAMPLE.toLowerCase()).toContain("ohmail_origin's host");
    });
  });
});
