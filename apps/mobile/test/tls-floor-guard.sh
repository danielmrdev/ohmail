#!/usr/bin/env bash
# THE TLS FLOOR'S SELF-CHECK, EXERCISED — not read.
#
# `applyTlsFloor` in the Android half of the tcp-socket patch narrows which TLS protocols a socket
# will negotiate. The mistake it exists to prevent is filtering the platform's SUPPORTED list
# instead of its ENABLED one: the platform supports TLS 1.0 and 1.1 and deliberately leaves them
# off, so a floor of "TLSv1" — an option that can only ever narrow — switched two dead protocols
# back on. No dial to a real server shows it, because the handshake still picks the best version
# both sides offer.
#
# This runs the patch's OWN method text on a real JVM socket, three ways:
#
#   A  as shipped                     -> must not throw, and must only ever narrow
#   B  with the defect reintroduced   -> must throw, naming the protocol it turned back on
#   C  the defect, checked the old way -> must NOT throw, which is why B's assertion had to exist
#
# C is the point. Without it, B passing would only show that some assertion fires, not that the
# assertion added is the one that had to be added.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

JAVAC=""
for c in "${JAVA_HOME:-}/bin/javac" "$HOME/Android/jdk-17/bin/javac" "$(command -v javac || true)"; do
  [ -n "$c" ] && [ -x "$c" ] && { JAVAC="$c"; break; }
done
# A MISSING JDK IS A REFUSAL, NOT A SKIP. A guard that quietly passes when it could not run is
# indistinguishable from one that ran and found nothing.
[ -n "$JAVAC" ] || { echo "FAIL: no JDK found; set JAVA_HOME. This guard compiles Java and cannot be skipped."; exit 1; }
JAVA="$(dirname "$JAVAC")/java"

# WHICH COPY. The store holds one directory per patch this package has ever had — four, at the time
# of writing — and all but one are stale. Picking the first match off the filesystem grades whichever
# happens to sort first, which is how six device checks once passed against unpatched code. Resolve
# the copy the mobile app actually links, the same one Android autolinking compiles.
PKG="$(cd "$ROOT/apps/mobile" && node -e "console.log(require.resolve('react-native-tcp-socket/package.json'))" 2>/dev/null || true)"
[ -n "$PKG" ] || { echo "FAIL: apps/mobile cannot resolve react-native-tcp-socket; install the workspace's dependencies"; exit 1; }
SRC="$(dirname "$PKG")/android/src/main/java/com/asterinet/react/tcpsocket/TcpSocketClient.java"
[ -f "$SRC" ] || { echo "FAIL: no TcpSocketClient.java under $(dirname "$PKG")"; exit 1; }

# And that copy must carry THIS patch, not an older one. pnpm names the store directory after the
# patch file's hash, so a stale link is visible without trusting the file's contents to say so.
WANT="$(sha256sum "$ROOT/patches/react-native-tcp-socket@6.4.2.patch" | cut -c1-40)"
case "$(readlink -f "$SRC")" in
  *"$WANT"*) : ;;
  *) echo "FAIL: apps/mobile links a copy built from a different patch."
     echo "  wanted patch hash $WANT"
     echo "  resolved          $(readlink -f "$SRC")"
     echo "  install the workspace's dependencies"; exit 1;;
esac
# The installed copy must be the PATCHED one, or this guard grades upstream code.
grep -q "wasEnabled" "$SRC" || { echo "FAIL: $SRC carries no patch; install the workspace's dependencies"; exit 1; }

# Lift the method out of the source rather than restating it, so this guard cannot drift from the
# code it grades.
python3 - "$SRC" "$WORK" <<'PY'
import sys
src, work = sys.argv[1], sys.argv[2]
s = open(src).read()
start = s.index("    private void applyTlsFloor(")
i = s.index("{", start); depth = 0
for j in range(i, len(s)):
    if s[j] == "{": depth += 1
    elif s[j] == "}":
        depth -= 1
        if depth == 0: end = j + 1; break
method = s[start:end]

# B: put the original defect back — filter the SUPPORTED list, leaving the snapshot as it was.
defect = method.replace("for (final String proto : wasEnabled) {",
                        "for (final String proto : s.getSupportedProtocols()) {")
