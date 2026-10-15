/** @vitest-environment jsdom */
/**
 * AN OS `mailto:` CLICK WINS THE COMMIT IT SHARES WITH A ROUTE↔OPEN MIRROR WRITE.
 *
 * Both write the hash: the mirror reflects the open state into the bar (`reflectMessage`, in
 * `shell-open-state.ts`), and the desktop's `mailtoDraft` effect navigates to the composer
 * (`go("compose")`, in `shell-compose.ts`). In one React commit the LAST writer owns the bar, so
 * the order of the two hook calls decides which. `useShellCompose` is called below
 * `useShellOpenState` (ARCH-022, the L3 ruling) — mirror, then mailto — and the explicit action
 * stands. The old order let the mirror swallow the click, and it is the red arm below.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { go, parseHash, reflectMessage } from "../app/shell/routing";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shellDir = resolve(process.cwd(), "apps/webapp/app/shell");
const read = (name: string): string => readFileSync(resolve(shellDir, name), "utf8");

/**
 * The two writers as the shell registers them: one effect per hook, in the order the hooks are
 * called. `mirror` is the real `reflectMessage` over a real route; `mailto` is the real `go`.
 */
function Both({ order }: { order: "mirror-then-mailto" | "mailto-then-mirror" }) {
  const mirror = (): void => { reflectMessage(parseHash("#/ohbox"), "m-1"); };
  const mailto = (): void => { go("compose"); };
  const [first, second] = order === "mirror-then-mailto" ? [mirror, mailto] : [mailto, mirror];
  React.useEffect(first, []);
  React.useEffect(second, []);
  return null;
}

async function hashAfter(order: "mirror-then-mailto" | "mailto-then-mirror"): Promise<string> {
  window.location.hash = "#/ohbox";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(h(Both, { order })); });
  const hash = window.location.hash;
  await act(async () => { root.unmount(); });
  host.remove();
  return hash;
}

describe("a mailto: click and a mirror write in one commit", () => {
  it("leaves the compose hash standing in the shipped order", async () => {
    expect(await hashAfter("mirror-then-mailto")).toBe("#/compose");
  });

  /* THE RED CONTROL, RUN RATHER THAN DESCRIBED: the old order, where the mirror's write lands
     last and the person's click is gone from the bar. If this ever reads `#/compose` the arm
     above has stopped measuring anything. */
  it("loses it in the old order — the mirror writes last", async () => {
    const hash = await hashAfter("mailto-then-mirror");
    expect(hash).not.toBe("#/compose");
    expect(hash).toBe("#/ohbox/m/m-1");
  });
});

describe("the order the shell registers them in", () => {
  it("calls useShellCompose below useShellOpenState", () => {
    const shell = read("AppShell.tsx");
    const open = shell.indexOf("} = useShellOpenState({");
    const compose = shell.indexOf("} = useShellCompose({");
    expect(open, "useShellOpenState is not called in AppShell.tsx").toBeGreaterThan(0);
    expect(compose, "useShellCompose is not called in AppShell.tsx").toBeGreaterThan(0);
    expect(compose).toBeGreaterThan(open);
  });

  /* The same claim over a swapped copy of the source: the comparison above is what decides, not
     the two names being present. */
  it("refuses the swapped source", () => {
    const shell = read("AppShell.tsx");
    const swapped = shell
      .replace("} = useShellOpenState({", "} = useShellZZZState({")
      .replace("} = useShellCompose({", "} = useShellOpenState({")
      .replace("} = useShellZZZState({", "} = useShellCompose({");
    expect(swapped.indexOf("} = useShellCompose({"))
      .toBeLessThan(swapped.indexOf("} = useShellOpenState({"));
  });

  /* And the two effects are in the two frames the order is about — a mailto effect left behind
     in `AppShell.tsx` would be registered above the open state, whatever the call order says. */
  /* MAILTO-PARSER-HAS-THREE-HOMES: the one parser's draft reaches the composer whole — every
     surface carries to, cc, bcc, subject and body (the desktop's and the phone's halves are theirs). */
  it("seeds all five fields of the parsed draft", () => {
    const src = read("shell-compose.ts");
    for (const f of ["to: chips(mailtoDraft.to)", "cc: chips(mailtoDraft.cc)", "bcc: chips(mailtoDraft.bcc)", "subject: mailtoDraft.subject", "body: mailtoDraft.body"]) {
      expect(src, `the seeder drops ${f}`).toContain(f);
    }
  });

  it("holds the mailto effect in shell-compose.ts and the mirror write in shell-open-state.ts", () => {
    /* The effect's own BODY, not the file: `writeTo` navigates to the composer too, so a file-wide
       `toContain` would read its copy and pass over a mailto effect that had stopped navigating. */
    const compose = read("shell-compose.ts");
    const deps = "[mailtoDraft, autosave, go, onMailtoDraftSeeded]";
    const end = compose.indexOf(deps);
    expect(end, "the mailto effect's dependency array is not in shell-compose.ts").toBeGreaterThan(0);
    const start = compose.lastIndexOf("useEffect(() => {", end);
    expect(compose.slice(start, end), "the mailto effect no longer navigates to the composer")
      .toContain('go("compose");');
    expect(read("shell-open-state.ts")).toContain("reflectMessage(route, openOnScreen);");
    expect(read("AppShell.tsx")).not.toContain(deps);
  });
});
