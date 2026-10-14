// ohmail in the Omarchy bar.
//
// ── WHAT THIS WIDGET KNOWS, AND HOW IT KNOWS IT ───────────────────────────────
//
// It draws a number it is TOLD. It does not read your mail, it holds no
// credentials, and it opens no network connection — every count comes from one
// of two places, and both of them are outside this file:
//
//   · a PUSH over IPC — `omarchy-shell ohmail.mail setUnread 7`.
//     Exact, instant, and the path anything with a real answer should use.
//   · a POLL of `bin/ohmail-unread`, on a timer. That script explains its own
//     sources; the short version is that it reads a count somebody else wrote,
//     or runs a command you gave it, and otherwise answers "unknown".
//
// "Unknown" is a state this widget renders, not an error it hides: a dimmed
// envelope with NO number, and a tooltip that says so. It never draws a zero it
// cannot stand behind, because a zero in the bar is a claim — "you have no
// unread mail" — and this widget is only ever as truthful as its source.
//
// Pressing it summons ohmail (`bin/ohmail-summon`: focus the window if it is
// already running, launch it if not). Right-press refreshes.

import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "ohmail.mail"

  // NOT `state`: QtQuick's Item already owns that name for its state groups,
  // and shadowing it is the kind of thing that half-works.
  property string sourceState: "unknown"
  property int unread: 0
  property string why: "no source configured"

  // The plugin's own directory, resolved from this file's URL. A third-party
  // plugin's scripts are not on PATH, so every command below is addressed
  // absolutely; `Qt.resolvedUrl` is relative to this QML file wherever the
  // plugin happens to have been cloned.
  readonly property string binDir: Qt.resolvedUrl("bin/").toString().replace(/^file:\/\//, "")

  // An envelope always; a number only when there is one to show. Note what is
  // absent: at a known zero this renders the envelope alone rather than "0",
  // because "0" and "I don't know" must not look the same in a bar.
  // \uf0e0 is the Nerd Font envelope, spelled as an escape rather than pasted
  // as a literal: it lives in the private use area, where a byte-level accident
  // in any tool between here and the shell would be invisible in a diff.
  readonly property string display: "\uf0e0"
    + (sourceState === "ok" && unread > 0 ? "  " + unread : "")

  function refresh() {
    if (unreadProc.running) return
    unreadProc.stale = false
    unreadProc.running = true
  }

  // A pushed count is authoritative: it came from something that actually
  // knows. It also restarts the poll timer, so a poll answering "unknown"
  // cannot immediately erase a number just handed to us.
  function adopt(count) {
    // The WHOLE argument has to be a count, not merely start with one.
    // `parseInt("7junk")` and `parseInt("7.5")` both answer 7, so parsing alone
    // would have accepted values the README promises are ignored — the widget
    // would then be showing a number derived from something malformed, which is
    // the same sin as inventing one.
    if (!/^[0-9]{1,9}$/.test(String(count))) return
    root.sourceState = "ok"
    root.unread = parseInt(count, 10)
    root.why = "pushed over IPC"

    // A POLL MAY ALREADY BE IN FLIGHT, and restarting the timer does not reach
    // it: its `onStreamFinished` would land a moment later and overwrite the
    // number just pushed with whatever the file said. So the running poll is
    // disowned here and its result dropped when it arrives.
    unreadProc.stale = true
    pollTimer.restart()
  }

  // `broadcast` from the base class, but carrying an argument.
  //
  // An IPC target routes to exactly ONE handler, while a bar widget is
  // instantiated once per bar surface — so a handler that calls
  // `root.something()` directly reaches the instance that happens to own the
  // target and leaves every other screen stale. That is what the base class's
  // `broadcast` is for, and `refresh` uses it. `broadcast` takes no arguments,
  // so a pushed COUNT needs the same loop with one, which is this.
  //
  // (An aside worth writing down, because it cost an hour of the drill: while
  // iterating, `setUnread` appeared to do nothing at all while `refresh` worked.
  // It was not this code — reinstalling the plugin repeatedly leaves Omarchy's
  // hot-reload with an older widget instance still drawing, and pushes land on
  // the newer one nobody can see. `omarchy-restart-shell` and it was correct
  // first try. Verified with a console.log probe on both paths.)
  function relay(method, arg) {
    var items = root.bar && typeof root.bar.moduleWidgets === "function"
      ? root.bar.moduleWidgets(root.moduleName) : [root]
    for (var i = 0; i < items.length; i++) {
      if (items[i] && typeof items[i][method] === "function") items[i][method](arg)
    }
  }

  function summon() {
    if (root.bar) root.bar.run(root.binDir + "ohmail-summon")
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  IpcHandler {
    // IPC arguments are strings on this surface — QML's IPC is string-only —
    // so the count arrives as text and `adopt` parses it.
    target: "ohmail.mail"

    function refresh(): void { root.broadcast("refresh") }
    function setUnread(count: string): void { root.relay("adopt", count) }
    // `open` is the one that does not relay: summoning a window is a single
    // action, and doing it once per monitor would race the compositor with
    // itself.
    function open(): void { root.summon() }
  }

  Process {
    id: unreadProc
    // Set by `adopt` when a push overtakes a poll that is already running. The
    // poll is not cancellable mid-flight, so its answer is dropped on arrival
    // instead — see `adopt`.
    property bool stale: false
    // The `command` setting travels as argv rather than as an environment
    // variable, so what ran is visible in `ps` and reproducible by hand.
    command: [root.binDir + "ohmail-unread", "--command", String(root.setting("command", ""))]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (unreadProc.stale) {
          unreadProc.stale = false
          return
        }
        // A source that answers nothing, or answers something unparseable, is
        // "unknown" — the same state as no source at all. It is not an error
        // worth a dialog and it must not become a number.
        var next = { state: "unknown", why: "the count source answered nothing" }
        try {
          var parsed = JSON.parse(text)
          if (parsed && typeof parsed === "object") next = parsed
        } catch (e) {
          next = { state: "unknown", why: "the count source did not answer JSON" }
        }
        root.sourceState = next.state === "ok" ? "ok" : "unknown"
        root.unread = root.sourceState === "ok" ? (parseInt(next.unread, 10) || 0) : 0
        root.why = next.why ? String(next.why) : ""
      }
    }
  }

  Timer {
    id: pollTimer
    interval: Math.max(5000, root.setting("intervalMs", 60000))
    running: true
    repeat: true
    // NOT triggeredOnStart, and the reason is a bug that was watched happen:
    // `restart()` on a triggeredOnStart timer fires `triggered` IMMEDIATELY as
    // well as rescheduling. `adopt()` restarts this timer to hold the next poll
    // off for one interval — so with triggeredOnStart the poll it was deferring
    // ran instantly and overwrote the number that had just been pushed in. The
    // badge showed the file's 7 a moment after being told 12, which looks like
    // the IPC not working at all. The first poll is asked for explicitly below.
    onTriggered: root.refresh()
  }

  Component.onCompleted: root.refresh()

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.display
    // The one place the unknown state is visible: the envelope goes quiet and
    // says why on hover, rather than the widget disappearing (a widget you just
    // enabled and cannot find is worse than one that admits it knows nothing).
    dimmed: root.sourceState !== "ok"
    tooltipText: root.sourceState === "ok"
      ? (root.unread > 0 ? root.unread + " unread" : "No unread mail")
      : "ohmail: " + root.why
    horizontalMargin: 8.75

    onPressed: function(b) {
      if (b === Qt.RightButton) root.refresh()
      else root.summon()
    }
  }
}
