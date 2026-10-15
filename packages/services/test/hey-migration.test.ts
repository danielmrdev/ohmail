import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { rules, changeLog, auditLog } from "@trafficflow/db";
import {
  effectForDestination, evaluateRules, scanFoldersForMigration, defaultFolderMapper,
  type Rule, type NormalizedMessage, type MigrationObservation, type FolderScanner,
} from "@trafficflow/core";
import { HeyMigrationService } from "../src/index.js";
import { makeCtx, seedMessage, FakeAdapter, changesFor } from "./helpers.js";

const OBS: MigrationObservation[] = [
  { senderOrDomain: "alice@work.example", kind: "sender", destination: "INBOX" },
  { senderOrDomain: "news.example", kind: "domain", destination: "ohmail/News" },
  { senderOrDomain: "shop@store.example", kind: "sender", destination: "ohmail/Receipts" },
];

async function migratedRules(db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string) {
  return db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.provenance, "migrated")));
}

/** Load all account rules as core `Rule[]` for evaluateRules. */
async function loadRules(db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string): Promise<Rule[]> {
  const rows = await db.select().from(rules).where(eq(rules.accountId, accountId));
  return rows.map((r) => {
    const destination = r.destination as Rule["destination"];
    return {
      id: r.id, kind: r.kind as Rule["kind"], match: r.match, destination,
      // Same derivation the real adapter applies (`drizzle-repo.ts#listRules`) — a fixture that
      // built `effect` some other way would be testing a rule shape production never produces.
      effect: effectForDestination(destination),
      priority: r.priority,
      provenance: r.provenance as Rule["provenance"], enabled: r.enabled,
    };
  });
}

function msgFrom(address: string): NormalizedMessage {
  return {
    canonical: { messageIdHeader: "m@x", bodyHash: "h" },
    subject: "s", from: { name: null, address }, to: [], date: null,
    headers: {}, textBody: "", htmlBody: null, hasAttachments: false,
  };
}

