/**
 * A FORWARD WHOSE ORIGINAL THE SERVER COULD NOT LOAD SAYS SO ON THE PHONE — through `bootEngine`'s
 * real HttpAdapter and engine against a fake speaking the send route's own wire. The phone used to
 * show "Sending didn't work. Try again." for `forward_original_unavailable`, a retry that cannot
 * succeed; it now says the web's sentence, in both languages, online or not.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { DE } from "../src/copy.de";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, refusedSendSay, type LiveWorldActions } from "../src/state/live";
import { failedSendLine } from "../src/ui/send-failed";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
const peer = [{ name: null, address: "peer@fake.test" }];
const SEND = "/drafts/d-1/send";
const UNAVAILABLE_409 = {
  error: { code: "forward_original_unavailable", message: "The original could not be loaded, so it was not forwarded." },
};
const EN = "Not sent. The original could not be loaded, so it was not forwarded.";
const DE_SENTENCE = "Nicht gesendet. Das Original konnte nicht geladen werden, darum wurde es nicht weitergeleitet.";

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Scan" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  open.push({ close: () => { boot.store.close(); fake.server.close(); } });
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  return { fake, ...boot, actions, toasts };
}

describe("a forward refused for its original says why", () => {
  it("409 forward_original_unavailable: failed, the forward's own sentence, the row kept", async () => {
    const live = await scene();
    live.fake.answerNext("POST", SEND, 409, UNAVAILABLE_409);
    const res = await live.actions.sendForward("m1", peer, "");
    expect(res).toMatchObject({ outcome: "failed", failure: "replyForwardOriginalUnavailable", draftId: "d-1" });
    expect(live.toasts).toEqual([EN]);
    expect(sayArg(refusedSendSay("replyForwardOriginalUnavailable"))).toBe(EN);
  }, 30_000);

  it("offline does not hide it: an unloadable original is not a network condition", () => {
    expect(failedSendLine("replyForwardOriginalUnavailable", null, true)).toBe(EN);
    expect(failedSendLine("replyForwardOriginalUnavailable", { kind: "lost" }, true)).toBe(EN);
    expect(Copy.replyForwardOriginalUnavailable).toBe(EN);
  });

  it("German carries the web's German sentence", () => {
    expect(DE.replyForwardOriginalUnavailable).toBe(DE_SENTENCE);
  });
});
