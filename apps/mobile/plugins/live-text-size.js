const { AndroidConfig, withAndroidManifest, createRunOncePlugin } = require("expo/config-plugins");

/**
 * A SYSTEM FONT-SIZE OR DISPLAY-SIZE CHANGE KEEPS THE ACTIVITY on Android.
 *
 * Expo's generated `MainActivity` declares `configChanges` for orientation, screen size and
 * `uiMode`, which is why a fold or a dark-mode switch keeps the open letter. `fontScale` and
 * `density` were missing, so Android destroyed and recreated the activity on either change: React
 * restarted at the Ohbox, the open letter closed and the composer was gone. Declaring both hands
 * the change to React Native, which re-lays the screen in place (`src/theme/text-scale.ts` makes
 * the text nodes re-measure). Expo generates the project, so the line lives here, never in
 * `android/`; it fails loud when the manifest has no main activity.
 */
const KEPT_ON = ["fontScale", "density"];

/** `configChanges` with every value in {@link KEPT_ON} present, order kept, nothing duplicated. */
function configChangesWith(existing) {
  const have = String(existing || "").split("|").map((v) => v.trim()).filter(Boolean);
  for (const v of KEPT_ON) if (!have.includes(v)) have.push(v);
  return have.join("|");
}

/** The parsed manifest with the main activity keeping itself across both changes. */
function keepActivityOnTextSize(manifest) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
  activity.$["android:configChanges"] = configChangesWith(activity.$["android:configChanges"]);
  return manifest;
}

function withLiveTextSize(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = keepActivityOnTextSize(cfg.modResults);
    return cfg;
  });
}

module.exports = createRunOncePlugin(withLiveTextSize, "ohmail-live-text-size", "1.0.0");
module.exports.KEPT_ON = KEPT_ON;
module.exports.configChangesWith = configChangesWith;
module.exports.keepActivityOnTextSize = keepActivityOnTextSize;