describe("HeyMigrationService — migrateFromObservations (idempotent, reversible)", () => {
  it("first run seeds one migrated rule per observation + change_log creates + audit", async () => {
    const { db, accountId, ctx } = await makeCtx();
    const svc = new HeyMigrationService();

    const res = await svc.migrateFromObservations(ctx, { observations: OBS });
    expect(res.created).toBe(3);
    expect(res.unchanged).toBe(0);
    expect(res.ruleIds).toHaveLength(3);

    const rows = await migratedRules(db, accountId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.provenance === "migrated" && r.enabled)).toBe(true);
    expect(rows.find((r) => r.match === "alice@work.example")).toMatchObject({ kind: "sender", destination: "INBOX" });
    expect(rows.find((r) => r.match === "news.example")).toMatchObject({ kind: "domain", destination: "ohmail/News" });

    // change_log: three rule creates.
    const changes = await changesFor(db, accountId);
    const ruleCreates = changes.filter((c) => c.entityType === "rule" && c.op === "create");
    expect(ruleCreates).toHaveLength(3);

    // audit_log with inverse (reversibility).
    const audits = await db.select().from(auditLog).where(eq(auditLog.accountId, accountId));
    expect(audits.some((a) => a.action === "hey_migrate")).toBe(true);
  });

  it("re-run with the SAME observations creates ZERO duplicates (idempotent)", async () => {
    const { db, accountId, ctx } = await makeCtx();
    const svc = new HeyMigrationService();

    const first = await svc.migrateFromObservations(ctx, { observations: OBS });
    const second = await svc.migrateFromObservations(ctx, { observations: OBS });

    expect(first.created).toBe(3);
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(3);
    // Same rule ids returned both runs.
    expect(new Set(second.ruleIds)).toEqual(new Set(first.ruleIds));

    // Exactly three migrated rules total — no duplicates.
    const rows = await migratedRules(db, accountId);
    expect(rows).toHaveLength(3);

    // No new rule-create change_log rows on the second run.
    const changes = await changesFor(db, accountId);
    expect(changes.filter((c) => c.entityType === "rule" && c.op === "create")).toHaveLength(3);
  });

  it("migrated rules are picked up by evaluateRules (sender + domain route to migrated destination)", async () => {
    const { db, accountId, ctx } = await makeCtx();
    await new HeyMigrationService().migrateFromObservations(ctx, { observations: OBS });

    const ruleset = await loadRules(db, accountId);
    // Known senders empty so the deterministic rule (not the screener fallback) is exercised.
    const known = new Set<string>(["alice@work.example", "shop@store.example", "bob@news.example"]);

    // `auth` is required and unread in that change slice 1 — see `rules.ts#AuthVerdict`.
    const decide = (address: string) =>
      evaluateRules({
        msg: msgFrom(address), rules: ruleset, ownAddresses: new Set<string>(), knownSenders: { addresses: known, inferred: new Set<string>(), lists: new Map() }, auth: "unauthenticated", identity: null,
      }).destination;

    expect(decide("alice@work.example")).toBe("INBOX");
    expect(decide("shop@store.example")).toBe("ohmail/Receipts");
    // Domain rule matches any sender @news.example.
    expect(decide("bob@news.example")).toBe("ohmail/News");
  });

  it("undoMigration removes ONLY provenance='migrated' rules (manual/promoted intact)", async () => {
    const { db, accountId, ctx } = await makeCtx();
    const svc = new HeyMigrationService();

    // A manual + a promoted rule that must survive the undo.
    await db.insert(rules).values([
      { accountId, kind: "sender", match: "manual@x.example", destination: "INBOX", provenance: "manual" },
      { accountId, kind: "domain", match: "promoted.com", destination: "ohmail/News", provenance: "promoted" },
    ]);
    await svc.migrateFromObservations(ctx, { observations: OBS });
    expect(await migratedRules(db, accountId)).toHaveLength(3);

    const undo = await svc.undoMigration(ctx);
    expect(undo.removed).toBe(3);
    expect(await migratedRules(db, accountId)).toHaveLength(0);

    // Manual + promoted survive.
    const survivors = await db.select().from(rules).where(eq(rules.accountId, accountId));
    expect(survivors.map((r) => r.provenance).sort()).toEqual(["manual", "promoted"]);

    // change_log delete emitted per removed migrated rule.
    const changes = await changesFor(db, accountId);
    expect(changes.filter((c) => c.entityType === "rule" && c.op === "delete")).toHaveLength(3);
  });

  it("rules-only by default: no live folders are touched (adapter never moves)", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await seedMessage(db, accountId, mailboxId, { from: "alice@work.example", folder: "ohmail/News", desired: "ohmail/News" });
    const adapter = new FakeAdapter();
    const svc = new HeyMigrationService({ adapter });

    const res = await svc.migrateFromObservations(ctx, { mailboxId, observations: OBS });
    expect(res.rerouted).toBe(0);
    expect(adapter.moves).toHaveLength(0);   // default is rules-only — never thrash
  });

  it("opt-in reroute moves out-of-place mail via the reconciler, idempotently (bounded moves)", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    // alice's mail is currently in Feed but the migrated rule wants it in INBOX → one move.
    await seedMessage(db, accountId, mailboxId, { from: "alice@work.example", folder: "ohmail/News", desired: "ohmail/News" });
    // shop's mail is already in Receipts (its migrated destination) → NO move.
    await seedMessage(db, accountId, mailboxId, { from: "shop@store.example", folder: "ohmail/Receipts", desired: "ohmail/Receipts" });
    const adapter = new FakeAdapter();
    const svc = new HeyMigrationService({ adapter });

    const res = await svc.migrateFromObservations(ctx, { mailboxId, observations: OBS }, { reroute: true });
    expect(res.rerouted).toBe(1);
    expect(adapter.moves).toEqual([{ from: "ohmail/News", to: "INBOX" }]);

    // Re-running the reroute is idempotent: alice is now in INBOX → no further move.
    const adapter2 = new FakeAdapter();
    const res2 = await new HeyMigrationService({ adapter: adapter2 })
      .migrateFromObservations(ctx, { mailboxId, observations: OBS }, { reroute: true });
    expect(res2.rerouted).toBe(0);
    expect(adapter2.moves).toHaveLength(0);
  });
});

