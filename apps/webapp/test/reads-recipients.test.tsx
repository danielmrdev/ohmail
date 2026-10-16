/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, MessageBody, FeedPartition, TagDTO } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { KeymapProvider } from "../app/shell/keymap";
import { MessageRecipients } from "../app/shell/MessageRecipients";
import { ReadsView } from "../app/views/ReadsView";

/**
 * ═══ A READS CARD SAYS WHO ELSE GOT THE MESSAGE ════════════════════════════════════════════
 *
 * The Reads header used to be sender and time and nothing else, so a message that went to
 * eleven people looked exactly like one written to you. It now wears the READING PANE'S OWN
 * recipients block — `MessageRecipients`, the component `MessageCard` was carrying inline —
 * capped, with the remainder folded behind the disclosure that block already had.
 *
 * Four ways this ships wrong, and one test each:
 *
 *  · **A second spelling.** The obvious implementation is a small `To: …` line written into
 *    `StreamCard`, which is a copy of the pane's block that drifts from it the first time
 *    either changes. The source census below is what makes "one component" checkable rather
 *    than merely intended.
 *  · **A line that never says anything.** Drawing the block on every card puts "To: you" under
 *    every subject in the stream. The item asks that a message with SEVERAL recipients say so,
 *    so a one-recipient card must be the header it always was — asserted as an ABSENCE, which
 *    is the assertion nobody writes and the reason this regresses quietly.
 *  · **A "+0 more".** A cap of two over a message with exactly two recipients must not fold:
 *    an off-by-one here reads as a control that hides nothing and is pressable anyway.
 *  · **The press that also moves the surface underneath it.** A stream card selects AND expands
 *    on any click it receives (`StreamCard.expandOnClick`), which the reading pane has no
 *    equivalent of. A chip that does not stop its own press opens a popover and re-lays out the
 *    card under it in the same tick — a defect that exists only on the new host, so no existing
 *    test could have seen it.
 */

const ISO = "2026-08-04T09:00:00.000Z";
const tags: TagDTO[] = [];

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Addr {
  name: string | null;
  address: string;
}

/** The same message with the two OPTIONAL disclosure fields varied — both are wire-optional. */
const without = (m: EngineMessage, drop: { date?: boolean; folder?: boolean }): EngineMessage => {
  const o = { ...(m as unknown as Record<string, unknown>) };
  if (drop.date) o.date = null;
  if (drop.folder) delete o.physicalFolder;
  return o as unknown as EngineMessage;
};

const message = (to: Addr[], cc: Addr[] = []): EngineMessage =>
  ({
    id: "m1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "The weekly note", from: { name: "Ida Vogt", address: "ida@x.invalid" },
    to, cc, date: ISO, folder: "INBOX", physicalFolder: "INBOX",
    snippet: "the opening line of the issue",
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

const body = (m: EngineMessage): MessageBody =>
  ({ text: m.snippet, state: "snippet", html: null, loadedRemoteContent: false,
     unsubscribe: "no_header", unsubscribeUrl: null } as unknown as MessageBody);

/** A webapp file, whether the suite runs from the repo root or from `apps/webapp`. */
function repoFile(rel: string): string {
  const path = [resolve(process.cwd(), rel), resolve(process.cwd(), "apps/webapp", rel)].find(existsSync);
  expect(path, `could not find ${rel} from ${process.cwd()}`).toBeTruthy();
  return path!;
}

let roots: Root[] = [];
let host: HTMLElement | null = null;

async function mountReads(m: EngineMessage, locale: "en" | "de" = "en"): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const partition: FeedPartition = { waterline: null, fresh: [m], seen: [], newCount: 0 };
  await act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === "de" ? de : en} now={new Date(ISO)} timeZone="UTC">
        <KeymapProvider>
          <ReadsView settled owed={false}
            partition={partition} tags={tags} now={new Date(ISO)} cur={null} onCur={() => {}}
            aiChip={null} chipState={null} onChipState={() => {}} markSeen={() => {}}
            bodyOf={body} hydrateBody={() => {}} jumpTo={null} onJumped={() => {}}
            onAction={() => {}}
          />
        </KeymapProvider>
      </NextIntlClientProvider>,
    );
  });
}

/**
 * THE BLOCK ON ITS OWN, at any cap.
 *
 * The card mounts it at `CARD_RECIPIENT_CHIPS` and the pane at none, so the boundary values a
 * `number` admits — negative, zero, fractional — are unreachable through either surface. They
 * are still type-valid, and `slice` treats a negative as "from the end", so the component is
 * asked directly rather than through a mount that cannot express the question.
 */
