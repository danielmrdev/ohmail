/** @vitest-environment jsdom */
/**
 * ═══ THE SETTINGS ROW'S TWO SENTENCES ARE IN THE ACCESSIBILITY TREE ═════════════════════════
 *
 * Two halves of one defect on two props of one file, and both were invisible to every existing
 * test because every existing test read `textContent`. A sentence that is RENDERED and a sentence
 * a reader can REACH are different facts, and only the first was ever asserted.
 *
 *  1. THE BANNER'S DESCRIPTION. The label and the sentence were siblings inside one
 *     `role="note"`, and a `note` full of plain text is announced as one unnamed block: an
 *     AT-SPI whole-tree walk over the mailboxes pane returned `text='Organizing'` and none of
 *     the three sentences the banner can carry. So the label NAMES a `role="region"` and the
 *     sentence DESCRIBES it, both by id.
 *
 *  2. THE VALUE CELL. A bare `<span>` of text in a `<div>` was dropped entirely by the Linux
 *     WebKit mapping — the row's reach verdict, which is the one thing on the row a person most
 *     needs — while the identical markup IS exposed through UIA on Windows. `role="status"`
 *     makes it a node with text; `aria-live="off"` keeps a ticking minute stamp from being
 *     re-announced every time the clock moves.
 *
 *  3. THE ROW'S DESCRIPTION, the same defect one prop over and on every settings surface. The
 *     update row's whole state is its description, and an AT-SPI walk of the released desktop
 *     read the label and the stamp and not that sentence. So the row is a `group` the label
 *     NAMES and the sentence DESCRIBES. Measured arm by arm in a WebKitGTK view on the guest:
 *     bare span → the label block is a `section` holding the label alone and the sentence is in
 *     NO node; `group` → a `panel` with the label as name, the sentence as `description` AND in
 *     the panel's own text; `region` → the same but a landmark, which ten rows a pane cannot
 *     afford; `aria-describedby` on the control → the description only, and no seat at all on a
 *     row that has no control.
 *
 * ── HOW THE DESCRIPTION IS READ HERE, AND WHY IT IS NOT `toHaveAccessibleDescription` ───────
 *
 * Every assertion below follows `aria-describedby` to the element it names and reads THAT node —
 * the same two steps a screen reader takes. A matcher that computes the description from the
 * attribute would agree with the attribute by construction: it would pass for an id pointing at
 * nothing, and it would pass for a sentence hidden from the tree. Following the link and reading
 * the node it lands on is the only version of this test that can fail for the right reason.
 *
 * ── WHAT THIS FILE CANNOT PROVE ──────────────────────────────────────────────────────────────
 *
 * jsdom has no platform mapping. It says the attributes are there and point at the right text;
 * it says nothing about whether WebKit exposes these nodes. That reading is the guest's AT-SPI
 * band walk on the release candidate's second cell, against the Windows UIA read as the control that
 * the text was always rendered.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SettingsBanner, SettingsRow, SettingsSection } from "@ohmail/ui";

afterEach(cleanup);

/** The two steps a reader takes: read the attribute, then read the node it names. */
const describedBy = (el: HTMLElement): { id: string | null; node: HTMLElement | null; text: string } => {
  const id = el.getAttribute("aria-describedby");
  const node = id ? document.getElementById(id) : null;
  return { id, node, text: (node?.textContent ?? "").trim() };
};

/**
 * Everything in a row that Tab reaches. Written out rather than taken from a library, because
 * the assertion is about which of OUR nodes are stops — a value cell that became a `tabindex=0`
 * live region, or a description that grew a focusable wrapper, is exactly the regression this
 * catches, and both would be reported as "focusable" by any definition.
 */
const tabStops = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]',
  )].filter((el) => el.getAttribute("tabindex") !== "-1");

