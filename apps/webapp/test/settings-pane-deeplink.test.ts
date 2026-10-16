/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { PANE_IDS, initialPaneFromUrl } from "../app/views/SettingsView";
import { parseHash } from "../app/shell/routing";

/**
 * `?settings=<pane>` — THE DEEP LINK THE CONSENT CEREMONY LANDS ON.
 *
 * The Microsoft callback bounces the browser to `/mailbox?settings=mailboxes&oauth=…#/settings`. The
 * hash opens the settings VIEW; without this parameter the view opens on General and the sentence
 * explaining what just happened is one click away and invisible. So the pane is part of the link, and
 * these are the two properties that make reading a pane name out of a URL safe.
 */
afterEach(() => { window.history.replaceState(null, "", "/mailbox"); });

const at = (search: string): string => {
  window.history.replaceState(null, "", `/mailbox${search}#/settings`);
  return initialPaneFromUrl();
};

describe("the settings pane can be named in a link", () => {
  it("opens the pane the URL asks for, and General when it asks for nothing", () => {
    expect(at("")).toBe("general");
    expect(at("?settings=mailboxes")).toBe("mailboxes");
    expect(at("?settings=security")).toBe("security");
    // Alongside the ceremony's own parameters, which is how it actually arrives.
    expect(at("?settings=mailboxes&oauth=pending&state=S&code=C")).toBe("mailboxes");
  });

  it("an UNRECOGNISED value is General, never a pane that renders nothing", () => {
    // `pane` selects a render branch. A value from a URL that matched none of them would render an
    // empty settings screen — which is why this validates against the list rather than casting.
    for (const bad of ["?settings=", "?settings=nope", "?settings=__proto__", "?settings=Mailboxes"]) {
      expect(at(bad), bad).toBe("general");
    }
  });

  it("every id in the list is one the pane switch actually has", () => {
    // The list is hand-written beside a `PaneId` union that the compiler checks, so this asserts the
    // pair is complete rather than merely well-typed: a pane added to the union and not to the list
    // is silently unreachable by link.
    const source = PANE_IDS.join(" ");
    for (const id of ["general", "notifications", "mailboxes", "screener", "away", "billing", "tags", "rules", "about", "security", "account", "desktop"]) {
      expect(source, id).toContain(id);
    }
  });
});

describe("the hash opens the VIEW — and it can name the pane now, which this link predates", () => {
  it("`#/settings` and `#/settings/mailboxes` are both the settings view", () => {
    // This used to assert the second form fell through to the Ohbox — the reason the ceremony's
    // pane rode a query parameter. The segment exists now (`#/settings/<pane>`, walkable with
    // Back/Forward; see `settings-subroutes.test.tsx`), and it OUTRANKS this parameter. The
    // parameter's own contract above is unchanged: it decides the BARE `#/settings` mounts,
    // which is exactly the hash the ceremony's redirect carries.
    expect(parseHash("#/settings").view).toBe("settings");
    expect(parseHash("#/settings").settingsPane).toBeNull();
    expect(parseHash("#/settings/mailboxes")).toMatchObject({ view: "settings", settingsPane: "mailboxes" });
  });
});