async function mountRaw(m: EngineMessage, max: number, locale: "en" | "de" = "en"): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === "de" ? de : en} now={new Date(ISO)} timeZone="UTC">
        <MessageRecipients message={m} max={max} />
      </NextIntlClientProvider>,
    );
  });
}

/** Tear the current mount down mid-test, so one case can assert two mounts in turn. */
async function unmountAll(): Promise<void> {
  await act(async () => { for (const r of roots) r.unmount(); });
  roots = [];
  host?.remove();
  host = null;
}

afterEach(async () => {
  await act(async () => { for (const r of roots) r.unmount(); });
  roots = [];
  host?.remove();
  host = null;
});

const card = (): HTMLElement => {
  const el = host!.querySelector<HTMLElement>(".scast");
  expect(el, "no Reads card rendered").toBeTruthy();
  return el!;
};
const block = (): HTMLElement | null => card().querySelector<HTMLElement>(".msg-rcpts");
/* Document-scoped, so the same helpers serve the ReadsView mount and the bare-component one. */
const chips = (): HTMLButtonElement[] => [...host!.querySelectorAll<HTMLButtonElement>(".rcpt-chip")];
const fold = (): HTMLButtonElement | null => host!.querySelector<HTMLButtonElement>(".msg-rcpt-more");

