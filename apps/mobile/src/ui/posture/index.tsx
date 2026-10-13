/**
 * `usePosture()` — one posture in context, derived by `derive.ts` from what this file collects:
 * the window's dimensions, the native fold reading where the module answers, and the
 * OHMAIL_POSTURE override through its three doors (provider prop, `EXPO_PUBLIC_OHMAIL_POSTURE`,
 * the native launch env) so a test run can drive every pose on any simulator. The provider only
 * collects; every decision is in `derive.ts`. A posture change re-renders, never remounts, so
 * the open message, scroll and focus survive. Beside it: the status cluster the closed Duo's
 * rail starts below, and the `@canvas` door that renders the app root at a pose's own size.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dimensions, Platform, View, useWindowDimensions } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { topInsetWithControls } from "../window-controls";
import {
  derivePosture,
  parsePostureOverride,
  statusClusterOf,
  windowBoundsOf,
  type FoldFeature,
  type PlatformName,
  type Posture,
  type PostureOverride,
  type WindowFrame,
} from "./derive";
import { nativePosture } from "./posture-native";
import { logPostureDerived, logTextScaleRefresh } from "../../engine/engine-log";
import { textEpochOf } from "../../theme/text-scale";
import { TextEpochContext } from "../../theme/text-epoch";

export * from "./derive";

const PostureContext = createContext<Posture | null>(null);

export function usePosture(): Posture {
  const p = useContext(PostureContext);
  if (!p) throw new Error("usePosture() outside <PostureProvider>");
  return p;
}

const platformName: PlatformName = Platform.OS === "ios" ? "ios" : "android";

/** The launch-time override, resolved once — the env doors are stable for the process's life. */
let launchResolved: PostureOverride | null | undefined;
function launchOverride(): PostureOverride | null {
  if (launchResolved !== undefined) return launchResolved;
  const env = process.env.EXPO_PUBLIC_OHMAIL_POSTURE ?? null;
  launchResolved = parsePostureOverride(env) ?? parsePostureOverride(nativePosture()?.getLaunchOverride() ?? null);
  return launchResolved;
}

export function PostureProvider({
  override,
  children,
}: {
  /** Tests and tools force a pose here; the launch doors answer beneath it. */
  override?: PostureOverride | null;
  children: ReactNode;
}) {
  const dims = useWindowDimensions();
  /* undefined = no native answer collected yet; null = the module said the API is absent. */
  const [folds, setFolds] = useState<FoldFeature[] | null>(null);
  const [hasFold, setHasFold] = useState(false);

  useEffect(() => {
    const native = nativePosture();
    if (native === null) return;
    setFolds(native.getFolds());
    setHasFold(native.getHasFold());
    const sub = native.addListener?.("onFoldsChanged", (payload) => setFolds(payload.folds));
    return () => sub?.remove();
  }, []);

  /* THE WINDOW'S FRAME, re-read whenever the window changes size: iOS answers on the main queue,
     Android has no reading, and `null` keeps the width-only one until an answer arrives. */
  const [frame, setFrame] = useState<WindowFrame | null>(null);
  useEffect(() => {
    const native = nativePosture();
    if (native?.getWindowFrame === undefined) return undefined;
    let current = true;
    native.getWindowFrame().then((f) => { if (current) setFrame(f); }, () => { if (current) setFrame(null); });
    return () => { current = false; };
  }, [dims.width, dims.height]);

  const value = useMemo<Posture>(() => {
    const forced = override ?? launchOverride();
    if (forced) {
      return derivePosture({
        platform: forced.platform ?? platformName,
        width: forced.width,
        height: forced.height,
        folds: forced.folds ?? null,
        hasFold: forced.hasFold,
        isPad: forced.isPad,
        windowBounds: forced.windowBounds ?? null,
      });
    }
    /* The side from the platform's frame where it gives one — `windowBoundsOf` decides. */
    const windowBounds = windowBoundsOf(frame, dims, Dimensions.get("screen"));
    return derivePosture({
      platform: platformName,
      width: dims.width,
      height: dims.height,
      folds,
      hasFold,
      isPad: Platform.OS === "ios" && Platform.isPad === true,
      windowBounds,
    });
  }, [override, dims.width, dims.height, folds, hasFold, frame]);

  useEffect(() => {
    logPostureDerived({ width: dims.width, height: dims.height, folds: folds?.length ?? 0, state: value.fold });
  }, [value]);

  /* EVERY WINDOW CHANGE RE-MEASURES THE ROOT: size and density together left the root laid out in
     the old dp (`relayoutRoot`), and the layout derives from the window as it is now. */
  const relaidScale = useRef(dims.scale);
  useEffect(() => {
    /* The screens' frames only after a density change: a size change moves their pixels itself. */
    const densityMoved = relaidScale.current !== dims.scale;
    relaidScale.current = dims.scale;
    nativePosture()?.relayoutRoot?.(densityMoved);
  }, [dims.width, dims.height, dims.scale, dims.fontScale]);

  /* AND EVERY TEXT IS MEASURED AGAIN after a density or text-size change (`textEpochOf`): the epoch is
     set from an effect, so the render that moves every text's cap follows the root measure above. */
  const [textEpoch, setTextEpoch] = useState(0);
  const textMetrics = useRef({ scale: dims.scale, fontScale: dims.fontScale });
  useEffect(() => {
    const prev = textMetrics.current;
    const next = { scale: dims.scale, fontScale: dims.fontScale };
    textMetrics.current = next;
    if (textEpochOf(0, prev, next) === 0) return undefined;
    /* iOS: the surface reads the text size again first, so the pass below measures in it. */
    let current = true;
    const bump = () => { if (current) setTextEpoch((e) => e + 1); };
    const posture = nativePosture();
    if (posture?.refreshTextScale === undefined) bump();
    else posture.refreshTextScale().then((r) => { logTextScaleRefresh(r, next.fontScale); bump(); }, bump);
    return () => { current = false; };
  }, [dims.scale, dims.fontScale]);

  return (
    <PostureContext.Provider value={value}>
      <TextEpochContext.Provider value={textEpoch}>{children}</TextEpochContext.Provider>
    </PostureContext.Provider>
  );
}


