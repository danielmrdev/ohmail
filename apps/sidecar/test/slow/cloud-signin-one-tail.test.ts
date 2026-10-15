import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "../fixtures/hosted-mailbox.js";
import { freshDataDir } from "../_datadir.js";

/**
 * ONE SIGN-IN AT A TIME ON ONE DATA DIRECTORY. A code sign-in pressed while a browser-approval
 * claim is still on the wire used to run beside it, both writing the seal, and on an addressed door
 * both activating a mirror. The presses queue now (`serialTail`): the second waits, then starts from
 * the first one's outcome, refused before it dials on an addressed door and meeting the adopted
 * account on the pending one. Both orders run on both doors; the controls sign in alone.
 */

const BASE = "https://cloud.test";
const ID = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

interface Wire {
  fetchImpl: typeof fetch;
  dialled: string[];
  /** Hold the named hosted route until `release` is called. */
  hold: (path: string) => void;
  release: (path: string) => void;
}

function hostedCloud(): Wire {
  const dialled: string[] = [];
  const held = new Map<string, { wait: Promise<void>; open: () => void }>();
  const tokens = (tag: string) => json({ tokens: { accessToken: `${tag}-access`, refreshToken: `${tag}-refresh` } });
  const fetchImpl = (async (input: string): Promise<Response> => {
    const path = new URL(input).pathname;
    dialled.push(path);
    await held.get(path)?.wait;
    if (path === "/auth/desktop-approval") return json({ approvalId: ID, expiresIn: 300 });
    if (path === "/auth/desktop-approval/claim") return tokens("approved");
    if (path === "/auth/desktop-claim") return tokens("coded");
    if (path === "/auth/session") return json({ user: { email: "me@ohmail.test" }, scope: "full" });
    if (path === "/mailboxes") return json(mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
    if (path === "/sync") return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: new Date().toISOString() });
    if (path === "/messages/bodies") return json({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl, dialled,
    hold: (path) => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); held.set(path, { wait, open }); },
    release: (path) => { held.get(path)?.open(); held.delete(path); },
  };
}

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function engine(wire: Wire, door: "pending" | "addressed"): Promise<CloudSidecar> {
  const dataDir = await freshDataDir("ohmail-one-tail-");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-one-tail-root-"));
  dirs.push(dataDir, root);
  const s = await createCloudSidecar({
    dataDir, cloudUrl: BASE, handoffBase: BASE, keks: { 1: Buffer.alloc(32, 7) },
    fetchImpl: wire.fetchImpl, pollIntervalMs: 3_600_000,
    ...(door === "pending"
      ? { address: null, identityPending: { doorFile: join(root, "config.json") } }
      : { address: "me@ohmail.test" }),
  });
  sidecars.push(s);
  return s;
}

const call = (s: CloudSidecar, body: unknown, path = "/cloud/signin"): Promise<Response> =>
  s.handle(new Request(`http://sidecar${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
const codeOf = async (res: Response): Promise<string | null> =>
  ((await res.clone().json()) as { error?: { code?: string } }).error?.code ?? null;

async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(ok(), what).toBe(true);
}

for (const door of ["pending", "addressed"] as const) {
  describe(`${door} door: a code sign-in and an approval claim do not interleave`, () => {
    /** What the queued second press answers once the first is done: each door's own contract. */
    async function expectSecond(second: Response, wire: Wire, firstPath: string, secondPath: string): Promise<void> {
      if (door === "addressed") {
        expect(`${second.status} ${await codeOf(second)}`).toBe("409 already_signed_in");
        expect(wire.dialled, "the refused press spent its credential anyway").not.toContain(secondPath);
      } else {
        expect(second.status, "the pending door refused the adopted account's own second press").toBe(200);
        expect(wire.dialled.indexOf(secondPath), "the second press dialled before the first answered")
          .toBeGreaterThan(wire.dialled.indexOf(firstPath));
      }
    }

    it("the code press during an in-flight claim waits for it, never runs beside it", async () => {
      const wire = hostedCloud();
      const s = await engine(wire, door);
      expect((await call(s, {}, "/cloud/signin/approval")).status).toBe(200);
      wire.hold("/auth/desktop-approval/claim");
      const claim = call(s, { approval: true });
      await until("the claim to reach the hosted service", () => wire.dialled.includes("/auth/desktop-approval/claim"));
      const code = call(s, { handoffCode: "ABCD-EFGH" });
      await new Promise((r) => setTimeout(r, 50));
      expect(wire.dialled, "the code sign-in ran beside the claim").not.toContain("/auth/desktop-claim");
      wire.release("/auth/desktop-approval/claim");
      expect((await claim).status).toBe(200);
      await expectSecond(await code, wire, "/auth/desktop-approval/claim", "/auth/desktop-claim");
    }, 30_000);

    it("the other order: a claim pressed during an in-flight code sign-in waits for it too", async () => {
      const wire = hostedCloud();
      const s = await engine(wire, door);
      expect((await call(s, {}, "/cloud/signin/approval")).status).toBe(200);
      wire.hold("/auth/desktop-claim");
      const code = call(s, { handoffCode: "ABCD-EFGH" });
      await until("the code to reach the hosted service", () => wire.dialled.includes("/auth/desktop-claim"));
      const claim = call(s, { approval: true });
      await new Promise((r) => setTimeout(r, 50));
      expect(wire.dialled, "the claim ran beside the code sign-in").not.toContain("/auth/desktop-approval/claim");
      wire.release("/auth/desktop-claim");
      expect((await code).status).toBe(200);
      await expectSecond(await claim, wire, "/auth/desktop-claim", "/auth/desktop-approval/claim");
    }, 30_000);

    it("control: a code sign-in alone signs in", async () => {
      const wire = hostedCloud();
      const s = await engine(wire, door);
      const res = await call(s, { handoffCode: "ABCD-EFGH" });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(wire.dialled.filter((p) => p === "/auth/desktop-claim")).toHaveLength(1);
    }, 30_000);
  });
}

describe("addressed door: a pairing redeem pressed during a sign-in waits for it", () => {
  it("is refused once the sign-in finishes, without spending the pairing code", async () => {
    const wire = hostedCloud();
    const s = await engine(wire, "addressed");
    wire.hold("/auth/desktop-claim");
    const code = call(s, { handoffCode: "ABCD-EFGH" });
    await until("the code to reach the hosted service", () => wire.dialled.includes("/auth/desktop-claim"));
    const redeem = call(s, { token: "PAIR-CODE-" + "0001" }, "/cloud/pair-redeem");
    await new Promise((r) => setTimeout(r, 50));
    wire.release("/auth/desktop-claim");
    expect((await code).status).toBe(200);
    const second = await redeem;
    expect(`${second.status} ${await codeOf(second)}`).toBe("409 already_signed_in");
    expect(wire.dialled, "the redeem ran beside the sign-in and spent its code").not.toContain("/pair/redeem");
  }, 30_000);
});