assert defect != method, "the loop this guard reintroduces the defect into has moved"
# C: the same defect, checked the way it was checked before the membership assertion existed.
old_check = defect.replace("""            if (!wasEnabled.contains(enabled)) {""", """            if (false) {""")
assert old_check != defect, "the membership assertion this guard removes has moved"

harness = """import java.util.Arrays;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

interface ReadableMap { boolean hasKey(String k); String getString(String k); }

public class FloorGuard {
    static class Opts implements ReadableMap {
        private final String min;
        Opts(String min) { this.min = min; }
        public boolean hasKey(String k) { return "minVersion".equals(k) && min != null; }
        public String getString(String k) { return min; }
    }

%s

%s

%s

    private static SSLSocket socket() throws Exception {
        return (SSLSocket) SSLSocketFactory.getDefault().createSocket();
    }

    public static void main(String[] args) throws Exception {
        // "TLSv1" is the floor that exposes the difference: the platform supports TLS 1.0 and 1.1
        // and does not enable them, so filtering the supported list widens the set here and
        // nowhere else. With a modern floor the two readings agree and prove nothing.
        final String floor = "TLSv1";
        SSLSocket probe = socket();
        java.util.List<String> enabled = Arrays.asList(probe.getEnabledProtocols());
        java.util.List<String> supported = Arrays.asList(probe.getSupportedProtocols());
        System.out.println("enabled=" + enabled);
        System.out.println("supported=" + supported);
        // If this JVM enables everything it supports, the difference under test does not exist here
        // and a pass would mean nothing.
        if (supported.size() <= enabled.size()) {
            System.out.println("FAIL: this JVM enables every protocol it supports; the guard cannot tell the two readings apart");
            System.exit(1);
        }

        SSLSocket a = socket();
        try {
            new FloorGuard().applyTlsFloor(a, new Opts(floor));
            java.util.List<String> after = Arrays.asList(a.getEnabledProtocols());
            if (!enabled.containsAll(after)) {
                System.out.println("FAIL A: as shipped, the floor widened the enabled set to " + after);
                System.exit(1);
            }
            System.out.println("A ok: narrowed to " + after);
        } catch (Exception e) {
            System.out.println("FAIL A: as shipped, the floor threw " + e);
            System.exit(1);
        }

        SSLSocket b = socket();
        try {
            new FloorGuard().applyTlsFloorWithDefect(b, new Opts(floor));
            System.out.println("FAIL B: the defect was accepted; enabled is now " + Arrays.asList(b.getEnabledProtocols()));
            System.exit(1);
        } catch (IllegalStateException e) {
            if (!e.getMessage().contains("turned") || !e.getMessage().contains("back on")) {
                System.out.println("FAIL B: threw, but not on the membership assertion: " + e.getMessage());
                System.exit(1);
            }
            System.out.println("B ok: " + e.getMessage());
        }

        SSLSocket c = socket();
        try {
            new FloorGuard().applyTlsFloorOldCheck(c, new Opts(floor));
            java.util.List<String> after = Arrays.asList(c.getEnabledProtocols());
            if (enabled.containsAll(after)) {
                System.out.println("FAIL C: the old check was asked to grade the defect and the defect did not occur");
                System.exit(1);
            }
            System.out.println("C ok: the old check passed the defect, enabling " + after);
        } catch (Exception e) {
            System.out.println("FAIL C: the old check caught the defect, so the new assertion was not needed: " + e);
            System.exit(1);
        }

        System.out.println("ALL OK");
    }
}
""" % (method,
       defect.replace("private void applyTlsFloor(", "private void applyTlsFloorWithDefect(", 1),
       old_check.replace("private void applyTlsFloor(", "private void applyTlsFloorOldCheck(", 1))
open(work + "/FloorGuard.java", "w").write(harness)
PY

"$JAVAC" -nowarn -d "$WORK" "$WORK/FloorGuard.java"
OUT="$("$JAVA" -cp "$WORK" FloorGuard)"; RC=$?
echo "$OUT"
[ $RC -eq 0 ] || exit 1
case "$OUT" in *"ALL OK"*) echo "PASS: the floor narrows, the defect is refused, and the old check could not see it";; *) echo "FAIL: no verdict"; exit 1;; esac
