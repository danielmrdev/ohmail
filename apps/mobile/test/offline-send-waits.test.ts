/* @reads: apps/mobile/src/ui/MessageActions.tsx apps/mobile/src/net/pairing.ts */
/**
 * A SEND PRESSED WITH NO NETWORK WAITS, ONCE, AND GOES WHEN THE NETWORK IS BACK.
 *
 * The standalone door through this app's own `bootEngine` composition, over a local door that
 * answers as the engine does when it cannot reach the mail server (`409 {status: "failed"}`).
 * Measured on the base: every offline press reached the engine, failed, and left a draft row; a
 * press again was a new key and another row. The network is the door's (`net/network-door.ts`),
 * driven by a reader this file owns. The composer is read, not rendered (`fourth-door.test.ts`).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootEngine, LOCAL_ENGINE_ORIGIN, type LocalEngineDoor, type MobileEngineDeps } from "../src/engine/boot";
import { queuedCaptionKey, sendWaitsForNetwork } from "../src/engine/send-waits";
import { installNetworkReader, networkNow, type NetworkReader } from "../src/net/network-door";
import { flushQueued, liveActions } from "../src/state/live";
import { Copy } from "../src/copy";
import { sayArg } from "../src/refusal";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSER = readFileSync(join(APP, "src/ui/MessageActions.tsx"), "utf8");
const PAIRING = readFileSync(join(APP, "src/net/pairing.ts"), "utf8");
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();

afterEach(() => { installNetworkReader(null); });

/** The platform's reader, turned by hand. */
function networkSwitch(start: "online" | "offline"): { reader: NetworkReader; set(s: "online" | "offline"): void } {
  let state = start;
  const listeners = new Set<(r: unknown) => void>();
  return {
    reader: { read: () => state, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } },
    set(s) { state = s; for (const l of [...listeners]) l(s); },
  };
}

