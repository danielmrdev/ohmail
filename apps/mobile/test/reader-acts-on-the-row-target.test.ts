import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, ohboxRows, type EngineAdapter, type EngineMessage, type SyncChange, type SyncResponse,
} from "@ohmail/client-engine";
import { createProjector, type ProjectionInputs, type Projected } from "../src/state/world-projection";
import { SCREENING_UNSUPPLIED, liveActions, type WorldActions, type WorldMail } from "../src/state/live";
import { paneRouteFor } from "../src/ui/pane-routes";
import { derivePosture, type PostureInput } from "../src/ui/posture/derive";
import { scaffoldPlan } from "../src/ui/scaffold/plan";
import { withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE PHONE READER SHOWS AND ACTS ON THE MESSAGE ITS OHBOX ROW OPENED, decided once, at the press,
 * through the shipped projector and a real engine. `a1` is from Lena, unread, with a file. The press
 * asks the engine's row (`World.rowOpenTarget`) and hands the answer to the route or the pane; every
 * later mount of that open — the transition frame, the folded route, the unfolded pane, a turned
 * tablet — reads that id. Re-asking the row on a mount moved the reader to our own Sent reply or an
 * older member once Later, Set aside or Junk had taken `a1` out of its row (HIGH).
 * No React Native renderer runs here: the migrations' effects are read in source (the last block).
 */

const AT = Date.UTC(2026, 8, 20, 8, 0, 0);
const ME = { name: "Me", address: "me@example.test" };
const LENA = { name: "Lena", address: "lena@example.test" };

function msg(id: string, atMs: number, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: "T", messageIdHeader: null, subject: "Q3 plan",
    from: LENA, to: [ME], cc: [], date: new Date(atMs).toISOString(), arrivedAt: new Date(atMs).toISOString(),
    folder: "INBOX", snippet: `the words of ${id}`, unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: new Date(atMs).toISOString(), ...over,
  } as EngineMessage;
}
const create = (type: string, id: string, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq: 1, updatedAt: new Date(AT).toISOString(), entity } as SyncChange);

const OURS = { from: ME, to: [LENA], folder: "Sent" as EngineMessage["folder"] };
const laterX2: Record<string, Partial<EngineMessage>> = {
  "our away answer": { ...OURS, autoReplyByUs: true },
  "our calendar acknowledgement": { ...OURS, subject: "Accepted: Q3 plan", itipReplyHeader: true },
  "our own reply": { ...OURS, subject: "Re: Q3 plan" },
  "a stranger's reply held in the Screener": { from: { name: "S", address: "s@elsewhere.test" }, folder: "ohmail/Screener" as EngineMessage["folder"] },
  "a member filed to Junk": { from: { name: "J", address: "j@elsewhere.test" }, folder: "ohmail/Quarantine" as EngineMessage["folder"] },
};
const rowA1 = () => msg("a1", AT, { unread: true, hasAttachments: true, attachmentCount: 1 });

/** Lena is a sender the account decided about, so her mail stands in the Ohbox. */
const consent = (): SyncChange => create("rule", "rule_lena", {
  id: "rule_lena", kind: "sender", match: LENA.address, destination: "INBOX", priority: 0, provenance: "seeded-from-sent",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString(),
});

/** The provider, renderer-free: one engine, one projector, the inputs the app passes. */
async function phone(first: SyncChange[]) {
  let seq = 1000;
  const pages: SyncChange[][] = [[consent(), ...first].map((c) => ({ ...c, seq: seq++ }))];
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: new Date(AT).toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), storePolicy: { mode: "full" } });
  await engine.start();
  const projector = createProjector();
  const inputs = (): ProjectionInputs => ({
    engine, worldKey: "rig", standalone: false, bearer: null, images: "direct" as never, zone: "UTC", locale: "en",
    now: new Date(AT + 3_600_000), foldersOn: false, foldersPending: false, foldersStorable: true, walker: null, searchWalker: null,
    openOffMirror: () => undefined, scopes: {}, leavingWaiting: [], heldDeletes: new Set<string>(), heldPlaces: new Map() as never,
    ownAddresses: [ME.address], posture: SCREENING_UNSUPPLIED, actions: {} as WorldActions, onPresented: () => undefined,
    account: () => ({ name: "rig", email: "" }), setFoldersEnabled: async () => true, folderSummary: async () => null,
    rememberResurfaceTime: () => undefined, signatures: null, resurfaceTime: null, screenerServer: null, relayed: null, mailboxes: null,
  } as unknown as ProjectionInputs);
  const world = (): Projected => projector.project(inputs());
  const actions = liveActions({ engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" });
  return { engine, world, actions };
}

/** The Ohbox row a press on `member`'s conversation is made on: its own id, which is its target. */
function rowOf(w: Projected, member: string): string | null {
  const rows: WorldMail[] = [...w.ohbox.resurfaced, ...w.ohbox.fresh, ...w.ohbox.seen];
  return rows.find((r) => r.id === member || (r.memberIds ?? []).includes(member))?.id ?? null;
}
/** The engine's own row for thread T, as the Ohbox folds it now. */
function threadRow(engine: OhmailEngine): { members: string[]; target: string } | null {
  const row = Object.values(ohboxRows(engine.read())).flat().find((r) => r.members.some((m) => m.threadId === "T"));
  return row ? { members: row.members.map((m) => m.id), target: row.openTarget.id } : null;
}

/** The reader's three verbs that take the opened message out of its row, as the reader calls them. */
const VERBS: Record<string, (p: Awaited<ReturnType<typeof phone>>, w: Projected, id: string) => Promise<unknown>> = {
  Later: (p, _w, id) => p.actions.pileToggle(id, "replyLater"),
  "Set aside": (p, _w, id) => p.actions.pileToggle(id, "setAside"),
  Junk: (p, w, id) => p.actions.move(w.message(id)!, "spam"),
};
const SETUPS: Record<string, () => SyncChange[]> = {
  "our own reply x2 newer than a1": () => [create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, laterX2["our own reply"]))],
  "an older read a0 before a1": () => [create("message", "a0", msg("a0", AT - 3_600_000)), create("message", "a1", rowA1())],
};

