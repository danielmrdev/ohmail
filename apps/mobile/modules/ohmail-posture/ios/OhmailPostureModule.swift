import ExpoModulesCore
import Network
import UIKit
import os

/**
 * The iOS half of the posture pair. `getHasFold` names the hardware: the iPhone Duo by its
 * model identifier (`hw.machine` on a device, `SIMULATOR_MODEL_IDENTIFIER` on the simulator) —
 * the door that sends the navigation to the right-edge rail on the closed face, which a
 * literal `false` here kept shut on the real device. `getStatusCluster` reads the status bar's
 * frame, the closed face's right-strip cluster the rail starts below. `getFolds` still answers
 * nil: the fold's reserved-region read is newer than every toolchain this repo compiled
 * against, and `derive.ts` covers the open face with the centre-hinge heuristic meanwhile.
 * `refreshTextScale` asks React Native's surface to read the text size again after a change.
 * `getWindowControlsInset` reads the safe area adapted around the window's controls (iPadOS 26).
 * `getLaunchOverride` is the simulator door (`SIMCTL_CHILD_OHMAIL_POSTURE=<pose>[@canvas]`).
 * The network door's reader lives here too (`src/net/network-door.ts`): a path monitor answers
 * "online" or "offline" through `getNetwork`, "unknown" before its first path, and sends
 * `onNetworkChanged` on each change. The state is read and written under one lock.
 */
public class OhmailPostureModule: Module {
  /** Apple's model identifiers for the iPhone Duo (iPhone19,4 read on the 27.1 simulator). */
  private static let duoModels: Set<String> = ["iPhone19,4", "iPhone19,5"]

  private var monitor: NWPathMonitor?
  private let networkLock = NSLock()
  private var network = "unknown"

  private func readNetwork() -> String {
    networkLock.lock()
    defer { networkLock.unlock() }
    return network
  }

  /** Stores the reading and answers whether it changed. */
  private func storeNetwork(_ next: String) -> Bool {
    networkLock.lock()
    defer { networkLock.unlock() }
    if next == network { return false }
    network = next
    return true
  }

  private static func modelIdentifier() -> String {
    if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !sim.isEmpty {
      return sim
    }
    var sys = utsname()
    uname(&sys)
    return withUnsafePointer(to: &sys.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { String(cString: $0) }
    }
  }

  /**
   * The mail frame's process memory in bytes (`processMemoryHeap` in `src/mail/frame-ceiling.ts` maps it):
   * what this process may still allocate before its limit (`os_proc_available_memory`, 0 on the
   * simulator, which has none), what it holds now (`phys_footprint`, the figure that limit is charged
   * against), and the device's physical memory. Their sum is the limit, fixed for the process.
   */
  private static func processMemory() -> [String: Double] {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    let footprint = kr == KERN_SUCCESS ? Double(info.phys_footprint) : -1
    return [
      "available": Double(os_proc_available_memory()),
      "footprint": footprint,
      "physical": Double(ProcessInfo.processInfo.physicalMemory),
    ]
  }

  private static func isDuo() -> Bool {
    if duoModels.contains(modelIdentifier()) { return true }
    let name = ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? ""
    return name.localizedCaseInsensitiveContains("iPhone Duo")
  }