/* ─────────────────────────────────── the canvas door ────────────────────────────────────── */

const CanvasContext = createContext<{ width: number; height: number } | null>(null);

/** The window the layout is laid in — the canvas's size under `@canvas`, else the device's. */
export function useAppWindow(): { width: number; height: number } {
  const canvas = useContext(CanvasContext);
  const dims = useWindowDimensions();
  return canvas ?? { width: dims.width, height: dims.height };
}

/** The pose's own safe areas inside a canvas: the prototype's device table (Duo t14 · b34). */
const CANVAS_INSETS: Record<PlatformName, { top: number; right: number; bottom: number; left: number }> = {
  ios: { top: 14, right: 0, bottom: 34, left: 0 },
  android: { top: 0, right: 0, bottom: 24, left: 0 },
};

/**
 * `<pose>@canvas`: the app root at the pose's width × height, scaled to fit the real window and
 * centred on black, with the pose's safe areas in place of the device's. Sheets are Modals and
 * keep the window; everything laid out by `useAppWindow()` and the safe areas follows the pose.
 * Without the flag this renders its children alone.
 */
export function PostureCanvas({ children }: { children: ReactNode }) {
  const dims = useWindowDimensions();
  const forced = launchOverride();
  if (forced === null || forced.canvas !== true) return <>{children}</>;
  const w = forced.width;
  const h = forced.height;
  const scale = Math.min(dims.width / w, dims.height / h, 1);
  const insets = forced.insets ?? CANVAS_INSETS[forced.platform ?? platformName];
  return (
    <View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: w, height: h, overflow: "hidden", transform: [{ scale }] }}>
        <CanvasContext.Provider value={{ width: w, height: h }}>
          <SafeAreaInsetsContext.Provider value={insets}>
            <>{children}</>
          </SafeAreaInsetsContext.Provider>
        </CanvasContext.Provider>
      </View>
    </View>
  );
}

/* ────────────────────────────────── the status cluster ──────────────────────────────────── */

let clusterResolved: { bottom: number } | null | undefined;

/**
 * The closed Duo's status cluster — the status bar's frame read once from the module and kept
 * only where it is a right-strip cluster, not a top bar (`statusClusterOf`). Null inside a
 * canvas (the simulated face has none) and wherever the module or the shape says no.
 */
export function useStatusCluster(): { bottom: number } | null {
  const canvas = useContext(CanvasContext);
  const dims = useWindowDimensions();
  const [cluster, setCluster] = useState<{ bottom: number } | null>(clusterResolved ?? null);
  useEffect(() => {
    if (canvas !== null || clusterResolved !== undefined) return;
    const read = nativePosture()?.getStatusCluster?.();
    if (read === undefined) {
      clusterResolved = null;
      return;
    }
    let live = true;
    read
      .then((frame) => {
        clusterResolved = statusClusterOf(frame, dims.width);
        if (live) setCluster(clusterResolved);
      })
      .catch(() => {
        clusterResolved = null;
      });
    return () => {
      live = false;
    };
  }, [canvas, dims.width]);
  return canvas !== null ? null : cluster;
}

/* ─────────────────────────────── the iPad's window controls ─────────────────────────────── */

/**
 * Every reader of the safe area below this sees the iPad's window controls as top inset, so the
 * bars, the list heads and the sheets clear them without a rule of their own (`window-controls.ts`).
 */
export function WindowControlsInsets({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const dims = useWindowDimensions();
  const screen = Dimensions.get("screen");
  const isPad = Platform.OS === "ios" && Platform.isPad === true;
  /* The controls' edge as the system reads it, again on every window size and safe-area change. */
  const [controlsTop, setControlsTop] = useState<number | null>(null);
  useEffect(() => {
    const posture = isPad ? nativePosture() : null;
    if (posture?.getWindowControlsInset === undefined) return undefined;
    let current = true;
    posture.getWindowControlsInset().then((v) => { if (current) setControlsTop(typeof v === "number" ? v : null); }, () => { if (current) setControlsTop(null); });
    return () => { current = false; };
  }, [isPad, dims.width, dims.height, insets.top]);
  const top = topInsetWithControls(insets.top, {
    isPad,
    window: { width: dims.width, height: dims.height },
    screen: { width: screen.width, height: screen.height },
  }, controlsTop);
  const value = useMemo(() => ({ ...insets, top }), [insets, top]);
  /* Always the provider, so a window entering Split View re-renders and never remounts. */
  return <SafeAreaInsetsContext.Provider value={value}>{children}</SafeAreaInsetsContext.Provider>;
}