/** A press on the Ohbox row holding `member`, as the Ohbox tab makes it: the id the open carries. */
function press(w: Projected, member: string): string {
  const row = rowOf(w, member);
  expect(row, `an Ohbox row holds ${member}`).not.toBeNull();
  return w.rowOpenTarget(row!);
}
/** What a reader mounted at `id` shows and acts on: the message its route or pane names. */
function mount(w: Projected, id: string): string {
  return w.message(id)?.id ?? "(nothing)";
}
/** Every mount an open makes as the window loses or gains its second pane, with the id each carries. */
function remounts(w: Projected, open: string): Record<string, string> {
  const unfold = paneRouteFor(w.message(open)!);
  return {
    "the transition frame as the pane goes": open,
    "the pushed route once folded": open,
    "the pane the route lands in once unfolded": unfold?.params.open ?? open,
  };
}
const shownAt = (w: Projected, ids: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(ids).map(([at, id]) => [at, mount(w, id)]));
const all = (ids: Record<string, string>, id: string): Record<string, string> =>
  Object.fromEntries(Object.keys(ids).map((at) => [at, id]));

describe("a conversation opened from its Ohbox row on the phone", () => {
  for (const [label, over] of Object.entries(laterX2)) {
    it(`with ${label} newer than a1, the press opens a1 and the reader shows and acts on a1`, async () => {
      const p = await phone([create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, over))]);
      const w = p.world();
      const open = press(w, "a1");
      expect(open).toBe("a1");
      expect(mount(w, open)).toBe("a1");
    });
  }

  it("a Resurfaced conversation ending in our own reply: the reader is on the original, and its Done releases the pin", async () => {
    const pinnedAt = new Date(AT + 7_200_000).toISOString();
    const pin = { messageId: "a1", state: "resurfaced", bubbleUpAt: null, setAt: pinnedAt, updatedAt: pinnedAt };
    const p = await phone([
      create("message", "a1", msg("a1", AT, { hasAttachments: true, attachmentCount: 1, triage: pin as never })),
      create("message", "r2", msg("r2", AT + 3_600_000, laterX2["our own reply"])),
    ]);
    const w = p.world();
    expect(w.ohbox.resurfaced.map((r) => r.id), "the Resurfaced row opens at its focus").toEqual(["a1"]);
    const shown = mount(w, press(w, "a1"));
    expect(shown).toBe("a1");
    expect(w.message(shown)?.pile, "Done is offered on what the reader shows").toBe("resurfaced");
    await p.actions.resurfaceDone(shown);
    expect(p.world().ohbox.resurfaced, "Done in the reader left the conversation Resurfaced").toEqual([]);
  });

  it("the open reads a2 and the row's own target moves to the older unread a1: every remount stays on a2", async () => {
    const p = await phone([create("message", "a1", rowA1()), create("message", "a2", msg("a2", AT + 3_600_000, { unread: true }))]);
    const open = press(p.world(), "a2");
    expect(open).toBe("a2");
    await p.actions.openMessage(open);
    expect(threadRow(p.engine)?.target, "the premise: the row's own target moved").toBe("a1");
    const w1 = p.world();
    expect(shownAt(w1, remounts(w1, open))).toEqual(all(remounts(w1, open), "a2"));
  });

  it("the press's answer for a message its row does not hold is the row's own target", async () => {
    const p = await phone([create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, laterX2["our away answer"]))]);
    const w = p.world();
    expect(w.rowOpenTarget("x2")).toBe("a1");
    expect(w.rowOpenTarget("nowhere"), "a message nothing holds answers itself").toBe("nowhere");
  });

  it("a held message answers itself: its place is the gate or Junk, never the row it was threaded into", async () => {
    for (const label of ["a stranger's reply held in the Screener", "a member filed to Junk"]) {
      const p = await phone([create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, laterX2[label]))]);
      expect(p.world().rowOpenTarget("x2"), label).toBe("x2");
    }
  });
});

