import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * THE APP MUST OWN A SCENE, NOT A WINDOW — or the current iOS SDK refuses to launch it.
 *
 * Expo SDK 57's template builds `UIWindow(frame: UIScreen.main.bounds)` in the app delegate.
 * Against the iOS 27 SDK that traps at scene creation; against iOS 26 it launches into a legacy
 * compatibility window, so a foldable hands the app a canvas it does not have. Nothing in
 * react-native 0.86.2 or expo 57.0.9 adopts scenes, so `plugins/with-ios-scene-lifecycle.js`
 * does — and this file is what keeps it true when the template moves under it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const plugin = req(join(here, "../plugins/with-ios-scene-lifecycle.js")) as {
  SCENE_DELEGATE_CLASS: string;
  MARKER: string;
  SCENE_MANIFEST: {
    UIApplicationSupportsMultipleScenes: boolean;
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: Array<{
        UISceneConfigurationName: string;
        UISceneDelegateClassName: string;
      }>;
    };
  };
  addSceneManifest: (plist: Record<string, unknown>) => Record<string, unknown>;
  adoptSceneLifecycle: (contents: string) => string;
};

/* The subject is the template's OWN AppDelegate.swift, byte-for-byte: taken from the file
 * `expo-template-bare-minimum@57.0.9` generates, so the transform below is measured against the
 * text it will really meet rather than against a paraphrase of it. */
const TEMPLATE = readFileSync(join(here, "fixtures/ios/AppDelegate.template-57.swift"), "utf8");

const PLUGIN_SRC = readFileSync(join(here, "../plugins/with-ios-scene-lifecycle.js"), "utf8");
const APP_JSON = JSON.parse(readFileSync(join(here, "../app.json"), "utf8")) as {
  expo: { plugins: Array<string | [string, unknown]> };
};

/** The generated file, and its two halves: what stays on the app delegate, and the scene. */
const generated = plugin.adoptSceneLifecycle(TEMPLATE);
const [appDelegateHalf, sceneHalf] = generated.split(`@objc(${plugin.SCENE_DELEGATE_CLASS})`);