describe("SettingsBanner — the label names the region, the sentence describes it", () => {
  const SENTENCE = "Stopping on the next pass — waiting for the server to confirm.";

  it("is a region named by its label, described by the sentence on screen", () => {
    const { getByRole } = render(
      <SettingsBanner label="Organizing" description={SENTENCE} />,
    );

    const region = getByRole("region", { name: "Organizing" });
    expect(region.classList.contains("set-banner")).toBe(true);

    const said = describedBy(region);
    expect(said.node, "aria-describedby names no element in the document").not.toBeNull();
    expect(said.text).toBe(SENTENCE);
  });

  it("the described node IS the visible sentence — the same span, not a copy and not hidden", () => {
    const { container, getByRole } = render(
      <SettingsBanner label="Organizing" description={SENTENCE} />,
    );
    const said = describedBy(getByRole("region", { name: "Organizing" }));

    /* One sentence in the DOM, and the described node is it. A second, visually-hidden copy
       would satisfy a description matcher and would be a sentence that can drift from the one
       on screen. */
    expect(container.querySelectorAll(".set-banner .lab > span")).toHaveLength(1);
    expect(said.node).toBe(container.querySelector(".set-banner .lab > span"));

    // `aria-hidden` anywhere on the path would take the sentence back out of the tree.
    expect(said.node!.getAttribute("aria-hidden")).toBeNull();
    expect(said.node!.closest("[aria-hidden]")).toBeNull();

    /* Still the label block's DIRECT child span, which is what `.set-banner .lab > span`
       styles. Reference by id must not have moved the node, or the sentence changes size. */
    expect(said.node!.tagName).toBe("SPAN");
    expect(said.node!.parentElement!.className).toBe("lab");
  });

  it("carries NO aria-describedby when there is no sentence — never a dangling reference", () => {
    const { getByRole } = render(<SettingsBanner label="Organized by ohmail Cloud" />);
    const region = getByRole("region", { name: "Organized by ohmail Cloud" });
    expect(region.hasAttribute("aria-describedby"), "an id pointing at nothing").toBe(false);
  });

  it("names the region by the LABEL, so the verb beside it is not read as the name", () => {
    const { getByRole } = render(
      <SettingsBanner
        label="Organizing"
        description={SENTENCE}
        action={<button type="button">Stop organizing</button>}
      />,
    );
    const region = getByRole("region", { name: "Organizing" });
    expect(region.getAttribute("aria-label"), "a second name would win over the label").toBeNull();
    // The verb is inside the region and is its own control, never part of the region's name.
    expect(region.querySelector("button")!.textContent).toBe("Stop organizing");
  });
});