const click = async (node: Element | null | undefined): Promise<void> => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => {
    (node as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const three: Addr[] = [
  { name: "Anna Roth", address: "anna@x.invalid" },
  { name: "Bo Lind", address: "bo@x.invalid" },
  { name: "Cy Cole", address: "cy@x.invalid" },
];

/* ══ SEVERAL RECIPIENTS — the card says so ═════════════════════════════════════════════════ */

describe("a Reads card with several recipients names them in its header", () => {
  it("renders the reading pane's own block, inside the card's head", async () => {
    await mountReads(message(three));
    const b = block();
    expect(b, "the card's header carries no recipients block").toBeTruthy();
    // Inside the head, under the subject — not appended after the body or the pill.
    expect(b!.closest(".sc-head"), "the block is not in the card's head").toBeTruthy();
    expect(b!.querySelector(".rcpt-k")!.textContent).toBe("To");
  });

  it("names the first two and folds the rest into a count — not a name dropped in silence", async () => {
    await mountReads(message(three));
    expect(chips().map((c) => c.textContent)).toEqual([
      "Anna Roth – anna@x.invalid",
      "Bo Lind – bo@x.invalid",
    ]);
    expect(fold()!.textContent).toContain("+1 more");
  });

  it("the count covers Cc as well as To — everyone not drawn is in the number", async () => {
    await mountReads(message(three, [{ name: "Di Falk", address: "di@x.invalid" }]));
    expect(chips()).toHaveLength(2);
    expect(fold()!.textContent).toContain("+2 more");
  });

  it("pressing the count names everyone, and the control goes back to being `details`", async () => {
    await mountReads(message(three));
    await click(fold());
    expect(chips().map((c) => c.textContent)).toEqual([
      "Anna Roth – anna@x.invalid",
      "Bo Lind – bo@x.invalid",
      "Cy Cole – cy@x.invalid",
    ]);
    expect(fold()!.textContent).toContain("details");
    expect(fold()!.getAttribute("aria-expanded")).toBe("true");
    // The disclosure's older half is still behind the same press.
    expect(card().querySelector(".msg-rcpt-full"), "the details block did not open").toBeTruthy();
  });

  it("the German face carries its own count, not the English one", async () => {
    await mountReads(message(three), "de");
    expect(fold()!.textContent).toContain("+1 weitere");
    expect(block()!.querySelector(".rcpt-k")!.textContent).toBe("An");
  });
});

/* ══ ONE RECIPIENT — the header it always was ══════════════════════════════════════════════ */

describe("a card with one recipient is the header it was", () => {
  it("renders NO recipients block — `To: you` under every subject says nothing", async () => {
    await mountReads(message([{ name: null, address: "me@x.invalid" }]));
    expect(block(), "a one-recipient card grew a recipients block").toBeNull();
    expect(chips()).toHaveLength(0);
    // And the header it always had is untouched.
    expect(card().querySelector(".sc-line b")!.textContent).toBe("Ida Vogt");
    expect(card().querySelector(".sc-line .t")!.textContent).toBeTruthy();
  });

  it("renders no block when the message has no To and no Cc at all", async () => {
    await mountReads(message([]));
    expect(block()).toBeNull();
  });

  it("exactly two recipients draws both and NO count — the cap is not a `+0`", async () => {
    await mountReads(message(three.slice(0, 2)));
    expect(chips()).toHaveLength(2);
    expect(fold()!.textContent).not.toContain("+");
    expect(fold()!.textContent).toContain("details");
  });
});

/* ══ THE PRESS STOPS AT THE CHIP ═══════════════════════════════════════════════════════════ */

describe("a chip press does not also move the card under it", () => {
  it("opens the popover and leaves the card collapsed", async () => {
    await mountReads(message(three));
    expect(card().classList.contains("open")).toBe(false);
    await click(chips()[0]);
    expect(card().querySelector(".cpop"), "the chip opened no popover").toBeTruthy();
    expect(
      card().classList.contains("open"),
      "the chip's press reached the card and expanded it",
    ).toBe(false);
  });

  it("pressing the fold does not expand the card either", async () => {
    await mountReads(message(three));
    await click(fold());
    expect(card().classList.contains("open")).toBe(false);
  });
});

/* ══ ONE COMPONENT, TWO MOUNTS ═════════════════════════════════════════════════════════════ */

/**
 * STRIP COMMENTS BEFORE ASKING WHAT THE CODE SAYS.
 *
 * The census below asserts that neither mount spells the chips itself. Read against raw source
 * that is answerable by PROSE: every one of these files documents the block it mounts, so a
 * comment saying `"rcpt-chip"` fails a passing file, and — the direction that actually costs
 * something — a file could keep a forked implementation alive inside a block comment and the
 * census would never tell them apart. Review named this exact defect. Line comments and block
 * comments go; string literals stay, because a class name in JSX IS a string literal and is the
 * thing being asked about.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

describe("the block is mounted, never re-spelled", () => {
  it("exactly ONE recipients block and ONE popover render, however many surfaces mount it", async () => {
    // The DOM half, which no amount of source-text cleverness can fake: a fork would put a
    // second block or a second popover on the page, and this counts what actually rendered.
    await mountReads(message(three));
    await click(chips()[0]);
    expect(document.querySelectorAll(".msg-rcpts")).toHaveLength(1);
    expect(document.querySelectorAll(".cpop")).toHaveLength(1);
    // And every chip on the page belongs to that one block.
    for (const c of document.querySelectorAll(".rcpt-chip")) {
      expect(c.closest(".msg-rcpts"), "a chip rendered outside the recipients block").toBeTruthy();
    }
  });

  it("both surfaces mount `MessageRecipients` and neither draws its own chips", () => {
    const pane = code(readFileSync(repoFile("app/shell/MessageCard.tsx"), "utf8"));
    const stream = code(readFileSync(repoFile("app/shell/StreamCardMemo.tsx"), "utf8"));
    for (const [name, src] of [["MessageCard.tsx", pane], ["StreamCardMemo.tsx", stream]] as const) {
      expect(src, `${name} does not mount MessageRecipients`).toContain("<MessageRecipients ");
      // The chip markup and the popover mount belong to the one component. A file that grew
      // either back has forked the block, which is what this whole slice exists not to do.
      expect(src, `${name} spells the chips itself`).not.toContain('"rcpt-chip"');
      expect(src, `${name} mounts its own ContactPopover`).not.toContain("<ContactPopover");
    }
  });

  it("the comment stripper does not eat the code it is asked about", () => {
    // The stripper is now load-bearing for the census above, so it is itself under test:
    // a class name in JSX must survive, and a forked implementation hidden in a comment
    // must not. Both directions, because only one of them fails loudly.
    expect(code('const a = 1; // "rcpt-chip"')).not.toContain("rcpt-chip");
    expect(code('/* <ContactPopover /> */ const b = 2;')).not.toContain("<ContactPopover");
    expect(code('<button className="rcpt-chip">')).toContain('"rcpt-chip"');
    expect(code('const u = "https://x.invalid/a"; // note')).toContain("https://x.invalid/a");
  });

  it("the reading pane mounts it UNCAPPED — the pane names everyone", () => {
    const pane = code(readFileSync(repoFile("app/shell/MessageCard.tsx"), "utf8"));
    // The rule is "no cap", not "exactly these props": this mount also passes `notice` now that
    // the blocking sentence is printed by the disclosure in this block, and `max` is the one prop
    // it may never pass — a cap would fold the pane's recipients into a count.
    const mount = /<MessageRecipients\s([^>]*?)\/>/.exec(pane);
    expect(mount, "the reading pane does not mount MessageRecipients").not.toBeNull();
    const props = mount ? mount[1] : "";
    expect(/\bmessage=\{message\}/.test(props), "the pane's mount does not pass the message").toBe(true);
    expect(/\bmax=/.test(props),
      "the reading pane's mount passes a cap — it must name every recipient").toBe(false);
  });

  it("the card's cap is stated once, as a named constant", () => {
    const stream = code(readFileSync(repoFile("app/shell/StreamCardMemo.tsx"), "utf8"));
    expect(stream).toMatch(/const CARD_RECIPIENT_CHIPS = \d+;/);
    expect(stream).toContain("max={CARD_RECIPIENT_CHIPS}");
  });
});

