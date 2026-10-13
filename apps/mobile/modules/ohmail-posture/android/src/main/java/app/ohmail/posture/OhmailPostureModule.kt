package app.ohmail.posture

import android.app.ActivityManager
import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.os.Build
import android.view.ViewTreeObserver
import android.view.WindowInsets
import android.view.inputmethod.InputMethodManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import com.swmansion.rnscreens.Screen
import com.swmansion.rnscreens.ScreenStack
import com.swmansion.rnscreens.bottomsheet.usesFormSheetPresentation
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * The Android fold reading — Jetpack WindowManager's FoldingFeatures, mapped verbatim to the
 * JS `FoldFeature` shape (`src/ui/posture/derive.ts`): bounds in dp, HALF_OPENED -> "half",
 * FLAT -> "flat", occlusionType FULL -> "full" (a hard hinge, the Surface Duo 2). The
 * collector runs while an activity is foregrounded and every change is an `onFoldsChanged`
 * event; `getFolds` answers the last reading synchronously, `getHasFold` whether this device
 * ever reported a fold, and `getLaunchOverride` a test run's intent extra
 * (`adb shell am start … --es OHMAIL_POSTURE <pose>`) or process env.
 *
 * The network door's reader (`src/net/network-door.ts`) lives here too, so no second module ships:
 * `getNetwork` answers "online" or "offline" from the default network's INTERNET capability, and a
 * default-network callback sends `onNetworkChanged`. Any failure answers "unknown", never a throw.
 */
/** React's root, by class name: the root view classes are react-android's internals. */
private val REACT_ROOTS = setOf("com.facebook.react.runtime.ReactSurfaceView", "com.facebook.react.ReactRootView")

private fun isReactRoot(v: View): Boolean {
  var c: Class<*>? = v.javaClass
  while (c != null) {
    if (c.name in REACT_ROOTS) return true
    c = c.superclass
  }
  return false
}

/** How many times a keyboard is asked for while the window reads it as hidden, and how far apart. */
private const val KEYBOARD_ASKS = 3
private const val KEYBOARD_ASK_MS = 400L

/**
 * The keyboard for a field still holding the caret, asked of the input method for that field. Where
 * the window can say (Android 11+), its insets then tell whether the keyboard is up, and an ask the
 * input method dropped is made again, a few times; it never asks for a field that let the caret go.
 */
private fun askForKeyboard(view: View, attempt: Int) {
  if (!view.isAttachedToWindow || !view.isFocused || !view.hasWindowFocus()) return
  (view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(view, 0)
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || attempt + 1 >= KEYBOARD_ASKS) return
  view.postDelayed({
    if (view.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) != true) askForKeyboard(view, attempt + 1)
  }, KEYBOARD_ASK_MS)
}

class OhmailPostureModule : Module() {
  private var job: Job? = null
  private var lastFolds: List<Map<String, Any?>> = emptyList()
  private var sawAnyFold = false
  private var netCallback: ConnectivityManager.NetworkCallback? = null

  private fun connectivity(): ConnectivityManager? =
    appContext.reactContext?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

  /**
   * The mail frame's length ceiling reads the app's heap here (`src/mail/frame-ceiling.ts`):
   * `getMemoryClass` is `ActivityManager.memoryClass` in MB, `isLowRamDevice` the platform's flag.
   * With no ActivityManager they answer 0 and true, which the JS takes as the floor.
   */
  private fun activityManager(): ActivityManager? =
    appContext.reactContext?.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager

  private fun networkState(): String = try {
    val cm = connectivity()
    if (cm == null) "unknown" else {
      val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
      if (caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) "online" else "offline"
    }
  } catch (e: Exception) {
    "unknown"
  }

  /** Only a change crosses to JS: capabilities move on every signal-strength step. */
  @Volatile private var lastNetwork: String? = null

  private fun sendNetwork(state: String) {
    if (state == lastNetwork) return
    lastNetwork = state
    sendEvent("onNetworkChanged", mapOf("state" to state))
  }

  private fun featureMap(f: FoldingFeature, density: Float): Map<String, Any?> = mapOf(
    "bounds" to mapOf(
      "x" to f.bounds.left / density,
      "y" to f.bounds.top / density,
      "w" to f.bounds.width() / density,
      "h" to f.bounds.height() / density,
    ),
    "state" to if (f.state == FoldingFeature.State.HALF_OPENED) "half" else "flat",
    "orientation" to if (f.orientation == FoldingFeature.Orientation.VERTICAL) "vertical" else "horizontal",
    "occlusion" to if (f.occlusionType == FoldingFeature.OcclusionType.FULL) "full" else "none",
  )

