import { describe, expect, it } from "vitest";

import { mailtoPrefill } from "../src/ui/mailto";
import { frameNavDecision, openConfirmedLink } from "../src/mail/frame-nav";
import { sayArg, type RefusalArg } from "../src/refusal";
import { PHONE_LINK_SCHEME } from "../src/mail/sanitize";
import { MAILTO_SURFACE_CASES } from "../../desktop/test/mailto-cases";

/**
 * THE PHONE'S HALF OF THE ONE MAILTO PARSER. The parser's own cases are core's
 * (`apps/desktop/test/mailto.test.ts`); here the phone's adapter carries all five fields into its
 * composer, driven by the table every surface reads (PHONE-MAILTO-CC-BCC-NOT-CARRIED).
 */
describe("the phone's mailto adapter", () => {
  for (const c of MAILTO_SURFACE_CASES) {
    it(`carries every field into the composer: ${c.name}`, () => {
      expect(mailtoPrefill(c.link)).toEqual({
        to: c.to.join(", "), cc: c.cc.join(", "), bcc: c.bcc.join(", "), subject: c.subject, body: c.body,
      });
    });
  }
  it("a link that asks for nothing opens a plain compose; one that is no mailto too", () => {
    expect(mailtoPrefill("mailto:")).toBeUndefined();
    expect(mailtoPrefill("https://x.example")).toBeUndefined();
    expect(mailtoPrefill(undefined)).toBeUndefined();
  });
});

/* THE PHONE'S HALF: a `mailto:` in a message opens ohmail's composer, and a link nothing on the
   phone can open says so (PHONE-MAILTO-LEAVES-THE-APP, PHONE-LINK-OPEN-REFUSAL-SILENT). */
describe("a link pressed in a message on the phone", () => {
  const links = ["mailto:a@x.example?subject=Hi", "https://example.org/x"];
  it("a mailto goes to the composer, never to the confirm sheet", () => {
    expect(frameNavDecision(`${PHONE_LINK_SCHEME}0`, links)).toEqual({ kind: "compose", url: links[0] });
    expect(frameNavDecision(`${PHONE_LINK_SCHEME}1`, links)).toEqual({ kind: "confirm", url: links[1] });
  });
  it("a link the platform cannot open is said; one it opens says nothing", async () => {
    const said: string[] = [];
    const say = (a: RefusalArg) => { said.push(sayArg(a)); };
    await openConfirmedLink("https://example.org/x", { openURL: () => Promise.resolve(true), say });
    expect(said).toEqual([]);
    await openConfirmedLink("weird:thing", { openURL: () => Promise.reject(new Error("No Activity found")), say });
    expect(said).toEqual(["Nothing on this phone can open that link."]);
  });
});