describe("HeyMigrationService — folder-scan observation source", () => {
  // Deterministic in-memory FolderScanner: real server folders + sampled senders.
  const mockScanner: FolderScanner = {
    async listFolders() {
      return [
        "INBOX",
        "Newsletters",
        "Receipts",
        "Work",                       // unrecognized user folder → skipped
        "ohmail/Screener",       // our management folder → skipped
        "ohmail/News",           // our management folder → skipped
        "Sent",                       // plumbing → skipped
      ];
    },
    async sampleSenders(folder) {
      switch (folder) {
        case "INBOX": return ["alice@work.example", "boss@work.example"];
        case "Newsletters": return ["digest@news.example", "alice@work.example"]; // alice also here → INBOX wins
        case "Receipts": return ["orders@store.example"];
        case "Work": return ["ignored@nowhere-com.example"];
        case "ohmail/Screener": return ["screener-should-be-skipped@x.example"];
        case "ohmail/News": return ["tf-feed-skipped@x.example"];
        case "Sent": return ["me@lichtgrat.example"];
        default: return [];
      }
    },
  };

  it("scan maps real folders → canonical destinations, skips ohmail/* + plumbing", async () => {
    const obs = await scanFoldersForMigration(mockScanner);
    const byMatch = new Map(obs.map((o) => [o.senderOrDomain, o]));

    // INBOX senders → INBOX (approved). alice appears in both INBOX and Newsletters → INBOX wins.
    expect(byMatch.get("alice@work.example")).toMatchObject({ destination: "INBOX", kind: "sender" });
    expect(byMatch.get("boss@work.example")).toMatchObject({ destination: "INBOX" });
    // The user's own `Newsletters` folder → ohmail/News; their `Receipts` → ohmail/Receipts.
    expect(byMatch.get("digest@news.example")).toMatchObject({ destination: "ohmail/News" });
    expect(byMatch.get("orders@store.example")).toMatchObject({ destination: "ohmail/Receipts" });
    // Unrecognized + ohmail/* + Sent are skipped.
    expect(byMatch.has("ignored@nowhere-com.example")).toBe(false);
    expect(byMatch.has("screener-should-be-skipped@x.example")).toBe(false);
    expect(byMatch.has("tf-feed-skipped@x.example")).toBe(false);
    expect(byMatch.has("me@lichtgrat.example")).toBe(false);
  });

  it("scanned observations flow through migrateFromObservations into migrated rules", async () => {
    const { db, accountId, ctx } = await makeCtx();
    const svc = new HeyMigrationService();
    const obs = await svc.scanFolders(mockScanner);

    const res = await svc.migrateFromObservations(ctx, { observations: obs });
    expect(res.created).toBe(obs.length);

    const rows = await migratedRules(db, accountId);
    const map = new Map(rows.map((r) => [r.match, r.destination]));
    expect(map.get("alice@work.example")).toBe("INBOX");
    expect(map.get("digest@news.example")).toBe("ohmail/News");
    expect(map.get("orders@store.example")).toBe("ohmail/Receipts");
  });

  it("defaultFolderMapper skips ohmail/* and maps by keyword", () => {
    expect(defaultFolderMapper("INBOX")).toBe("INBOX");
    expect(defaultFolderMapper("ohmail/Screener")).toBeNull();
    expect(defaultFolderMapper("ohmail/Quarantine")).toBeNull();
    expect(defaultFolderMapper("Newsletters")).toBe("ohmail/News");
    expect(defaultFolderMapper("Receipts")).toBe("ohmail/Receipts");
    expect(defaultFolderMapper("Junk")).toBe("ohmail/Quarantine");
    expect(defaultFolderMapper("Sent")).toBeNull();
    expect(defaultFolderMapper("Random Project")).toBeNull();
  });
});
