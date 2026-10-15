import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE TINTED CIRCLE RESOLVES IN BOTH THEMES — all three theme states, in fact.
 *
 * `Avatar` publishes only a hue angle (`--av-h`); lightness, chroma and alpha are pinned in
 * `avatar.css` PER THEME so that no derived colour can land outside the legible band. The theme
 * has three states, not two: an explicit `data-theme="dark"` / `"light"` stamp, and the default
 * "system" state where nothing is stamped and only `prefers-color-scheme` separates them. A dark
 * block that keys on the stamp alone goes illegible for every system-dark user; one that keys on
 * the media query alone overrides an explicit light choice. So the dark values must exist TWICE,
 * and the media-query copy must exclude both explicit stamps.
 *
 * String-level on purpose, like the row.css assertions in `interactions.test.tsx`: the values
 * under guard are authored CSS, and a computed-style test in jsdom would pass vacuously (jsdom
 * resolves neither `oklch()` nor media queries). Mutation: delete the `[data-theme="dark"]`
 * block — red; drop the `:not([data-theme="light"])` guard off the system block — red.
 */

const css = readFileSync(
  fileURLToPath(new URL("../src/primitives/avatar.css", import.meta.url)),
  "utf8",
);

describe("the tinted avatar's colour is pinned per theme", () => {
  it("light: the bare rule pins lightness and chroma around the one free hue", () => {
    const light = /^\.av\.tinted\{([^}]*)\}/m.exec(css)?.[1];
    expect(light, ".av.tinted has no bare (light) rule").toBeTruthy();
    expect(light).toContain("var(--av-h)");
    expect(light).toMatch(/background:oklch\(/);
    expect(light).toMatch(/color:oklch\(/);
  });

  it("dark, explicit: a [data-theme=\"dark\"] rule restates both colours", () => {
    const dark = /\[data-theme="dark"\] \.av\.tinted\{([^}]*)\}/.exec(css)?.[1];
    expect(dark, "no explicit-dark rule for .av.tinted").toBeTruthy();
    expect(dark).toMatch(/background:oklch\([^)]*var\(--av-h\)/);
    expect(dark).toMatch(/color:oklch\([^)]*var\(--av-h\)/);
  });

  it("dark, system: the prefers-color-scheme copy excludes BOTH explicit stamps", () => {
    const media = /@media \(prefers-color-scheme: dark\)\{([\s\S]*?)\n\}/.exec(css)?.[1];
    expect(media, "no system-dark block in avatar.css").toBeTruthy();
    // Unstamped root only: an explicit light choice must win over the OS preference, and the
    // explicit dark stamp is already served by the rule above — double-applying is harmless,
    // but matching a stamped-light root is the actual defect this selector shape prevents.
    expect(media).toContain(':root:not([data-theme="light"])');
    expect(media).toContain(".av.tinted");
    expect(media).toMatch(/var\(--av-h\)/);
  });
});
