import { afterEach, describe, expect, it } from "vitest";
import type { WaitingOnOrganizerView } from "@ohmail/client-engine";
import { sayArg } from "../src/refusal";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, liveMessage } from "../src/state/live";
import { waitingRowLines, waitingStripLine } from "../src/ui/waiting-lines";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

/**
 * THE PHONE LISTS WHAT WAITS ON THE ORGANIZER (gap row NO-STANDING-LIST-OF-WHAT-WAITS-ON-THE-
 * ORGANIZER): the strip's line and the sheet's rows, from the engine's merged list, which the
 * phone's own door forwards from `GET /organizer-requests` — so a repeat press after a relaunch
 * is still answered from the server's record.
 */
const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open, deleteDatabase: world.drop,
  uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(),
};
const view = (over: Partial<WaitingOnOrganizerView>): WaitingOnOrganizerView => ({
  requestId: "q1", kind: "message.move", state: "sent", holder: { name: "Laptop" }, mailboxId: "mb",
  decidedAt: "2026-10-02T09:00:00.000Z", refusedReason: null, target: { messageId: "m1", folder: "ohmail/News" },
  ruleId: null, messageId: "m1", slow: false, ...over,
});

afterEach(() => { resetLocaleRegisterForTests(); });

describe("the strip and the sheet", () => {
  it("count what is still in flight, name the holder, and say each request", () => {
    const list = [view({}), view({ requestId: "q2", kind: "rule.delete", target: { rule: { kind: "sender", match: "ann@shop.example", subjectContains: null, bodyContains: null } } })];
    expect(waitingStripLine(list)).toBe("2 changes wait on Laptop.");
    expect(list.map((w) => waitingRowLines(w).what)).toEqual(["A message to News", "Remove the rule for ann@shop.example"]);
  });

  it("a refusal is said with its reason, and a slow request says it still waits", () => {
    expect(waitingRowLines(view({ state: "refused", kind: "rule.update", refusedReason: "no_such_rule",
      target: { rule: { kind: "sender", match: "a@b.example", subjectContains: null, bodyContains: null }, destination: "ohmail/Receipts" } })))
      .toEqual({ what: "The rule for a@b.example: files into Receipts", state: "Laptop did not carry this out." });
    expect(waitingRowLines(view({ slow: true })).state).toBe("Still waiting for Laptop.");
    expect(waitingStripLine([view({ state: "refused", refusedReason: "no_such_rule" })])).toBe("Laptop did not carry this out.");
  });

  it("CONTROL: nothing waiting draws nothing; German has its own words", () => {
    expect(waitingStripLine([])).toBeNull();
    setActiveLocale("de");
    expect(waitingStripLine([view({})])).toBe("1 Änderung wartet auf Laptop.");
  });
});

describe("the phone's door forwards the list", () => {
  it("the server's record is in the engine's list, and a repeat press after a relaunch is answered from it", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("m1", { subject: "Weekly" }));
    fake.setWaitingRequests([{
      id: "q1", kind: "message.move", state: "sent", mailboxId: "mb1", holder: { name: "Studio laptop" },
      decidedAt: "2026-01-01T00:00:00.000Z", resolvedAt: null, refusedReason: null,
      target: { messageId: "m1", folder: "ohmail/News" },
    }]);
    const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
    if (boot.kind !== "ready") throw new Error("boot refused");
    try {
      await boot.verifyIdentity();
      await boot.engine.start();
      boot.engine.waitingOnOrganizer();
      await new Promise((r) => setTimeout(r, 50));
      expect(boot.engine.waitingOnOrganizer()).toEqual([expect.objectContaining({ requestId: "q1", messageId: "m1", slow: true })]);
      const said: string[] = [];
      const actions = liveActions({ engine: boot.engine, uuid: deps.uuid, zone: "UTC", toast: (m) => void said.push(sayArg(m)) });
      const row = liveMessage(boot.engine, "m1", { now: new Date(), zone: "UTC" })!;
      const before = fake.seen.filter((r) => r.url.endsWith("/move")).length;
      expect(await actions.move(row, "reads")).toBe(true);
      expect(said).toEqual(["Still waiting for Studio laptop."]);
      expect(fake.seen.filter((r) => r.url.endsWith("/move")).length, "a second request went out").toBe(before);
    } finally { boot.store.close(); fake.server.close(); }
  });
});