/* ══ THE CAP IS NORMALISED AT THE BOUNDARY ═════════════════════════════════════════════════ */

describe("a nonsense cap cannot produce a plausible-looking block", () => {
  it("a NEGATIVE cap does not slice from the end — it caps at zero", async () => {
    // `slice(0, -1)` keeps everything but the LAST recipient, which is the inverse of "the
    // first N" and renders a block that looks entirely reasonable. Nothing in the product
    // passes a negative; that is exactly why it would never have been noticed.
    await mountRaw(message(three), -1);
    expect(chips(), "a negative cap sliced from the end").toHaveLength(0);
    expect(fold()!.textContent).toContain("+3 more");
  });

  it("a cap of zero puts every name behind the count, and draws no empty row", async () => {
    await mountRaw(message(three), 0);
    expect(chips()).toHaveLength(0);
    expect(document.querySelectorAll(".rcpt-row"), "an empty label row was drawn").toHaveLength(0);
    expect(fold()!.textContent).toContain("+3 more");
  });

  it("a fractional cap is truncated, so the count agrees with the chips drawn", async () => {
    await mountRaw(message(three), 2.7);
    expect(chips()).toHaveLength(2);
    expect(fold()!.textContent).toContain("+1 more");
  });
});

/* ══ THE PRESS STOPS INSIDE THE POPOVER TOO ════════════════════════════════════════════════ */

describe("a press on the popover's own items does not expand the card under it", () => {
  it("pressing Copy leaves the card collapsed", async () => {
    await mountReads(message(three));
    await click(chips()[0]);
    const item = [...card().querySelectorAll<HTMLElement>('.cpop [role="menuitem"]')][0];
    expect(item, "the popover rendered no items").toBeTruthy();
    await click(item);
    expect(
      card().classList.contains("open"),
      "a press inside the popover reached the card and expanded it",
    ).toBe(false);
  });

  it("a press on the popover's head is stopped as well", async () => {
    await mountReads(message(three));
    await click(chips()[0]);
    await click(card().querySelector(".cpop-head"));
    expect(card().classList.contains("open")).toBe(false);
  });
});

/* ══ THE DISCLOSURE'S ACCESSIBLE NAME FOLLOWS ITS NEXT PRESS ═══════════════════════════════ */