/** One standalone phone: the loopback server stands in for the engine behind the local door. */
async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }));
  const net = networkSwitch("online");
  installNetworkReader(net.reader);
  const door: LocalEngineDoor = {
    sessionToken: "launch-1",
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      // THE ENGINE WITH NO NETWORK: the send cannot reach the mail server and is refused as failed.
      if (networkNow() === "offline" && req.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(url.pathname)) {
        await req.text();
        return new Response(JSON.stringify({ status: "failed", message: "the mail server could not be reached" }), {
          status: 409, headers: { "content-type": "application/json" },
        });
      }
      const body = req.method === "GET" ? undefined : await req.text();
      return fetch(`${origin}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
    },
  };
  /* A mirror of its own: the outbox is durable, and a shared one would restore the last case's send. */
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid,
    fetch: async () => { throw new Error("the global transport was used on the standalone door"); },
  };
  const boot = await bootEngine(deps, {
    origin: LOCAL_ENGINE_ORIGIN, accountId: "acct-1", localEngine: door, network: networkNow,
  });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.engine.start();
  const toasts: string[] = [];
  const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  return { fake, net, engine: boot.engine, store: boot.store, actions, toasts };
}

const drafted = (fake: ReturnType<typeof mailServer>) => fake.seen.filter((r) => r.method === "POST" && r.url === "/drafts");
const sendsOf = (fake: ReturnType<typeof mailServer>) =>
  fake.seen.filter((r) => r.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(r.url));
const TO = [{ name: "Bo", address: "bo@fake.test" }];

describe("a send pressed with no network", () => {
  it("waits in the outbox under one key, reaches nothing, and says it goes when the network is back", async () => {
    const s = await scene();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "Offline", "Written on a train.");
    expect(res.outcome, "the press did not wait for the network").toBe("queued");
    expect(res.key, "a waiting send carries the key the composer follows").toBeTruthy();
    const pending = s.engine.pendingMutations();
    expect(pending.map((p) => p.mutation.kind)).toEqual(["mail_send"]);
    expect(pending[0]!.key).toBe(res.key);
    expect(drafted(s.fake), "the words were not kept in one draft").toHaveLength(1);
    expect(sendsOf(s.fake), "the send step reached the engine with no network").toHaveLength(0);
    expect(s.toasts).toContain(Copy.replyQueuedOffline);
    s.store.close();
  }, 60_000);

  it("pressed again, it stays one key and one draft, and goes once", async () => {
    const s = await scene();
    s.net.set("offline");
    for (let i = 0; i < 3; i++) await s.actions.sendReply("m-1", "The same reply.", false);
    const keys = new Set(s.engine.pendingMutations().map((p) => p.key));
    expect(keys.size, "a press again minted a second key").toBe(1);
    expect(drafted(s.fake), "each press left a draft").toHaveLength(1);
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries(), "not exactly one delivery").toEqual([...keys]);
    expect(drafted(s.fake), "not exactly one draft row").toHaveLength(1);
    /* A new mail has no reply to resume: its second press is refused at the sheet, whose Send is
       lit only while the composer idles, and a waiting send is `queued`. */
    expect(COMPOSER).toMatch(/const canSend =\s*\n?\s*phase === "idle" &&/);
    s.store.close();
  }, 60_000);

  it("goes once when the network is back", async () => {
    const s = await scene();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "Offline", "Written on a train.");
    expect(res.outcome).toBe("queued");
    s.net.set("online");
    const settled = await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(settled.get(res.key!)?.status, "the waiting send did not go when the network came back").toBe("confirmed");
    expect(s.fake.deliveries(), "not exactly one delivery").toEqual([res.key]);
    expect(drafted(s.fake), "not exactly one draft row").toHaveLength(1);
    expect(s.engine.pendingMutations()).toHaveLength(0);
    /* A second flush finds nothing to send. */
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(sendsOf(s.fake)).toHaveLength(1);
    s.store.close();
  }, 60_000);

  it("cancelled while it waits, it keeps the words in its one draft and sends nothing on the return", async () => {
    const s = await scene();
    s.net.set("offline");
    const res = await s.actions.sendNew("mb-1", TO, "Second thoughts", "Maybe not.");
    expect(res.outcome).toBe("queued");
    expect(await s.actions.withdrawSend(res.key!)).toBe("withdrawn");
    const rows = s.fake.draftRows();
    expect(rows.map((r) => r.subject), "the cancelled letter's words were lost").toEqual(["Second thoughts"]);
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(sendsOf(s.fake), "a cancelled send went on the return").toHaveLength(0);
    s.store.close();
  }, 60_000);

  it("CONTROL: online, the same press goes at once, and Send later offline still reaches the engine", async () => {
    const s = await scene();
    const sent = await s.actions.sendNew("mb-1", TO, "Online", "At the desk.");
    expect(sent.outcome).toBe("sent");
    expect(sendsOf(s.fake)).toHaveLength(1);
    s.net.set("offline");
    const later = new Date(Date.now() + 3 * 3600_000).toISOString();
    await s.actions.sendNew("mb-1", TO, "Later", "Tomorrow's.", null, later);
    expect(s.fake.seen.some((r) => r.method === "POST" && /\/schedule$/.test(r.url)),
      "an appointment was held as though it were a delivery").toBe(true);
    s.store.close();
  }, 60_000);
});

describe("the decision, in one place", () => {
  it("holds the send step on offline only", () => {
    expect(sendWaitsForNetwork("POST", "/drafts/d-1/send", "offline")).toBe(true);
    expect(sendWaitsForNetwork("post", "/drafts/d-1/send", "offline")).toBe(true);
    expect(sendWaitsForNetwork("POST", "/drafts/d-1/send", "online")).toBe(false);
    expect(sendWaitsForNetwork("POST", "/drafts/d-1/send", "unknown")).toBe(false);
    /* The draft is written, Send later records a time, and the rest of the door is untouched. */
    expect(sendWaitsForNetwork("POST", "/drafts", "offline")).toBe(false);
    expect(sendWaitsForNetwork("POST", "/drafts/d-1/schedule", "offline")).toBe(false);
    expect(sendWaitsForNetwork("GET", "/sync", "offline")).toBe(false);
  });

  it("names the waiting sentence off the network door, in the sheet and in the press's answer", () => {
    expect(queuedCaptionKey("offline")).toBe("replyQueuedOffline");
    expect(queuedCaptionKey("online")).toBe("replyQueued");
    expect(COMPOSER).toContain('phase === "queued" ? Copy[queuedCaptionKey(network, accepted)] : Copy.replyUnverified');
    expect(COMPOSER).toContain("const network = useNetworkNow();");
  });

  it("the standalone boot is the one that hands the network door in", () => {
    const boot = PAIRING.slice(PAIRING.indexOf("origin: LOCAL_ENGINE_ORIGIN,"));
    expect(boot.slice(0, boot.indexOf("});")), "the standalone door boots with no network reader").toContain("network: networkNow,");
  });
});
