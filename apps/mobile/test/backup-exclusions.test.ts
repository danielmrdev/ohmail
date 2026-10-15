import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE MAIL DOES NOT RIDE AN ANDROID BACKUP — and it must not do so BY ACCIDENT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `servers-native.ts` promises that the refresh tokens never ride a cloud or OS backup, and
 * delivers it with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. The MAIL those tokens protect had no
 * equivalent: the generated Android manifest carries `allowBackup="true"`, and the only thing
 * keeping the SQLite mirrors out of the backup was `expo-secure-store`'s own two XML files,
 * which happen to be include-only over `sharedpref` — so the `databases` directory falls
 * outside them. That is a dependency's file protecting our mailbox, and this suite exists to
 * make the accident an assertion.
 *
 * Three things are checked, and the third is the one that makes the other two mean something:
 *
 *  1. this app's OWN rules exclude the database, file and external domains, in both the
 *     Android-11 and the Android-12+ shapes, cloud backup AND device transfer;
 *  2. they keep `SecureStore` excluded — dropping it would put the refresh tokens INTO the
 *     backup, which is the exact posture inversion this must never cause while fixing the mail;
 *  3. the manifest is actually pointed at them, and the plugin runs LAST so it wins the
 *     attribute from `expo-secure-store`'s plugin, which sets the same two.
 *
 * WHAT IS NOT CLAIMED: that a real device honours it. Nothing off-device can claim that. What is
 * claimed is that the property belongs to code this repository owns, so a dependency bump can no
 * longer silently re-open it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const plugin = req(join(here, "../plugins/backup-exclusions.js")) as {
  BACKUP_RULES_RES: string;
  DATA_EXTRACTION_RULES_RES: string;
  BACKUP_RULES_XML: string;
  DATA_EXTRACTION_RULES_XML: string;
  pointManifestAtOurRules: (m: unknown) => unknown;
};

/** Every domain whose contents are mail or mail-adjacent, and none of which may be backed up. */
const FORBIDDEN_DOMAINS = ["database", "file", "external"];