describe("the shown message is decided once per open: every remount after the row changed shows it", () => {
  for (const [setup, make] of Object.entries(SETUPS)) {
    for (const [verb, act] of Object.entries(VERBS)) {
      it(`${setup}: a press opens a1, ${verb} in the reader, then every mount a fold or an unfold makes`, async () => {
        const p = await phone(make());
        const w0 = p.world();
        const open = press(w0, "a1");
        expect(open).toBe("a1");
        await p.actions.openMessage(open);
        await act(p, w0, open);
        const w1 = p.world();
        const row = threadRow(p.engine);
        expect(row?.members.includes("a1"), "the premise: the verb took a1 out of its row").toBe(false);
        expect(row?.target, "the premise: asked again, the row would open at another member").not.toBe("a1");
        expect(shownAt(w1, remounts(w1, open))).toEqual(all(remounts(w1, open), "a1"));
      });
    }
  }

  it("a small tablet turned across the two-pane threshold: the turn's mounts show a1", async () => {
    const shape = (width: number, height: number): PostureInput =>
      ({ platform: "android", width, height, folds: null, hasFold: false, isPad: false, windowBounds: null });
    const panes = (s: PostureInput) => scaffoldPlan(derivePosture(s), s.platform).panes;
    expect([panes(shape(960, 600)), panes(shape(600, 960))], "the premise: the turn crosses the threshold").toEqual([2, 1]);
    const p = await phone(SETUPS["our own reply x2 newer than a1"]!());
    const w0 = p.world();
    const open = press(w0, "a1");
    await p.actions.openMessage(open);
    await VERBS.Later!(p, w0, open);
    const w1 = p.world();
    expect(shownAt(w1, remounts(w1, open))).toEqual(all(remounts(w1, open), "a1"));
  });
});

describe("an open that is not a row press shows the message it names", () => {
  it("a deep link carrying ?as=conversation shows the linked message", async () => {
    const p = await phone([create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, laterX2["a member filed to Junk"]))]);
    const w = p.world();
    expect(threadRow(p.engine), "the premise: x2's conversation opens at a1, without x2").toEqual({ members: ["a1"], target: "a1" });
    const link = { id: "x2", as: "conversation" };
    expect(mount(w, link.id)).toBe("x2");
    expect(routeParams("app/message/[id].tsx"), "the route reads nothing from the link but its id").toEqual(["id"]);
  });

  it("CONTROL: a search hit or a plain link shows itself", async () => {
    const p = await phone([create("message", "a1", rowA1()), create("message", "x2", msg("x2", AT + 3_600_000, laterX2["a member filed to Junk"]))]);
    const w = p.world();
    expect(mount(w, "x2")).toBe("x2");
    expect(mount(w, "a1")).toBe("a1");
  });
});

/* ── the wiring, read in source: the row is asked at the press, and a link carries only an id ── */
const MOBILE = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string): string => readFileSync(`${MOBILE}${rel}`, "utf8");
function sourcesUnder(dir: string): string[] {
  return (readdirSync(`${MOBILE}${dir}`, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `${dir}/${f}`);
}
/** The params a screen reads from its URL: the keys of every `useLocalSearchParams<{…}>()` it calls. */
function routeParams(rel: string): string[] {
  const src = withoutComments(read(rel));
  const calls = [...src.matchAll(/useLocalSearchParams\s*[<(]/g)].length;
  const typed = [...src.matchAll(/useLocalSearchParams\s*<\s*\{([^}]*)\}\s*>\s*\(/g)];
  expect(typed.length, `${rel}: every useLocalSearchParams call names its params`).toBe(calls);
  return typed.flatMap((m) => [...m[1]!.matchAll(/(\w+)\??\s*:/g)].map((k) => k[1]!));
}

describe("the row is asked at the press and nowhere else", () => {
  it("one call in the screens and the reader: the Ohbox tab's row press", () => {
    const UI = ["app", "src/ui"].flatMap(sourcesUnder);
    expect(UI.length, "the census reads the screens and the reader").toBeGreaterThan(50);
    const asked = UI.flatMap((f) => {
      const n = [...withoutCommentsAndLiterals(read(f)).matchAll(/\b(?:liveR|r)owOpenTarget\s*\(/g)].length;
      return n > 0 ? [[f, n]] : [];
    });
    expect(asked, "a mount, a fold or an unfold that asks the row again moves the reader").toEqual([["app/(tabs)/index.tsx", 1]]);
    expect(withoutCommentsAndLiterals(read("app/(tabs)/index.tsx"))).toMatch(/openRow\(\s*w\.rowOpenTarget\(\s*m\.id\s*\)\s*\)/);
  });

  it("the message route reads only its id; CONTROL: a list reads its own open param", () => {
    expect(routeParams("app/message/[id].tsx")).toEqual(["id"]);
    expect(routeParams("src/ui/list-detail.tsx")).toEqual(["open"]);
  });
});
