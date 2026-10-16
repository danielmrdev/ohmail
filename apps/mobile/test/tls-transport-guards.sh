#!/usr/bin/env bash
#
# tls-transport-guards.sh — the properties of the phone's TLS transport that only a device can
# demonstrate, as a script, because a note in a patch file is not a guard.
#
# DEVICE-ONLY. Nothing here runs in the suite: every property is about a native socket
# implementation, and the only way to know it holds is to dial a real server from a real build.
#
# RUN THIS AFTER ANY UPGRADE OF `react-native-tcp-socket`. The behaviour comes from a patch we
# carry (`patches/README.md`), and an upgrade silently drops a patch that no longer applies — at
# which point mail still flows, TLS still "works", and the certificate stops being checked. That
# failure has no other symptom. This is the symptom.
#
# ── THE FIRST CHECK IS THAT THE PATCH IS IN THE BUILD, AND IT IS NOT OPTIONAL ────────────────
#
# Measured the expensive way: the package manager keeps MORE THAN ONE copy of a patched module in
# its store, and Android autolinking compiled a copy the patch had not reached. Six device checks
# passed against a build whose Java was upstream's. Editing the module in `node_modules` has the
# same shape — the edit lands in the copy the JS resolver sees and not the one Gradle compiles.
# Gradle's build cache then restores the stale class even after the module's build directory is
# deleted, so "BUILD SUCCESSFUL" means nothing either.
#
# So the artifact is interrogated before any dial: if the strings the patch introduces are not in
# the APK's dex, every result below would be a statement about upstream's code wearing our name.
#
# ── WHAT IT DRIVES ──────────────────────────────────────────────────────────────────────────
#
# The dials are made by a build of this app exposing a probe entry that logs one line per dial.
# Until the engine has a real entry point on this platform, that harness is a THROWAWAY build
# under a throwaway application id — never the store id, which on a shared device overwrites
# somebody else's install. A lane re-running this builds the harness first; the script drives it.
#
# Usage:
#   HOST=mail.example.com MAILBOX=you@example.com PASS=… APK=path/to/app-release.apk \
#     bash apps/mobile/test/tls-transport-guards.sh
#
# The account and the address come from the environment: this file names no credentials, and a
# provider's address changes without warning — resolve it at run time rather than pinning it here.
set -u

: "${HOST:?set HOST to a provider hostname whose certificate does NOT carry an IP name}"
: "${MAILBOX:?set MAILBOX to the mailbox address}"
: "${PASS:?set PASS to the mailbox password}"
IP="${IP:-$(getent ahostsv4 "$HOST" | head -1 | awk '{print $1}')}"
: "${IP:?could not resolve $HOST to an IPv4 address; set IP explicitly}"
PKG="${PKG:-app.ohmail.spike}"
COMPONENT="${COMPONENT:-$PKG/app.ohmail.MainActivity}"
WAIT="${WAIT:-30}"
APK="${APK:-apps/mobile/android/app/build/outputs/apk/release/app-release.apk}"

fail=0
note() { printf '%s\n' "$1"; }

# ── gate: the patch has to be in the artifact ────────────────────────────────────────────────
if [ ! -f "$APK" ]; then
  note "FAIL the APK is not at $APK — build the harness before running these"
  exit 1
fi
DEX_DIR=$(mktemp -d)
trap 'rm -rf "$DEX_DIR"' EXIT
unzip -q -o "$APK" 'classes*.dex' -d "$DEX_DIR" || { note "FAIL could not read $APK"; exit 1; }
for marker in "unknown TLS minVersion" "refusing the TLS upgrade" "no X509ExtendedTrustManager" \
              "the TLS floor did not hold" "receiver would not quiesce" "nistCurve"; do
  if ! strings -a "$DEX_DIR"/classes*.dex | /usr/bin/grep -qa -- "$marker"; then
    note "FAIL the patch is NOT in this build — '$marker' is absent from the dex."
    note "     Every check below would describe upstream's transport, not ours. Rebuild with"
    note "     --no-build-cache after confirming the module the autolinker resolves is patched."
    exit 1
  fi
