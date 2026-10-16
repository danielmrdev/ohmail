import {
  CLAIM_PROTOCOL, formatAck, formatClaim, formatRequest, runLeaseGate,
  type LeaseGateResult, type LeaseIo, type LeaseSelf, type TakeoverAuthorization,
} from "../../src/adapters/organizer-lease.js";
import { formatProfileMessage, makeProfileDoc } from "../../src/adapters/organizer-profile.js";

/**
 * The folder the blind-search ruling is written against (ARCH-LEASE-BLIND-SEARCH §5): a live
 * incumbent's claim at the lowest uid, under more records of every other kind than a newest-first
 * window holds, so the window cannot see it. One list of raw records, seeded in order by the in-process double
 * and appended in order by the real-server witness.
 */

export const LEASE_NOW = new Date("2026-09-28T12:00:00.000Z");
export const INCUMBENT = "install-a";
export const INCUMBENT_NONCE = "nonce-a";
export const FIXTURE_KEY = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";
export const FIXTURE_MAILBOX = "22222222-2222-4222-8222-222222222222";

export interface FixtureRecord {
  raw: string;
  internalDate: Date;
  kind: "claim" | "settings" | "ack" | "request" | "stray";
}

const hex12 = (i: number): string => i.toString(16).padStart(12, "0");

/** A claim as any install writes it. */
export function claimRaw(o: {
  installId: string; heartbeat: Date; nonce: string;
  claimedAt?: Date; authorizedAt?: Date | null; intent?: "join" | "takeover"; protocol?: number;
  kind?: "local" | "cloud" | "mobile";
}): string {
  return formatClaim({
    installId: o.installId, kind: o.kind ?? "local", displayName: `${o.installId} machine`,
    heartbeat: o.heartbeat, claimedAt: o.claimedAt ?? o.heartbeat, nonce: o.nonce,
    authorizedAt: o.authorizedAt ?? null, capabilities: ["requests"],
    protocol: o.protocol ?? CLAIM_PROTOCOL, ...(o.intent === undefined ? {} : { intent: o.intent }),
  });
}

/** The incumbent's live claim: renewed five seconds ago, tenure an hour old, pressed an hour ago. */
export function incumbentRaw(now: Date = LEASE_NOW): string {
  return claimRaw({
    installId: INCUMBENT, heartbeat: new Date(now.getTime() - 5_000), nonce: INCUMBENT_NONCE,
    claimedAt: new Date(now.getTime() - 3_600_000), authorizedAt: new Date(now.getTime() - 3_600_000),
  });
}

export function settingsRaw(i: number, installId: string, at: Date): string {
  const doc = makeProfileDoc(
    { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [`tag-${i}`], signature: null },
    { updatedAt: at, producer: { kind: "desktop", version: "fixture" } },
  );
  return formatProfileMessage(doc, { installId });
}

/**
 * The ruling's folder, in the ruling's order: A's live claim FIRST; settings copies from two install
 * ids; acks, most of them past the sweep's life; requests; strays, one carrying the
 * lease discriminator in its BODY only.
 */
export function foreign600(now: Date = LEASE_NOW): FixtureRecord[] {
  const out: FixtureRecord[] = [];
  const back = (ms: number): Date => new Date(now.getTime() - ms);
  out.push({ raw: incumbentRaw(now), internalDate: back(5_000), kind: "claim" });
  for (let i = 0; i < 300; i++) {
    const at = back(86_400_000 - i * 60_000);
    out.push({ raw: settingsRaw(i, i % 2 === 0 ? INCUMBENT : "install-c", at), internalDate: at, kind: "settings" });
  }
  for (let i = 0; i < 150; i++) {
    const stale = i < 100;
    out.push({
      raw: formatAck({
        requestId: `00000000-0000-4000-8000-${hex12(i)}`, mailboxId: FIXTURE_MAILBOX, outcome: "applied",
        ackedAt: stale ? back(72 * 3_600_000) : back(60_000), key: FIXTURE_KEY,
      }),
      internalDate: stale ? back(72 * 3_600_000) : back(60_000),
      kind: "ack",
    });
  }
  for (let i = 0; i < 100; i++) {
    out.push({
      raw: formatRequest({
        requestId: `11111111-1111-4111-8111-${hex12(i)}`, kind: "screener.decide", mailboxId: FIXTURE_MAILBOX,
        installId: "install-r", organizerKind: "cloud", decidedAt: back(600_000),
        payload: { scope: "sender", decision: "yes", address: `sender-${i}@example.com` }, key: FIXTURE_KEY,
      }),
      internalDate: back(600_000),
      kind: "request",
    });
  }
  for (let i = 0; i < 50; i++) {
    const body = i === 0 ? "X-Ohmail-Lease: 1\r\nX-Ohmail-Install-Id: body-only\r\n" : `note ${i}`;
    out.push({ raw: `Subject: a stray ${i}\r\nDate: ${back(7_200_000).toUTCString()}\r\n\r\n${body}\r\n`, internalDate: back(7_200_000), kind: "stray" });
  }
  return out;
}

/** The gate as a host runs it, answering in one word so a failed case prints no live handle. */
export async function gateOutcome(o: {
  io: LeaseIo; self: LeaseSelf; now?: Date; takeover?: TakeoverAuthorization | null; nonce?: string;
  residue?: "remove" | "count";
  log?: (event: string, detail: Record<string, unknown>) => void;
}): Promise<{ word: string; result: LeaseGateResult | null; error: unknown }> {
  try {
    const result = await runLeaseGate({
      io: o.io, self: o.self, now: o.now ?? LEASE_NOW, capabilities: ["requests"],
      newNonce: () => o.nonce ?? "nonce-new",
      ...(o.takeover !== undefined ? { takeover: o.takeover } : {}),
      ...(o.residue !== undefined ? { residue: o.residue } : {}),
      ...(o.log !== undefined ? { log: o.log } : {}),
    } as Parameters<typeof runLeaseGate>[0]);
    const v = result.verdict;
    const by = v.verdict === "organize" ? "" : `:${v.by?.installId ?? "nobody"}`;
    return { word: `${v.verdict}${by}`, result, error: null };
  } catch (err) {
    const e = err as { name?: string; op?: string };
    return { word: `${e.name ?? "Error"}:${e.op ?? "?"}`, result: null, error: err };
  }
}
