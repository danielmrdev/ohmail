/**
 * A SPAM VERDICT'S HUSK, READ ON THE PHONE (FIX-023) — through the composition the app runs
 * (`bootEngine`, `liveActions.openMessage`, `liveMessage`) against the loopback server answering
 * the body route with `withheld`. The row carries the marker, and says the husk is on its way back
 * only where the message is no longer in the spam pile: that is what `body-note.ts` chooses from.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootEngine } from "../src/engine/boot";
import { liveActions, liveMessage, type WorldView } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { arrived, CASE_MS } from "./helpers/arrived";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, "0")}`;
let closers: Array<() => void> = [];
afterEach(() => { for (const c of closers.reverse()) c(); closers = []; });

async function opened(folder: string) {
  const store = sqlWorld();
  const fake = mailServer();
  const origin = await listen(fake.server);
  closers.push(() => fake.server.close());
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "not spam after all", folder, unread: false }));
  fake.setWithheld("m1", "junk_filed");
  const boot = await bootEngine({ openExecutor: store.open, deleteDatabase: store.drop, uuid }, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  closers.push(() => boot.store.close());
  await boot.verifyIdentity();
  await boot.engine.start();
  await liveActions({ engine: boot.engine, toast: () => undefined }).openMessage("m1");
  // An already-read message's open returns at once: the husk's answer is still on the wire.
  const row = () => liveMessage(boot.engine, "m1", view);
  await arrived("m1's withheld body", () => row()?.bodyState === "withheld", () => row()?.bodyState ?? "no row");
  return row();
}

describe("a spam verdict's husk on the phone", () => {
  it("moved out of the spam pile, the row says it is on its way back", async () => {
    const row = await opened("INBOX");
    expect(row?.bodyState).toBe("withheld");
    expect(row?.bodyWithheld).toBe("junk_filed");
    expect(row?.bodyJunkLeaving).toBe(true);
  }, CASE_MS);

  it("CONTROL: still in the spam pile, it is the verdict's husk and nothing is on its way", async () => {
    const row = await opened("ohmail/Quarantine");
    expect(row?.bodyWithheld).toBe("junk_filed");
    expect(row?.bodyJunkLeaving).toBeUndefined();
  }, CASE_MS);
});
