/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../messages/en.json";
import { announceUpdate, currentUpdateOffer, resetUpdateStoreForTests } from "../app/shell/app-update";
import { UpdateNotice } from "../app/shell/UpdateNotice";

/**
 * ═══ THE STRIP THAT SAYS A NEWER OHMAIL EXISTS ═══════════════════════════════════════════════
 *
 * One surface for two doors that share no mechanism: in a tab the newer thing is a build this
 * origin is already serving and the remedy is a reload; in the desktop window it is a signed
 * release the native process has fetched and verified and the remedy is a restart. The strip
 * knows neither. It renders a sentence and calls the callback the offer carries — which is what
 * keeps the shared shell unable to name a feed, a version or an install.
 *
 * Held while a message is being written, and that is the assertion this file exists for: a strip
 * appearing above somebody mid-sentence moves the layout under their cursor, and the one press
 * it offers throws the draft's window away.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const copy = (en as { update: Record<string, string> }).update;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, { locale: "en", messages: en as never, children: node }),
    );
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  resetUpdateStoreForTests();
});

const buttons = (): HTMLButtonElement[] =>
  [...(host?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];

describe("the update strip", () => {
  it("renders NOTHING when there is nothing to say", async () => {
    const el = await mount(h(UpdateNotice));
    // No permanent "you are up to date" chrome to learn to ignore: absent from the DOM, not
    // merely empty, so nothing reserves a band and no live region announces silence.
    expect(el.innerHTML).toBe("");
  });

  it("a newer BUILD offers a reload, and pressing it does what the source armed", async () => {
    const reload = vi.fn();
    const el = await mount(h(UpdateNotice));
    await act(async () => announceUpdate({ kind: "reload", act: reload }));

    expect(el.textContent).toContain(copy.barReload!);
    const doIt = buttons().find((b) => b.className === "upd-do")!;
    expect(doIt.textContent).toBe(copy.barReloadAction!);
    await act(async () => doIt.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a verified RELEASE names its version and offers the restart", async () => {
    const restart = vi.fn();
    const el = await mount(h(UpdateNotice));
    await act(async () => announceUpdate({ kind: "restart", version: "0.15.1", act: restart }));

    expect(el.textContent).toContain("ohmail 0.15.1");
    const doIt = buttons().find((b) => b.className === "upd-do")!;
    expect(doIt.textContent).toBe(copy.barRestartAction!);
    await act(async () => doIt.click());
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("AN INSTALLER THAT DID NOT START IS SAID, and the press tries again", async () => {
    const retry = vi.fn();
    const el = await mount(h(UpdateNotice));
    await act(async () => announceUpdate({ kind: "retry", version: "0.15.1", act: retry }));

    expect(el.textContent).toContain(copy.barNotStarted!.replace("{version}", "0.15.1"));
    expect(el.textContent).not.toContain(copy.barRestart!.replace("{version}", "0.15.1"));
    const doIt = buttons().find((b) => b.className === "upd-do")!;
    expect(doIt.textContent).toBe(copy.barRetryAction!);
    await act(async () => doIt.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("AN INSTALL THIS APP CANNOT PERFORM HAS NO BUTTON, and says where to go instead", async () => {
    // Installed from a distribution's packages, the app's own files belong to the package
    // manager and this app has no business rewriting them. A "Restart now" here would be a
    // control that cannot work, offered in the one case where the remedy is somewhere else.
    const el = await mount(h(UpdateNotice));
    await act(async () => announceUpdate({ kind: "package" }));

    /* AND IT DOES NOT ASSERT HOW THE COPY WAS INSTALLED. What the state establishes is that the
       replacement failed — an AppImage on a read-only mount reaches it too — so the sentence
       names the package manager as a condition, not as a diagnosis. Told the wrong way round it
       would be a false claim sending somebody to a place the release is not. */
    expect(el.textContent).toContain("could not replace its own files");
    expect(el.textContent).toContain("If you installed it through your distribution");
    expect(el.textContent, "never a claim about where this copy came from")
      .not.toContain("was installed by your package manager");
    expect(buttons().some((b) => b.className === "upd-do")).toBe(false);
    // The way out is still there. A strip nobody can put away has to be right about how often
    // it appears; this one is right about that AND can be dismissed.
    expect(buttons().some((b) => b.className === "upd-later")).toBe(true);
  });

  it("dismissing it withdraws the offer for everybody, not just this component", async () => {
    const el = await mount(h(UpdateNotice));
    await act(async () => announceUpdate({ kind: "reload", act: () => {} }));
    const later = buttons().find((b) => b.className === "upd-later")!;
    await act(async () => later.click());
    expect(el.innerHTML).toBe("");
    expect(currentUpdateOffer()).toBeNull();
  });

  it("WAITS WHILE A MESSAGE IS BEING WRITTEN, and is not withdrawn by waiting", async () => {
    const el = await mount(h(UpdateNotice, { quiet: true }));
    await act(async () => announceUpdate({ kind: "reload", act: () => {} }));
    expect(el.innerHTML, "nothing above a compose").toBe("");
    // The offer is still standing — a suppressed notice would be a day of silence bought by
    // somebody happening to be typing when the source spent its one ask.
    expect(currentUpdateOffer()?.kind).toBe("reload");

    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    const back = await mount(h(UpdateNotice));
    expect(back.textContent).toContain(copy.barReload!);
  });

  it("adopts an offer that was made before it mounted", async () => {
    // The sources are armed at boot and this component mounts with a view, so the strip is
    // routinely later than the fact it reports.
    announceUpdate({ kind: "reload", act: () => {} });
    const el = await mount(h(UpdateNotice));
    expect(el.textContent).toContain(copy.barReload!);
  });
});