describe("the fold control never announces the opposite of what it does", () => {
  it("collapsed it offers to show, expanded it offers to hide", async () => {
    await mountReads(message(three));
    const shown = fold()!.getAttribute("aria-label")!;
    expect(shown.toLowerCase()).toContain("show");
    await click(fold());
    const hidden = fold()!.getAttribute("aria-label")!;
    expect(hidden.toLowerCase()).not.toContain("show");
    expect(hidden.toLowerCase()).toContain("hide");
    expect(fold()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("holds on the uncapped reading-pane form too, where nothing was ever folded", async () => {
    await mountRaw(message(three), Number.POSITIVE_INFINITY);
    expect(fold()!.getAttribute("aria-label")!.toLowerCase()).toContain("show");
    await click(fold());
    expect(fold()!.getAttribute("aria-label")!.toLowerCase()).toContain("hide");
  });

  it("the German face says it in German", async () => {
    await mountReads(message(three), "de");
    await click(fold());
    expect(fold()!.getAttribute("aria-label")).toBe("Weitere Angaben ausblenden");
  });
});

/* ══ THE CHIP IS A DISCLOSURE — THE REAL PRESS SEQUENCE, NOT JUST THE CLICK ════════════════ */

/**
 * A REAL PRESS IS mousedown THEN click, AND ONLY THE PAIR SHOWS THIS.
 *
 * `MoreMenu` dismisses on `mousedown` and excludes its `anchor`; the chip's own handler toggles
 * on `click`. Both halves are needed and they are on DIFFERENT events, so a test that dispatches
 * `click` alone exercises the toggle while the dismiss listener never runs — and passes with the
 * `anchor` prop deleted. Measured at the rebase: removing `anchor={contactAnchor.current}` left
 * the whole suite green, while in a browser mousedown would dismiss and the click would re-open,
 * so the popover could never be closed by its own chip. That is the defect the prop exists to
 * prevent, restored here at the extraction and now guarded at the event level.
 */
describe("a second press on the chip closes it, under the real event sequence", () => {
  /**
   * TWO ACTS, WITH A RENDER BETWEEN THEM — and that detail is the whole test.
   *
   * Dispatched inside ONE `act`, React batches the pair: the dismiss sets the state to null and
   * the click handler still reads the PREVIOUS render's closure, where the popover is open, so
   * it toggles closed and everything passes — with or without the fix. A browser commits between
   * the two events, the click's closure then reads null, and the toggle RE-OPENS what the
   * dismiss just closed. Measured: batched, deleting `anchor` stayed green; unbatched, it fails.
   */
  const press = async (el: Element): Promise<void> => {
    await act(async () => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  };

  it("mousedown+click on the open chip closes it — the trigger is excluded from the dismiss", async () => {
    await mountRaw(message(three), Number.POSITIVE_INFINITY);
    const chip = chips()[0]!;
    await press(chip);
    expect(host!.querySelector(".cpop"), "the first press must open it").toBeTruthy();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    await press(chip);
    expect(host!.querySelector(".cpop"), "the second press must CLOSE it, not re-open it").toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it("a mousedown somewhere else still dismisses — the exclusion is the trigger, not everything", async () => {
    await mountRaw(message(three), Number.POSITIVE_INFINITY);
    await press(chips()[0]!);
    expect(host!.querySelector(".cpop")).toBeTruthy();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(host!.querySelector(".cpop"), "an outside press must still dismiss").toBeNull();
  });
});

/* ══ THE ACCESSIBLE NAME PROMISES ONLY WHAT IS BEHIND THE PRESS ════════════════════════════ */

/**
 * The name is a CLAIM, and both things it used to claim are optional on the wire: a message with
 * no `Date:` header renders no date row (routine — spam and scripts omit it), and
 * `physicalFolder` is optional. The name said "the exact date and where this message sits"
 * regardless, so a screen-reader user was promised two things and handed one, or none.
 */
describe("the disclosure names only what it will actually reveal", () => {
  const ariaOf = (): string => fold()!.getAttribute("aria-label")!;

  it("both present: the wording is unchanged", async () => {
    await mountRaw(message(three), Number.POSITIVE_INFINITY);
    expect(ariaOf()).toBe("Show the exact date and where this message sits");
  });

  it("no folder: it stops claiming a folder", async () => {
    await mountRaw(without(message(three), { folder: true }), Number.POSITIVE_INFINITY);
    expect(ariaOf()).toBe("Show the exact date");
  });

  it("no date: it stops claiming a date", async () => {
    await mountRaw(without(message(three), { date: true }), Number.POSITIVE_INFINITY);
    expect(ariaOf()).toBe("Show where this message sits");
  });

  it("folded, and neither optional field: it claims the recipients alone", async () => {
    await mountRaw(without(message(three), { date: true, folder: true }), 2);
    expect(ariaOf()).toBe("Show every recipient");
    expect(fold()!.textContent).toContain("+1 more");
  });

  it("folded with a date only, and with a folder only", async () => {
    await mountRaw(without(message(three), { folder: true }), 2);
    expect(ariaOf()).toBe("Show every recipient and the exact date");
    await unmountAll();
    await mountRaw(without(message(three), { date: true }), 2);
    expect(ariaOf()).toBe("Show every recipient and where this message sits");
  });

  it("nothing behind the press at all: there is no press", async () => {
    // No names held back, no date, no folder — the control would open an empty list. The chips
    // stay; the dead control goes, which is the rule the header's own menu already keeps.
    await mountRaw(without(message(three), { date: true, folder: true }), Number.POSITIVE_INFINITY);
    expect(fold(), "a disclosure rendered with nothing behind it").toBeNull();
    expect(chips(), "the chips went with it").toHaveLength(3);
  });

  it("the German face makes the same distinctions", async () => {
    await mountRaw(without(message(three), { folder: true }), Number.POSITIVE_INFINITY, "de");
    expect(ariaOf()).toBe("Das genaue Datum anzeigen");
  });
});