describe("the iOS scene lifecycle this app adopts", () => {
  it("declares one scene, one window, and no second one by default", () => {
    const manifest = plugin.SCENE_MANIFEST;
    expect(manifest.UIApplicationSupportsMultipleScenes).toBe(false);
    const configs = manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication;
    expect(configs, "a second application-role configuration is a second window").toHaveLength(1);
    expect(configs[0]!.UISceneConfigurationName).toBe("Default Configuration");
  });

  /* The pairing that nothing else can catch: UIKit looks the delegate class up BY NAME at scene
   * connection, so a plist naming a class the Swift does not export is a launch failure with no
   * compile error in front of it. The name is parsed out of the generated source, never assumed. */
  it("names a scene delegate class the generated Swift actually exports", () => {
    const declared = plugin.SCENE_MANIFEST
      .UISceneConfigurations.UIWindowSceneSessionRoleApplication[0]!.UISceneDelegateClassName;
    const exported = /@objc\(([A-Za-z_][A-Za-z0-9_]*)\)\nclass \1: UIResponder, UIWindowSceneDelegate/
      .exec(generated);
    expect(exported, "the generated Swift exports no UIWindowSceneDelegate under an @objc name")
      .not.toBeNull();
    expect(declared).toBe(exported![1]);
  });

  it("puts the Info.plist manifest in, whole, over whatever was there", () => {
    const out = plugin.addSceneManifest({ CFBundleName: "ohmail", UIApplicationSceneManifest: { stale: true } });
    expect(out.UIApplicationSceneManifest).toEqual(plugin.SCENE_MANIFEST);
    expect(out.CFBundleName, "the mod must not drop the rest of the plist").toBe("ohmail");
  });

  /* The app delegate keeps the factory — the scene starts React Native THROUGH it — and loses the
   * window. Keeping both would give the app two windows, one of them the compatibility one. */
  it("takes the window off the app delegate and leaves the factory", () => {
    expect(appDelegateHalf).not.toContain("var window: UIWindow?");
    expect(appDelegateHalf).not.toContain("UIWindow(frame: UIScreen.main.bounds)");
    expect(appDelegateHalf).not.toContain("factory.startReactNative(");
    expect(appDelegateHalf).toContain("let factory = ExpoReactNativeFactory(delegate: delegate)");
    expect(appDelegateHalf).toContain("reactNativeFactory = factory");
    expect(appDelegateHalf).toContain("var sceneLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?");
    expect(appDelegateHalf).toContain("sceneLaunchOptions = launchOptions");
  });

  it("starts React Native in a window made from the scene", () => {
    expect(sceneHalf).toContain("let window = UIWindow(windowScene: windowScene)");
    expect(sceneHalf).toContain(
      'factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)',
    );
    expect(sceneHalf).toContain("willConnectTo session: UISceneSession");
  });

  /* Adopting scenes moves these off the app delegate. Unforwarded, every deep link and universal
   * link stops arriving and nothing fails loudly — the app simply never opens what it was sent. */
  it("hands links and activities back to the app delegate", () => {
    expect(sceneHalf).toContain("func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>)");
    expect(sceneHalf).toContain("func scene(_ scene: UIScene, continue userActivity: NSUserActivity)");
    expect(sceneHalf).toContain("appDelegate.application(UIApplication.shared, open: context.url, options: options)");
    expect(sceneHalf).toContain("restorationHandler: { _ in })");
  });

  /* `RCTLinkingManager.getInitialURL` reads the bundle's launch options. Under scenes a cold link
   * arrives in the connection options instead, so it is put back before the bundle starts — the
   * inner key is the literal React Native reads, not a name of our own choosing. */
  it("puts a cold link back where getInitialURL reads it", () => {
    expect(sceneHalf).toContain("launchOptions[.url] = url");
    expect(sceneHalf).toContain('"UIApplicationLaunchOptionsUserActivityKey": activity');
    expect(sceneHalf).toContain("var launchOptions = appDelegate.sceneLaunchOptions ?? [:]");
  });

  it("forwards the four app-lifecycle callbacks UIKit stops sending", () => {
    for (const [scene, app] of [
      ["sceneDidBecomeActive", "applicationDidBecomeActive"],
      ["sceneWillResignActive", "applicationWillResignActive"],
      ["sceneWillEnterForeground", "applicationWillEnterForeground"],
      ["sceneDidEnterBackground", "applicationDidEnterBackground"],
    ]) {
      expect(sceneHalf, `${scene} must reach ${app}`).toContain(`func ${scene}(_ scene: UIScene)`);
      expect(sceneHalf).toContain(`appDelegate?.${app}(UIApplication.shared)`);
    }
  });

  it("is idempotent, so a prebuild over a generated project does not stack scene delegates", () => {
    expect(plugin.adoptSceneLifecycle(generated)).toBe(generated);
    expect(generated.split(plugin.MARKER).length - 1).toBe(2);
  });

  /* A silent no-op here ships an app that traps at launch, so both anchors refuse by name. */
  it("REFUSES a template whose window block has moved", () => {
    const moved = TEMPLATE.replace("window = UIWindow(frame: UIScreen.main.bounds)", "window = makeWindow()");
    expect(moved).not.toBe(TEMPLATE);
    expect(() => plugin.adoptSceneLifecycle(moved)).toThrow(/template changed shape/);
  });

  it("REFUSES a template that keeps no window property to take away", () => {
    const noProperty = TEMPLATE.replace(/^[ \t]*var window: UIWindow\?[ \t]*\n/m, "");
    expect(noProperty).not.toBe(TEMPLATE);
    expect(() => plugin.adoptSceneLifecycle(noProperty)).toThrow(/must not keep the window/);
  });

  it("is registered in app.json, and leaves the backup rules last", () => {
    const names = APP_JSON.expo.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names).toContain("./plugins/with-ios-scene-lifecycle");
    expect(names[names.length - 1], "the backup rules must still win the manifest attribute")
      .toBe("./plugins/backup-exclusions");
  });

  /* Android is untouched BY CONSTRUCTION, and that is a property of this file's imports. */
  it("touches iOS only", () => {
    expect(PLUGIN_SRC).toContain("withAppDelegate");
    expect(PLUGIN_SRC).toContain("withInfoPlist");
    for (const androidMod of [
      "withAndroidManifest", "withMainApplication", "withStringsXml",
      "withGradleProperties", "withProjectBuildGradle", "withAppBuildGradle",
    ]) {
      expect(PLUGIN_SRC, `${androidMod} would put this plugin on the Android side`)
        .not.toContain(androidMod);
    }
  });

  /* The fixture above is SDK 57's template. On an SDK bump it is no longer what prebuild writes,
   * and the anchors may pass over text that has quietly changed meaning — so the bump reddens
   * here and the fixture is re-taken from the new template rather than assumed forward. */
  it("pins the SDK the template fixture was taken from", () => {
    const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.expo, "re-take fixtures/ios/AppDelegate.template-57.swift from the new template")
      .toMatch(/^[~^]?57\./);
  });
});