done
note "ok   the patch is present in the build under test"

enc() { printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g'; }
U=$(enc "$MAILBOX"); P=$(enc "$PASS")

# The URL is single-quoted for the DEVICE's shell, which is a second shell: `adb shell` joins its
# arguments and hands them to it, so an unquoted `&` backgrounds the command and the URL is
# truncated at the first parameter. The app then falls back to its defaults and answers a question
# nobody asked — a green that means nothing.
probe() {
  adb logcat -c
  adb shell am force-stop "$PKG" >/dev/null 2>&1
  adb shell "am start -a android.intent.action.VIEW -d '$1' -n $COMPONENT" >/dev/null 2>&1
  sleep "$WAIT"
  adb logcat -d -v brief 2>/dev/null | /usr/bin/grep -a "OHMAIL_PROBE \(tlsprobe\|connect_ms\|FAILED\)" | tail -1
}

check() {   # check <label> <expected-substring> <actual>
  if [ -z "$3" ]; then
    note "FAIL $1 — the probe produced NO output at all (crashed, never launched, wrong package?)"
    fail=1
  elif printf '%s' "$3" | /usr/bin/grep -qa -- "$2"; then
    note "ok   $1"
  else
    note "FAIL $1 — expected '$2', got: $3"
    fail=1
  fi
}

note "host $HOST  ip $IP  package $PKG"

# A dial's verdict is the FIRST BYTE FROM THE SERVER, never the connect callback: the socket
# library raises its `secureConnect` from the underlying TCP connect, so a callback-based verdict
# reports "the port answered" as "the certificate was accepted". Bytes only flow after a completed
# handshake, and on this port the server speaks first.
check "a dial by name is accepted" \
  "ACCEPTED" "$(probe "ohmail://tlsProbe?tlsProbe=1&host=$HOST&port=993")"

# NOT merely "REFUSED": a dial refused by a name check and one refused because the port was shut,
# the alias was unusable or a stub threw all read the same at that granularity, and the second kind
# would certify the first. The refusal has to NAME the certificate's names.
check "a dial by IP is refused BY THE CERTIFICATE'S NAMES" \
  "subjectAltName" "$(probe "ohmail://tlsProbe?tlsProbe=1&host=$IP&port=993")"

check "an unrecognised minimum TLS version is refused, not ignored" \
  "unknown TLS minVersion" \
  "$(probe "ohmail://tlsProbe?tlsProbe=1&host=$HOST&port=993&minVersion=TLSv9")"

check "the floor still permits a dial that meets it" \
  "ACCEPTED" "$(probe "ohmail://tlsProbe?tlsProbe=1&host=$HOST&port=993&minVersion=TLSv1.2")"

# A client identity says who WE are and must never decide who THEY may be. Upstream conflated the
# two: supplying one installed a trust manager that accepted every chain.
#
# THE POSITIVE CONTROL COMES FIRST, and without it the negative one certifies nothing: an alias that
# does not resolve, or an option the transport ignores, makes the dial fail before trust is ever
# evaluated — and a check looking only for a refusal would call that a pass. So the same options
# must first be shown to reach a working connection by name.
check "the client-identity options still reach a working dial (positive control)" \
  "ACCEPTED" \
  "$(probe "ohmail://tlsProbe?tlsProbe=1&host=$HOST&port=993&rejectUnauthorized=0&keyAlias=probe")"
check "and with them set, a dial by IP is STILL refused by the certificate's names" \
  "subjectAltName" \
  "$(probe "ohmail://tlsProbe?tlsProbe=1&host=$IP&port=993&rejectUnauthorized=0&keyAlias=probe")"

# The upgrade is the one dial whose success cannot be read from a connect: a cleartext session on
# this port also "connects". `connect_ms` is only accepted here because the probe logs it after the
# mail client has completed its own STARTTLS and read the server's capabilities over the encrypted
# link — a cleartext fallback never reaches that line.
check "STARTTLS completes the in-place upgrade" \
  "connect_ms" \
  "$(probe "ohmail://sync?connectOnly=1&secure=0&host=$HOST&port=143&user=$U&pass=$P")"

exit "$fail"
