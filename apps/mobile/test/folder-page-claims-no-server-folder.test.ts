import { describe, expect, it } from "vitest";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";

/**
 * THE PHONE'S FOLDER PAGE CLAIMS NOTHING ABOUT THE SERVER'S FOLDERS.
 *
 * The empty folder page said the folder "lives on your mail server" over folders the server had
 * deleted days before. The list follows the server now, and the page says only what the phone
 * knows: what it holds. A folder that leaves says so on its own screen (`Copy.folderGone`).
 */
describe("the phone's empty folder page", () => {
  it("says what the phone holds, never that the folder is on the server, in either language", () => {
    for (const deck of [EN, DE]) {
      expect(deck.folderEmptyHint).not.toMatch(/lives on your mail server|liegt auf deinem Mailserver|exists|existiert/i);
      expect(deck.folderEmptyTitle.length).toBeGreaterThan(0);
      expect(deck.folderGone.length, "a folder that leaves has no sentence").toBeGreaterThan(0);
    }
  });
});