  public func definition() -> ModuleDefinition {
    Name("OhmailPosture")
    Events("onFoldsChanged", "onNetworkChanged")

    OnCreate {
      let m = NWPathMonitor()
      m.pathUpdateHandler = { [weak self] path in
        guard let self = self else { return }
        let state = path.status == .satisfied ? "online" : "offline"
        if self.storeNetwork(state) {
          self.sendEvent("onNetworkChanged", ["state": state])
        }
      }
      m.start(queue: DispatchQueue(label: "app.ohmail.network"))
      self.monitor = m
    }

    OnDestroy {
      self.monitor?.cancel()
      self.monitor = nil
    }

    Function("getNetwork") { () -> String in
      return self.readNetwork()
    }

    Function("getFolds") { () -> [[String: Any]]? in
      return nil
    }

    Function("getHasFold") { () -> Bool in
      return OhmailPostureModule.isDuo()
    }

    Function("getProcessMemory") { () -> [String: Double] in
      return OhmailPostureModule.processMemory()
    }

    Function("getModelIdentifier") { () -> String in
      return OhmailPostureModule.modelIdentifier()
    }

    // The status bar's frame in window points — on the closed Duo the cluster in the right
    // strip; nil where no scene answers (app not yet in the foreground) or the frame is empty.
    // Async so it can run on the main queue, where UIKit's scenes are read.
    AsyncFunction("getStatusCluster") { () -> [String: Double]? in
      guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
        ?? UIApplication.shared.connectedScenes.first as? UIWindowScene,
        let bar = scene.statusBarManager else { return nil }
      let f = bar.statusBarFrame
      if f.width <= 0 || f.height <= 0 { return nil }
      return ["x": f.origin.x, "y": f.origin.y, "width": f.width, "height": f.height]
    }.runOnQueue(.main)

    // The key window's frame in its screen's coordinate space, and the screen's width — which
    // half a split window is in (`windowBoundsOf` in derive.ts). Main queue, for the reason above.
    AsyncFunction("getWindowFrame") { () -> [String: Double]? in
      guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
        ?? UIApplication.shared.connectedScenes.first as? UIWindowScene,
        let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return nil }
      let screen = scene.screen.bounds
      let frame = window.convert(window.bounds, to: scene.screen.coordinateSpace)
      if frame.width <= 0 || screen.width <= 0 { return nil }
      return ["x": Double(frame.origin.x), "w": Double(frame.width), "screenW": Double(screen.width)]
    }.runOnQueue(.main)

    // THE TOP INSET THAT CLEARS THE WINDOW'S OWN CONTROLS: the safe area adapted at its corners
    // (iPadOS 26's window controls), read from the key window's root view in window points. Nil
    // before iOS 26, where no window answers, or where the read is not a number.
    AsyncFunction("getWindowControlsInset") { () -> Double? in
      guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
        ?? UIApplication.shared.connectedScenes.first as? UIWindowScene,
        let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return nil }
      let view: UIView = window.rootViewController?.view ?? window
      if #available(iOS 26.0, *) {
        let top = view.edgeInsets(for: .safeArea(cornerAdaptation: .vertical)).top
        return top.isFinite && top >= 0 ? Double(top) : nil
      }
      return nil
    }.runOnQueue(.main)

    // THE SURFACE TAKES THE TEXT SIZE THE APP NOW HAS. React Native's surface re-reads the text size
    // when the system says it changed; this asks it again, after that notification has been handled, so
    // the size it lays text out at is the one the app reads now. Answers the size it read and how many
    // surfaces it asked (0 where none answers).
    AsyncFunction("refreshTextScale") { () -> [String: Any] in
      let category = UIApplication.shared.preferredContentSizeCategory.rawValue
      let surfaceSel = NSSelectorFromString("surface")
      let handleSel = NSSelectorFromString("handleContentSizeCategoryDidChangeNotification:")
      var asked = 0
      for scene in UIApplication.shared.connectedScenes {
        guard let windowScene = scene as? UIWindowScene else { continue }
        for window in windowScene.windows {
          var level: [UIView] = [window]
          for _ in 0..<4 {
            var next: [UIView] = []
            for view in level {
              if view.responds(to: surfaceSel),
                let surface = view.perform(surfaceSel)?.takeUnretainedValue() as? NSObject,
                surface.responds(to: handleSel) {
                surface.perform(handleSel, with: nil)
                asked += 1
              } else {
                next.append(contentsOf: view.subviews)
              }
            }
            level = next
          }
        }
      }
      return ["category": category, "surfaces": asked]
    }.runOnQueue(.main)

    Function("getLaunchOverride") { () -> String? in
      return ProcessInfo.processInfo.environment["OHMAIL_POSTURE"]
    }
  }
}
