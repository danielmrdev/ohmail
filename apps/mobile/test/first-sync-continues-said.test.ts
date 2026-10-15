import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { firstSyncContinuesSaid, topLineSaid } from "../src/state/live";
import { readMailboxes } from "../src/net/mailboxes";
import type { ConnectedSession } from "../src/net/pairing";

/**
 * ═══ WHERE A BUDGETED FIRST SYNC IS CONTINUING — the phone's half of one sentence ═══════════
 *
 * A first sync of a mailbox with many large-first folders runs in bounded passes and pauses
 * between them. The pass writes the folder its byte budget stopped at into `mailbox_folders`
 * (mail 0115) and `MailboxDTO.firstSyncStopFolder` carries it, so the sentence survives the
 * restart it is about — a verdict read from an engine's memory would not.
 *
 * The browser's twin is `mail-state.ts#continuesAtFolder`, rendered by `SyncBar` beside its
 * count; the rule is the same and stated once in each place: exactly one mailbox may name a
 * folder, because the sentence has no room to say whose it is. The strings' equality with the
 * catalogues is `copy-parity.test.ts`'s job; this file drives the derivation and the render gate.
 */

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(at(p), "utf8");

/** A session whose one read answers this body — `junk-folder-said.test.ts`'s own double. */
function sessionAnswering(body: unknown): ConnectedSession {
  return {
    profile: { origin: "https://server.test" },
    fetch: () =>
      Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      })),
  } as unknown as ConnectedSession;
}

describe("firstSyncContinuesSaid — which sentence the phone's chrome is owed", () => {
  it("names the folder when exactly one mailbox says where it stopped", () => {
    expect(firstSyncContinuesSaid([{ firstSyncStopFolder: "Archive/2019" }]))
      .toBe("First sync continues at Archive/2019");
  });

  it("names none when two mailboxes name different folders", () => {
    // Two accounts mid-first-sync: the sentence cannot say whose folder it is, so it says nothing.
    expect(firstSyncContinuesSaid([
      { firstSyncStopFolder: "Archive/2019" },
      { firstSyncStopFolder: "Lists" },
    ])).toBeNull();
  });

  it("says nothing for no stop, an empty roster, or a server that cannot say", () => {
    expect(firstSyncContinuesSaid([{ firstSyncStopFolder: null }])).toBeNull();
    expect(firstSyncContinuesSaid([{}])).toBeNull();
    expect(firstSyncContinuesSaid([])).toBeNull();
  });

  it("an empty string is not a folder name, and an older server sends neither", async () => {
    const rows = await readMailboxes(sessionAnswering({
      items: [
        { id: "mb1", address: "a@x.test", firstSyncStopFolder: "" },
        { id: "mb2", address: "b@x.test" },
      ],
    }));
    expect(rows?.map((r) => r.firstSyncStopFolder)).toEqual([null, null]);
    expect(firstSyncContinuesSaid(rows ?? [])).toBeNull();
  });

  it("reads the wire field through, so the sentence is the SERVER's stop", async () => {
    const rows = await readMailboxes(sessionAnswering({
      items: [{ id: "mb1", address: "a@x.test", firstSyncStopFolder: "Archive/2019" }],
    }));
    expect(firstSyncContinuesSaid(rows ?? [])).toBe("First sync continues at Archive/2019");
  });

  it("is German in German", () => {
    expect(DE.firstSyncContinuesAt("Archiv")).toBe("Erste Synchronisierung läuft bei Archiv weiter");
    expect(EN.firstSyncContinuesAt("Archive")).toBe("First sync continues at Archive");
    expect(Copy.firstSyncContinuesAt("Archive")).toBe("First sync continues at Archive");
  });
});

/* ──────────────────────────────────────────────────── the surface, at its own source */

describe("the chrome renders it, gated, and under the freshness label", () => {
  const chrome = read("../src/ui/chrome.tsx");

  it("is derived from the mailbox ROWS, never from a door verdict", () => {
    expect(chrome).toContain("firstSyncContinuesSaid(world.mailboxes.rows)");
  });

  /* The TopBar renders the one line `live.ts#topLineSaid` ranks, so the gate and the order are
     asked of that function, and the bar is asked only to hand it the rows and render its line. */
  const quiet = { network: "online", connection: null, stale: null, draining: false } as const;
  const here = "First sync continues at Archive/2019";

  it("renders only when there is something to say", () => {
    expect(topLineSaid({ ...quiet, continuing: null })).toBeNull();
    expect(topLineSaid({ ...quiet, continuing: here })?.text).toBe(here);
    expect(chrome).toMatch(/continuing: firstSyncContinuesSaid\(world\.mailboxes\.rows\),/);
    expect(chrome).toContain("{line.text}");
  });

  it("ranks under the outage line and the freshness label, as the browser ladder does", () => {
    // A stale mirror is the larger fact — `mail-state.ts` puts its `stale` arm above `importing`
    // for the same reason — and an outage explains both.
    expect(topLineSaid({ ...quiet, continuing: here, stale: "Fri 09:00" })?.text).toBe(Copy.staleAsOfIdle("Fri 09:00"));
    expect(topLineSaid({ ...quiet, continuing: here, stale: "Fri 09:00", connection: { kind: "lost" } })?.text)
      .toBe(Copy.connectionLost);
  });
});
