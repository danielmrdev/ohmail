import { test } from "@playwright/test";
import { openHarness, read, setDoc } from "./rig";

test("autolink under a real keyboard", async ({ page, browserName }) => {
  await openHarness(page);
  for (const text of ["see https://example.com now", "see https://example.com. now", "see www.example.com now", "https://example.com ", "a https://example.com/path?q=1 b"]) {
    await setDoc(page, "<p></p>", 1);
    await page.keyboard.type(text);
    console.log(`AUTOLINK ${browserName} ${JSON.stringify(text)} → ${(await read(page)).html}`);
  }
});