describe("this app's own Android backup rules", () => {
  /* THE PROTECTION IS THE INCLUDE-ONLY SHAPE, ASSERTED DIRECTLY — not three excludes.
   *
   * This used to require `<exclude domain="database|file|external" path="."/>` in both shapes,
   * on the argument that a rule true only by implication stops being true when somebody adds an
   * `<include>`. The argument is right and the mechanism was wrong: Android Lint's
   * `FullBackupContent` check rejects an exclude for a domain that is not included (". is not in
   * an included path"), `lintVitalRelease` is fatal, and those three lines failed the release APK
   * outright — nine errors, no artifact. Caught by the first `android-v0.13.0` tag build.
   *
   * What actually keeps the mirror out of a backup is that each ruleset includes exactly ONE
   * domain, `sharedpref`, leaving `databases`, `files` and external storage outside it by
   * construction. That is now the assertion, so adding an `<include>` for a mail-bearing domain
   * turns this red — which is precisely what the invalid lines were reaching for. */
  it("include exactly one domain — sharedpref — so the mirror is outside the backup by construction", () => {
    const includes = (xml: string): string[] => xml.match(/<include\b[^>]*\/>/g) ?? [];

    expect(includes(plugin.BACKUP_RULES_XML)).toEqual(['<include domain="sharedpref" path="."/>']);

    // The 12+ shape has TWO sections and both matter: `device-transfer` is the phone-to-phone
    // copy, which is a backup by another name. So it carries the one include TWICE, once each.
    expect(plugin.DATA_EXTRACTION_RULES_XML).toContain("<cloud-backup>");
    expect(plugin.DATA_EXTRACTION_RULES_XML).toContain("<device-transfer>");
    expect(includes(plugin.DATA_EXTRACTION_RULES_XML)).toEqual([
      '<include domain="sharedpref" path="."/>',
      '<include domain="sharedpref" path="."/>',
    ]);

    // And no mail-bearing domain is included anywhere, in either shape, stated by name.
    for (const domain of FORBIDDEN_DOMAINS) {
      expect(plugin.BACKUP_RULES_XML).not.toContain(`<include domain="${domain}"`);
      expect(plugin.DATA_EXTRACTION_RULES_XML).not.toContain(`<include domain="${domain}"`);
    }
  });

  it("state no exclude Android Lint will refuse — an exclude outside the include set is FATAL", () => {
    /* `lintVitalRelease` fails the release build on `FullBackupContent`. An exclude is only legal
     * for a domain the ruleset includes, so the only legal exclude here is under `sharedpref`. */
    const excludes = (xml: string): string[] => xml.match(/<exclude\b[^>]*\/>/g) ?? [];
    for (const x of [...excludes(plugin.BACKUP_RULES_XML), ...excludes(plugin.DATA_EXTRACTION_RULES_XML)]) {
      expect(x, `${x} excludes a domain that is not included — Android Lint refuses this`)
        .toContain('domain="sharedpref"');
    }
  });

  it("keep the keystore excluded — the fix must not invert the credential posture", () => {
    // `expo-secure-store` stores under a `SecureStore` sharedpref. Our rules replace theirs on
    // the manifest, so forgetting this line would put the refresh tokens into a Google backup
    // while fixing the mail — strictly worse than the defect being closed.
    expect(plugin.BACKUP_RULES_XML).toContain('<exclude domain="sharedpref" path="SecureStore"/>');
    expect(plugin.DATA_EXTRACTION_RULES_XML.split('<exclude domain="sharedpref" path="SecureStore"/>').length - 1)
      .toBe(2);
    // …and the narrow include-only posture is preserved rather than widened into exclude-only,
    // which would back up everything not named.
    expect(plugin.BACKUP_RULES_XML).toContain('<include domain="sharedpref" path="."/>');
  });

  it("the manifest is pointed at OUR resources, not left on the dependency's", () => {
    const manifest = { manifest: { application: [{ $: {
      "android:allowBackup": "true",
      "android:fullBackupContent": "@xml/secure_store_backup_rules",
      "android:dataExtractionRules": "@xml/secure_store_data_extraction_rules",
    } }] } };
    const out = plugin.pointManifestAtOurRules(manifest) as typeof manifest;
    const attrs = out.manifest.application[0]!.$;
    expect(attrs["android:fullBackupContent"]).toBe(`@xml/${plugin.BACKUP_RULES_RES}`);
    expect(attrs["android:dataExtractionRules"]).toBe(`@xml/${plugin.DATA_EXTRACTION_RULES_RES}`);
  });

  it("REFUSES rather than silently applying nothing when there is no <application>", () => {
    // A plugin that quietly no-ops here would leave every check green over a build whose mail
    // can ride a cloud backup — the failure shape `without-embedded-fcm.js` names for itself.
    expect(() => plugin.pointManifestAtOurRules({ manifest: {} })).toThrow(/<application>/);
  });

  it("runs LAST in app.json, because the plugin that runs last wins the attribute", () => {
    const app = JSON.parse(readFileSync(join(here, "../app.json"), "utf8")) as {
      expo: { plugins: Array<string | [string, unknown]> };
    };
    const names = app.expo.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names).toContain("./plugins/backup-exclusions");
    expect(names.indexOf("./plugins/backup-exclusions"))
      .toBeGreaterThan(names.indexOf("expo-secure-store"));
    // Last outright, so no future plugin quietly takes the attribute back.
    expect(names[names.length - 1]).toBe("./plugins/backup-exclusions");
  });

  it("the dependency's own rules are STILL include-only, so the accident is real and recorded", () => {
    // Anti-vacuity, and the reason this whole plugin exists: if `expo-secure-store` ever ships
    // exclude-only rules, Android's `allowBackup="true"` widens to everything not named — and
    // before this plugin, that would have started backing up the mailbox with nothing failing.
    // If this assertion goes red, the dependency changed shape and the note above needs
    // rewriting; the protection itself no longer depends on it either way.
    const store = req.resolve("expo-secure-store/package.json");
    const rules = readFileSync(
      join(dirname(store), "android/src/main/res/xml/secure_store_backup_rules.xml"), "utf8",
    );
    expect(rules).toContain('<include domain="sharedpref" path="."/>');
    expect(rules).not.toContain('<exclude domain="database"');
  });
});
