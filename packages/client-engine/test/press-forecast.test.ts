import { describe, expect, it } from "vitest";
import {
  OhmailEngine,
  consentPartition,
  pressForecast,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MutationOutcome,
  type PressInput,
  type RuleDTO,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * THE FORECAST IS THE OVERLAY. A press's writes dispatched through `engine.mutate` over an adapter
 * that never answers leave the list placing every row of the subject where the forecast said:
 * the reported shape (a bare rule and a newer subject rule, both News spellings), an address under
 * a higher-priority domain rule, and a domain press over an address's own rule.
 */
const NOW = new Date("2026-09-25T13:00:00.000Z");
const ADDR = "alerts@kestrel.example";
const DOMAIN = "kestrel.example";
const LEGACY = "ohmail/Reads" as unknown as Folder;

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T08:00:00.000Z", updatedAt: "2026-08-01T08:00:00.000Z", ...o,
  } as RuleDTO;
}

function mail(id: string, o: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "Invoice ready", from: { name: "Kestrel", address: ADDR }, to: [], cc: [],
    date: "2026-09-24T12:00:00.000Z", folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-24T12:00:00.000Z", ...o,
  } as EngineMessage;
}

/** An engine over a mirror of these rows whose adapter takes every write and never answers it. */
async function engineOf(rules: RuleDTO[], messages: EngineMessage[]): Promise<OhmailEngine> {
  let served = false;
  const adapter: EngineAdapter = {
    async sync(): Promise<SyncResponse> {
      let seq = 0;
      const creates = served ? [] : [
        ...rules.map((r) => ({ type: "rule" as const, op: "create" as const, id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
        ...messages.map((m) => ({ type: "message" as const, op: "create" as const, id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
      ];
      served = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "9", hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: () => new Promise<MutationOutcome>(() => {}),
    async withdrawSend() { return { outcome: "unsupported" as const }; },
    async fetchBody() { return null; },
  };
  const engine = new OhmailEngine({ adapter, now: () => NOW });
  await engine.start();
  return engine;
}

function inputOf(engine: OhmailEngine, o: Partial<PressInput> & Pick<PressInput, "scope" | "match" | "wanted">): PressInput {
  const reader = engine.verbRead();
  const inScope = (m: EngineMessage) => o.scope === "domain"
    ? m.from.address.toLowerCase().endsWith(`@${o.match}`)
    : m.from.address.toLowerCase() === o.match;
  return {
    reader, options: { now: NOW }, subject: reader.list<EngineMessage>("message").filter(inScope),
    makeRule: true, applyRetro: true, now: NOW, ...o,
  };
}

/** Dispatch the writes and the refiles, and read where the list places each named row. */
function dispatched(engine: OhmailEngine, writes: readonly EngineMutation[], ids: readonly string[]): Map<string, Folder | null> {
  for (const w of writes) void engine.mutate(w).catch(() => null);
  const placeOf = consentPartition(engine.read(), { now: NOW }).placeOf;
  return new Map(ids.map((id) => [id, placeOf.get(id) ?? null]));
}

describe("the reported shape: a bare rule and a newer subject rule for one address", () => {
  for (const spelling of [LEGACY, "ohmail/News" as Folder]) {
    it(`the subject rule (${spelling}) is named with its row, and each answer lands where the list will show it`, async () => {
      const bare = rule({ id: "bare", destination: "INBOX", createdAt: "2026-07-01T08:00:00.000Z" });
      const term = rule({ id: "term", destination: spelling, subjectContains: "[Monitor]" });
      const rows = [mail("plain"), mail("mon", { subject: "[Monitor] disk at 91%", folder: spelling })];

      for (const resolution of ["keep", "remove"] as const) {
        const engine = await engineOf([bare, term], rows);
        const f = pressForecast(inputOf(engine, { scope: "sender", match: ADDR, wanted: "INBOX" }));
        expect(f.groups.map((g) => [g.cause, g.rule.id, g.rows])).toEqual([["term-subject", "term", ["mon"]]]);
        const side = f[resolution];
        expect(side.landing.sort()).toEqual(resolution === "keep" ? ["plain"] : ["mon", "plain"]);
        const seen = dispatched(engine, [...side.writes, ...side.moves], ["plain", "mon"]);
        expect(seen, `${resolution}: the list after the press disagrees with the forecast`).toEqual(side.places);
      }
    });
  }
});

describe("an address under a higher-priority domain rule", () => {
  it("the press is written as the exception, and the list agrees", async () => {
    const wide = rule({ id: "dom-5", kind: "domain", match: DOMAIN, destination: "ohmail/Screened", priority: 5 });
    const engine = await engineOf([wide], [mail("m1")]);
    const f = pressForecast(inputOf(engine, { scope: "sender", match: ADDR, wanted: "INBOX" }));
    expect(f.exception).toMatchObject({ rule: { id: "dom-5" }, priority: 5 });
    expect(f.groups).toEqual([]);
    expect(f.keep.landing).toEqual(["m1"]);
    expect(dispatched(engine, [...f.keep.writes, ...f.keep.moves], ["m1"])).toEqual(f.keep.places);
  });
});

describe("a domain press over an address's own rule", () => {
  it("keeping their own rules leaves that address's mail; changing them brings it", async () => {
    const own = rule({ id: "own", match: "billing@kestrel.example", destination: "ohmail/Receipts" });
    // FILED by its own rule since ARCH-R902: the question exists for mail that rule
    // moved, whose folder the wire carries; the unfiled twin is the next case.
    const rows = [mail("a1"), mail("b1", { from: { name: null, address: "billing@kestrel.example" }, folder: "ohmail/Receipts" })];
    for (const resolution of ["keep", "remove"] as const) {
      const engine = await engineOf([own], rows);
      const f = pressForecast(inputOf(engine, { scope: "domain", match: DOMAIN, wanted: "INBOX" }));
      expect(f.groups.map((g) => [g.cause, g.rule.id, g.rows])).toEqual([["own-rule-inside", "own", ["b1"]]]);
      const side = f[resolution];
      expect(side.landing.sort()).toEqual(resolution === "keep" ? ["a1"] : ["a1", "b1"]);
      expect(dispatched(engine, [...side.writes, ...side.moves], ["a1", "b1"])).toEqual(side.places);
    }
  });

  it("an unfiled row under its own rule is already where the press puts it — nothing to resolve", async () => {
    // INVERTED by ARCH-R902: this row asked the question while its rule presented it in Receipts.
    const own = rule({ id: "own", match: "billing@kestrel.example", destination: "ohmail/Receipts" });
    const rows = [mail("a1"), mail("b1", { from: { name: null, address: "billing@kestrel.example" } })];
    const engine = await engineOf([own], rows);
    const f = pressForecast(inputOf(engine, { scope: "domain", match: DOMAIN, wanted: "INBOX" }));
    expect(f.groups).toEqual([]);
    expect(f.keep.landing.sort()).toEqual(["a1", "b1"]);
    expect(dispatched(engine, [...f.keep.writes, ...f.keep.moves], ["a1", "b1"])).toEqual(f.keep.places);
  });
});

describe("a body-term rule is named and never counted", () => {
  it("the step names it with no rows", async () => {
    const body = rule({ id: "body", destination: "ohmail/Receipts", bodyContains: "invoice" });
    const engine = await engineOf([body], [mail("m1")]);
    const f = pressForecast(inputOf(engine, { scope: "sender", match: ADDR, wanted: "INBOX" }));
    expect(f.groups.map((g) => [g.cause, g.rule.id, g.rows])).toEqual([["term-body", "body", null]]);
    expect(f.remove.writes).toContainEqual({ kind: "rule_delete", ruleId: "body" });
  });
});

describe("a decide under a higher-priority domain rule", () => {
  it("the overlay's promoted rule is lifted as the server writes it, and the list agrees", async () => {
    const wide = rule({ id: "dom-5", kind: "domain", match: DOMAIN, destination: "ohmail/Screened", priority: 5 });
    const engine = await engineOf([wide], [mail("h1", { folder: "ohmail/Screener", unread: true })]);
    void engine.mutate({ kind: "screener_decide", senderId: "h1", decision: "yes", scope: "sender", dest: "ohbox", applyRetro: true }).catch(() => null);
    const promoted = engine.read().list<RuleDTO>("rule").find((r) => r.provenance === "promoted");
    expect(promoted?.priority, "the overlay promoted the rule below the domain rule").toBe(5);
    expect(consentPartition(engine.read(), { now: NOW }).placeOf.get("h1")).toBe("INBOX");
  });
});