describe("SettingsRow — the value cell is a node with text", () => {
  it("is a status carrying the visible verdict, and does not announce on its own", () => {
    const { getByRole } = render(
      <SettingsRow label="you@example.test" value="Can't reach the mail server. Last answered 3 minutes ago." />,
    );
    const cell = getByRole("status");
    expect(cell.classList.contains("set-val")).toBe(true);
    expect(cell.textContent).toBe("Can't reach the mail server. Last answered 3 minutes ago.");
    /* OFF and not polite: the sentence restates a minute stamp that moves on its own, and a
       polite region would say the whole thing again on every tick. */
    expect(cell.getAttribute("aria-live")).toBe("off");
  });

  it("a row with no value has no status node at all", () => {
    const { container } = render(<SettingsRow label="Language" control={<button type="button">English</button>} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("a value that brings its OWN live region keeps it — the wrapper does not silence it", () => {
    /**
     * ── THE ONE NESTING THIS CHANGE CREATES, MEASURED RATHER THAN ASSUMED ───────────────────
     *
     * The desktop's Mailboxes pane already wraps its reach sentence in `role="status"` at the
     * call site, with the ticking stamp BESIDE the live node as a `role="note"` so the minute
     * is never announced. Putting `role="status"` on `.set-val` therefore puts a status inside
     * a status on that one row, and the question a reader of the tree will ask is whether the
     * outer `aria-live="off"` has just silenced an announcement somebody asked for.
     *
     * It has not, and this is the reason: a live region's politeness comes from the NEAREST
     * live-region ancestor, and the inner node is one — it is its own root. So a change to the
     * sentence still announces at the inner node's own politeness (polite, by `role="status"`),
     * and a change to the stamp resolves to the outer node, which is off. The text is read once
     * either way; nesting does not duplicate reading order.
     *
     * Asserted as SHAPE, because that is all jsdom can hold: two statuses, the inner with no
     * politeness of its own to inherit anything over, the outer off, the stamp inside the outer
     * and still a note, and the sentence appearing exactly once in the row's text.
     */
    const { container } = render(
      <SettingsRow
        label="you@example.test"
        value={
          <>
            <span className="mbx-reach" role="status">Up to date</span>{" "}
            <span className="mbx-reach-when" role="note">3 minutes ago</span>
          </>
        }
      />,
    );
    const row = container.querySelector<HTMLElement>(".set-row")!;
    const statuses = [...row.querySelectorAll<HTMLElement>('[role="status"]')];
    expect(statuses.map((el) => el.className)).toEqual(["set-val", "mbx-reach"]);

    const [outer, inner] = statuses as [HTMLElement, HTMLElement];
    expect(outer.getAttribute("aria-live"), "the wrapper is the silent one").toBe("off");
    expect(inner.hasAttribute("aria-live"), "the inner node states no politeness, so `status` decides it").toBe(false);
    expect(inner.closest('[aria-live="off"]')).toBe(outer);

    // The stamp stays a note inside the silent wrapper: in the tree, never announced.
    const stamp = row.querySelector<HTMLElement>('[role="note"]')!;
    expect(stamp.textContent).toBe("3 minutes ago");
    expect(stamp.closest('[role="status"]')).toBe(outer);

    // Read once, not twice.
    expect(row.textContent!.match(/Up to date/g)).toHaveLength(1);
  });

  it("the row's two buttons stay the ONLY tab stops — the cell is text, not a stop", () => {
    const { container } = render(
      <SettingsRow
        label="you@example.test"
        description="Organized on this computer."
        value="Up to date"
        control={
          <>
            <button type="button">Run setup</button>
            <button type="button">Remove</button>
          </>
        }
      />,
    );
    const row = container.querySelector<HTMLElement>(".set-row")!;
    expect(tabStops(row).map((el) => el.textContent)).toEqual(["Run setup", "Remove"]);
  });
});

describe("SettingsRow — the label names the row, the state sentence describes it", () => {
  const LABEL = "Software update";
  const SENTENCE = "ohmail 0.16.2 is ready. ohmail restarts to finish.";
  const STAMP = "Checked 2 minutes ago";

  const updateRow = (extra?: { control?: boolean }) => (
    <SettingsRow
      label={LABEL}
      description={SENTENCE}
      value={STAMP}
      control={extra?.control === false ? undefined : <button type="button">Restart to finish</button>}
    />
  );

  it("is a group named by its label, described by the sentence on screen", () => {
    const { getByRole } = render(updateRow());

    const row = getByRole("group", { name: LABEL });
    expect(row.classList.contains("set-row")).toBe(true);

    const said = describedBy(row);
    expect(said.node, "aria-describedby names no element in the document").not.toBeNull();
    expect(said.text).toBe(SENTENCE);
  });

  it("the described node IS the visible sentence — the same span, not a copy and not hidden", () => {
    const { container, getByRole } = render(updateRow());
    const said = describedBy(getByRole("group", { name: LABEL }));

    /* One sentence in the DOM and the described node is it. A visually-hidden second copy would
       satisfy a description matcher and would be free to drift from the one on screen. */
    expect(container.querySelectorAll(".set-row .lab > span")).toHaveLength(1);
    expect(said.node).toBe(container.querySelector(".set-row .lab > span"));

    // `aria-hidden` anywhere on the path would take the sentence back out of the tree.
    expect(said.node!.getAttribute("aria-hidden")).toBeNull();
    expect(said.node!.closest("[aria-hidden]")).toBeNull();

    /* Still the label block's DIRECT child span, which is what `.set-row .lab > span` styles.
       Reference by id must not have moved the node, or the sentence changes size. */
    expect(said.node!.tagName).toBe("SPAN");
    expect(said.node!.parentElement!.className).toBe("lab");
  });

  it("carries NO aria-describedby when there is no sentence — never a dangling reference", () => {
    const { getByRole } = render(
      <SettingsRow label="Language" control={<button type="button">English</button>} />,
    );
    const row = getByRole("group", { name: "Language" });
    expect(row.hasAttribute("aria-describedby"), "an id pointing at nothing").toBe(false);
    // And no id is minted for a span that does not exist.
    expect(row.querySelector(".lab > span")).toBeNull();
  });

  it("names the row by the LABEL — neither the stamp nor the verb is the name", () => {
    const { getByRole } = render(updateRow());
    const row = getByRole("group", { name: LABEL });

    expect(row.getAttribute("aria-label"), "a second name would win over the label").toBeNull();
    /* The stamp and the control are inside the row and are their own nodes. If either reached the
       name, the row would announce as "Software update Checked 2 minutes ago Restart to finish". */
    expect(row.getAttribute("aria-labelledby")).toBe(row.querySelector(".lab > b")!.id);
    expect(row.querySelector(".set-val")!.textContent).toBe(STAMP);
    expect(row.querySelector("button")!.textContent).toBe("Restart to finish");
  });

  it("a row with NO control still carries its sentence — the packaged-install shape", () => {
    /**
     * The reason the description sits on the ROW and not on the control. A managed install's
     * update row is a label and a sentence and nothing else — `DesktopUpdate` passes neither
     * `value` nor `control` when the install is packaged — so `aria-describedby` on the control
     * would have no seat on the one row whose sentence is the whole answer.
     */
    const { getByRole } = render(
      <SettingsRow
        label={LABEL}
        description="A packaged install does not update itself — install the newer package the way you installed this one."
      />,
    );
    const row = getByRole("group", { name: LABEL });
    expect(row.querySelector("button"), "the shape under test has no control").toBeNull();
    expect(describedBy(row).text).toBe(
      "A packaged install does not update itself — install the newer package the way you installed this one.",
    );
  });

  it("every row in a pane that HAS a sentence can be reached by it, and no other row points anywhere", () => {
    /**
     * The census, over the mix a real pane holds: described and undescribed, with a control and
     * without, a value and none. Read the house way — follow `aria-describedby` and read the node
     * it lands on — rather than by a description matcher, which computes the answer from the
     * attribute and so agrees with a dangling id and with a sentence hidden from the tree.
     */
    const rows: { label: string; description?: string }[] = [
      { label: LABEL, description: SENTENCE },
      { label: "Licence", description: "Signed in as this computer." },
      { label: "Keyboard shortcuts" },
      { label: "Mailbox", description: "Organized on this computer." },
      { label: "Opened through", description: "ohmail is the default mail app." },
      { label: "Build" },
    ];
    const { container } = render(
      <SettingsSection>
        {rows.map((r) => (
          <SettingsRow
            key={r.label}
            label={r.label}
            description={r.description}
            value={r.description ? STAMP : undefined}
            control={r.description ? <button type="button">{`Check ${r.label}`}</button> : undefined}
          />
        ))}
      </SettingsSection>,
    );

    const rendered = [...container.querySelectorAll<HTMLElement>(".set-row")];
    expect(rendered).toHaveLength(rows.length);

    const read = rendered.map((el) => ({
      label: el.querySelector(".lab > b")!.textContent,
      role: el.getAttribute("role"),
      named: el.getAttribute("aria-labelledby") === el.querySelector(".lab > b")!.id,
      said: describedBy(el).text || undefined,
    }));
    expect(read).toEqual(rows.map((r) => ({ label: r.label, role: "group", named: true, said: r.description })));

    // Every id this component mints is unique in the document, or one row describes another's row.
    const ids = [...container.querySelectorAll<HTMLElement>("[id]")].map((el) => el.id);
    expect(new Set(ids).size, "a duplicate id sends a reader to the wrong sentence").toBe(ids.length);

    /* The control a reader tabs to stands INSIDE the described group, which is how the sentence
       reaches somebody who arrived at the button rather than at the row. */
    for (const el of rendered.filter((e) => e.querySelector("button"))) {
      expect(el.querySelector("button")!.closest("[aria-describedby]")).toBe(el);
    }
  });

  it("adds accessibility attributes and NOTHING else — the rendered box is byte-identical", () => {
    /**
     * The visual pin. Strip exactly what this change introduced — the row's `role`, its two
     * references, and the ids on the label and the sentence — and the markup must be the string
     * the component rendered BEFORE it, captured from the component at
     * A wrapper element, a moved span or a changed
     * class name reddens here; the value cell's own `role="status"`/`aria-live` are NOT stripped,
     * so a later edit cannot quietly take those out under cover of this test.
     */
    const strip = (el: HTMLElement): string => {
      const c = el.cloneNode(true) as HTMLElement;
      for (const a of ["role", "aria-labelledby", "aria-describedby"]) c.removeAttribute(a);
      c.querySelector(".lab > b")?.removeAttribute("id");
      c.querySelector(".lab > span")?.removeAttribute("id");
      return c.outerHTML;
    };

    const full = render(updateRow());
    expect(strip(full.container.querySelector<HTMLElement>(".set-row")!)).toBe(
      '<div class="set-row"><div class="lab"><b>Software update</b>'
      + '<span>ohmail 0.16.2 is ready. ohmail restarts to finish.</span></div>'
      + '<span class="set-val" role="status" aria-live="off">Checked 2 minutes ago</span>'
      + '<button type="button">Restart to finish</button></div>',
    );
    cleanup();

    const bare = render(<SettingsRow label="Language" control={<button type="button">English</button>} />);
    expect(strip(bare.container.querySelector<HTMLElement>(".set-row")!)).toBe(
      '<div class="set-row"><div class="lab"><b>Language</b></div>'
      + '<button type="button">English</button></div>',
    );
  });

  it("the group is not a tab stop — the row's control stays the only one", () => {
    const { container } = render(updateRow());
    const row = container.querySelector<HTMLElement>(".set-row")!;
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(tabStops(row).map((el) => el.textContent)).toEqual(["Restart to finish"]);
  });
});
