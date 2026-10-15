/* THE PAGE ONLY THE API ARM SENDS NEVER WAITS ON THE PLANE (LOW-1, LOW-5).
   The storage rule's at-cap reading has its own bound in time and in faulted dials, and past it
   the rule reads partial while `worker_down` still leaves. The route forwards the at-cap reader
   as composed: `null` caps nobody, absent is no reader. */
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { accounts, accountStorage, PARKED_READ_CONCURRENCY } from "@trafficflow/db";
import {
  accountsAtCapOf, makeEntitlementsClient, AT_CAP_READ_BOUND, CALL_FAULT_UNRECORDED,
  type Alert, type AlertSink,
} from "@trafficflow/db/cloud";
import { makeDeps } from "./helpers.js";

const app = createApp(apiRoutes);
const SECRET = "s".repeat(32);
const H = (d: ApiDeps): Promise<Response> => app.handle(
  new Request("http://api.test/internal/alerts", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }),
  { ...d, session: null },
);

function spySink(): AlertSink & { seen: Alert[][]; at: number[] } {
  const seen: Alert[][] = [];
  const at: number[] = [];
  return { name: "spy", seen, at, async notify(alerts) { seen.push([...alerts]); at.push(Date.now()); return true; } };
}

type Plane = "hangs" | "fails";

/** A deployment with `stored` accounts holding mail, and a plane that hangs or refuses at once. */
async function world(stored: number, plane: Plane, onFault: () => void = () => undefined) {
  const { db, deps } = await makeDeps();
  for (let i = 0; i < stored; i++) {
    const [a] = await db.insert(accounts).values({ name: `stored${i}` }).returning();
    await db.insert(accountStorage).values({ accountId: a!.id, bytes: 1_000 + i });
  }
  let asked = 0;
  const client = makeEntitlementsClient({
    baseUrl: "http://plane.invalid", secret: "p".repeat(32),
    fetchImpl: (() => {
      asked += 1;
      return plane === "hangs" ? new Promise(() => {}) : Promise.reject(new Error("connection refused"));
    }) as never,
    // Longer than the bound, so a hanging plane is stopped by the bound and not by the call.
    budgetsMs: { "/v1/access": AT_CAP_READ_BOUND.boundMs * 3 },
    onCallFault: onFault,
  });
  return { deps, client, asked: () => asked };
}

async function pass(deps: ApiDeps, alerts: Partial<NonNullable<ApiDeps["alerts"]>>) {
  const sink = spySink();
  const t0 = Date.now();
  const res = await H({ ...deps, alerts: { secret: SECRET, sinks: [sink], parkedAccounts: null, ...alerts } });
  const body = await res.json() as { unread: Array<{ kind: string; reason: string }> };
  const kinds = sink.seen.flat().map((a) => a.kind);
  return { status: res.status, body, workerDown: kinds.includes("worker_down"), leftAfterMs: (sink.at[0] ?? Infinity) - t0 };
}

describe("the storage rule's own bound", () => {
  it("a plane that never answers: worker_down leaves inside the bound and the storage rule reads partial", async () => {
    const w = await world(120, "hangs");
    const r = await pass(w.deps, { accountsAtCap: accountsAtCapOf(w.client) });
    expect(r.status).toBe(200);
    expect(r.workerDown, "worker_down was sent").toBe(true);
    expect(r.leftAfterMs, "worker_down left inside the storage rule's bound").toBeLessThan(AT_CAP_READ_BOUND.boundMs + 1_500);
    expect(r.body.unread).toContainEqual({ kind: "storage_at_cap", reason: "partial" });
    expect(w.asked(), "one round was dialled, then the bound stopped it").toBeLessThanOrEqual(PARKED_READ_CONCURRENCY);
  }, 20_000);

  it("a plane that refuses at once: fault rows stop at the ceiling (control: unbounded, one per account)", async () => {
    let rows = 0;
    const w = await world(120, "fails", () => { rows += 1; });
    const r = await pass(w.deps, { accountsAtCap: accountsAtCapOf(w.client) });
    expect(r.workerDown).toBe(true);
    expect(r.body.unread).toContainEqual({ kind: "storage_at_cap", reason: "partial" });
    expect(rows, "fault rows per pass").toBeLessThanOrEqual(AT_CAP_READ_BOUND.faultCeiling + PARKED_READ_CONCURRENCY - 1);
    expect(rows).toBeGreaterThan(0);

    let unboundedRows = 0;
    const c = await world(120, "fails", () => { unboundedRows += 1; });
    await pass(c.deps, { accountsAtCap: accountsAtCapOf(c.client, { boundMs: Infinity, faultCeiling: Infinity }) });
    expect(unboundedRows, "without the ceiling every account writes a row").toBe(120);
  }, 30_000);
});

describe("the route forwards the at-cap reader as composed (internal.ts)", () => {
  it("null caps nobody: the storage rule is read and not listed", async () => {
    const { deps } = await makeDeps();
    const r = await pass(deps, { accountsAtCap: null });
    expect(r.status).toBe(200);
    expect(r.body.unread.map((u) => u.kind)).not.toContain("storage_at_cap");
  });

  it("absent is no reader: the storage rule is listed unread, never read as nobody at a cap", async () => {
    const { deps } = await makeDeps();
    const r = await pass(deps, {});
    expect(r.status).toBe(200);
    expect(r.body.unread).toContainEqual({ kind: "storage_at_cap", reason: "no_reader" });
  });

  it("the unread list is a closed pair per rule (control: CALL_FAULT_UNRECORDED composes)", async () => {
    const { deps } = await makeDeps();
    const client = makeEntitlementsClient({
      baseUrl: "http://plane.invalid", secret: "p".repeat(32),
      fetchImpl: (() => Promise.reject(new Error("down"))) as never, onCallFault: CALL_FAULT_UNRECORDED,
    });
    const r = await pass(deps, { accountsAtCap: accountsAtCapOf(client) });
    for (const u of r.body.unread) expect(Object.keys(u).sort()).toEqual(["kind", "reason"]);
  });
});