  override fun definition() = ModuleDefinition {
    Name("OhmailPosture")
    Events("onFoldsChanged", "onNetworkChanged")

    Function("getNetwork") { networkState() }
    Function("getFolds") { lastFolds }
    Function("getHasFold") { sawAnyFold }
    Function("getMemoryClass") { activityManager()?.memoryClass ?: 0 }
    Function("isLowRamDevice") { activityManager()?.isLowRamDevice ?: true }
    /*
     * THE ROOT LAYS OUT IN THE CURRENT DENSITY. A size and a density change arriving together left
     * React's root laid out in the OLD dp at the NEW density (the second change moved no pixel, so
     * nothing measured again). The provider asks for this on every window change; the forced
     * measure hands the surface the current density; after a density change (`screens`), each native
     * stack screen its frame in it too. Idempotent.
     */
    Function("relayoutRoot") { screens: Boolean ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread {
        val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return@runOnUiThread
        val queue = ArrayDeque<View>(listOf(content))
        while (queue.isNotEmpty()) {
          val v = queue.removeFirst()
          if (isReactRoot(v)) {
            v.forceLayout()
            v.requestLayout()
          }
          /* A native stack screen sends its frame to React in dp only when its pixels move, so a density
             change alone left every pushed screen laid out in the old dp, past the window. It sends it
             again here, in the density it now has, as its own layout would. */
          if (screens && v is Screen && v.isAttachedToWindow && v.container is ScreenStack && !v.usesFormSheetPresentation()) {
            v.updateState(v.width, v.height, v.top)
          }
          if (v is ViewGroup) for (i in 0 until v.childCount) queue.addLast(v.getChildAt(i))
        }
      }
      true
    }
    /*
     * THE KEYBOARD COMES BACK WITH THE CARET. A field focused in a dialog window that has no input focus
     * yet (a redraw's new window, measured: served view null, mInputShown=false) asks for the keyboard
     * too early and nothing answers. The request waits for that window's focus and is made then, for
     * the field still holding the caret only.
     */
    AsyncFunction("showKeyboardWhenFocused") { viewTag: Int ->
      val view = appContext.findView<View>(viewTag) ?: return@AsyncFunction false
      if (view.hasWindowFocus()) {
        askForKeyboard(view, 0)
      } else if (view.viewTreeObserver.isAlive) {
        view.viewTreeObserver.addOnWindowFocusChangeListener(object : ViewTreeObserver.OnWindowFocusChangeListener {
          override fun onWindowFocusChanged(hasFocus: Boolean) {
            if (!hasFocus) return
            view.viewTreeObserver.removeOnWindowFocusChangeListener(this)
            view.post { askForKeyboard(view, 0) }
          }
        })
      }
      true
    }.runOnQueue(Queues.MAIN)
    Function("getLaunchOverride") {
      appContext.currentActivity?.intent?.getStringExtra("OHMAIL_POSTURE")
        ?: System.getenv("OHMAIL_POSTURE")
    }

    OnCreate {
      val cm = connectivity() ?: return@OnCreate
      val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { sendNetwork(networkState()) }
        override fun onLost(network: Network) { sendNetwork("offline") }
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
          sendNetwork(if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) "online" else "offline")
        }
      }
      try {
        cm.registerDefaultNetworkCallback(callback)
        netCallback = callback
      } catch (e: Exception) {
        netCallback = null
      }
    }

    OnDestroy {
      val callback = netCallback ?: return@OnDestroy
      try { connectivity()?.unregisterNetworkCallback(callback) } catch (e: Exception) { }
      netCallback = null
    }

    OnActivityEntersForeground {
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      if (job != null) return@OnActivityEntersForeground
      job = CoroutineScope(Dispatchers.Main).launch {
        WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { info ->
          val folds = info.displayFeatures.filterIsInstance<FoldingFeature>()
          if (folds.isNotEmpty()) sawAnyFold = true
          /* The density of THIS reading: one read at foreground put a hinge in old dp after a
             density change. */
          val density = activity.resources.displayMetrics.density
          lastFolds = folds.map { featureMap(it, density) }
          sendEvent("onFoldsChanged", mapOf("folds" to lastFolds))
        }
      }
    }

    OnActivityDestroys {
      job?.cancel()
      job = null
    }
  }
}
