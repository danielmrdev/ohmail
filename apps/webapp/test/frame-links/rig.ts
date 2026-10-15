/**
 * The rig's eyes. The harness is served from a routed http origin (never `file:`), and every other
 * request is answered with a blank page and recorded, so a popup lands somewhere without a network.
 * A NEW-WINDOW REQUEST is what the desktop shell's handler receives: in WebKit, the popup page and
 * the url its first load asked for; in Chromium, whose Playwright build surfaces no page for a
 * non-http popup, a page TARGET the browser created, paired with Blink's url for it. Blink's
 * `Page.windowOpen` alone is no reading: it fires for a popup the sandbox then blocks.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ORIGIN = "http://frame-links.test";
const OUT = resolve(__dirname, "../../../..", process.env.FRAME_LINKS_OUT ?? "build/frame-links");

export interface Rig {
  page: Page;
  browserName: string;
  /** One entry per new-window request, holding the url it asked for ("" until known). */
  windows: string[];
  console: string[];
}

export async function openHarness(context: BrowserContext, browserName: string, query: string): Promise<Rig> {
  const rig: Rig = { page: null as unknown as Page, browserName, windows: [], console: [] };
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(`${ORIGIN}/`)) {
      const name = new URL(url).pathname.slice(1);
      const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html";
      await route.fulfill({ status: 200, contentType: type, body: readFileSync(resolve(OUT, name)) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>popup</title>landed" });
  });
  const page = await context.newPage();
  page.on("console", (m) => rig.console.push(m.text()));
  if (browserName === "chromium") {
    const asked: string[] = [];
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.enable");
    cdp.on("Page.windowOpen", (e) => asked.push(e.url));
    const browser = await context.browser()!.newBrowserCDPSession();
    // Every target that exists at arm time (the harness among them) is never counted.
    const known = new Set((await browser.send("Target.getTargets")).targetInfos.map((t) => t.targetId));
    browser.on("Target.targetCreated", (e) => {
      if (e.targetInfo.type === "page" && !known.has(e.targetInfo.targetId)) rig.windows.push(asked.shift() ?? "");
    });
    await browser.send("Target.setDiscoverTargets", { discover: true });
  } else {
    // Armed after the harness page exists, so the harness is never counted.
    context.on("page", (p) => {
      const at = rig.windows.push("") - 1;
      const take = (url: string) => {
        if (rig.windows[at] === "" && url !== "" && url !== "about:blank") rig.windows[at] = url;
      };
      p.on("framenavigated", (f) => { if (f === p.mainFrame()) take(f.url()); });
      p.on("requestfailed", (r) => take(r.url()));
      p.on("request", (r) => take(r.url()));
      // An http popup has already committed its url by the time the page is announced.
      take(p.url());
    });
  }
  await page.goto(`${ORIGIN}/harness.html?${query}`);
  await page.waitForFunction(() => window.__links?.loaded === true);
  rig.page = page;
  return rig;
}

/** Settle long enough for a new-window request to reach the host and name its url. */
export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(800);
}

export function frameLink(rig: Rig, text: string) {
  return rig.page.frameLocator("iframe").getByText(text, { exact: true });
}

export async function markerCount(rig: Rig): Promise<number> {
  return rig.page.frameLocator("iframe").getByText("FRAME-LINKS-MARKER").count();
}

/** The fixture's five links: the text a person clicks and the href the sanitizer kept. */
export const LINKS: { text: string; href: string }[] = [
  { text: "Wie es deaktiviert wird", href: "https://example.test/deactivate" },
  { text: "example.test", href: "https://elsewhere.test/path?q=1" },
  { text: "write to us", href: "mailto:x@y.test?subject=A%26B" },
  { text: "call us", href: "tel:+41000000000" },
  { text: "the attachment", href: "cid:part1@fixture.test" },
];
