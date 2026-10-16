#!/usr/bin/env bash
# THE PEER KEY IS READ BY ITS TYPE — exercised on a real JVM, not read.
#
# `SSLCertificateHelper.keyFacts` in the tcp-socket patch replaced upstream's unconditional
# RSAPublicKey cast, which made getPeerCertificate reject for an ECDSA certificate and the
# STARTTLS confirmation read a finished handshake as a failed upgrade. This runs the patch's own
# method text over real keys, two ways:
#
#   A  as shipped                     -> RSA, EC P-256/P-384/P-521 and Ed25519 all answer, none throws
#   B  with upstream's cast put back  -> the EC key throws ClassCastException, which is the defect
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

JAVAC=""
for c in "${JAVA_HOME:-}/bin/javac" "$HOME/Android/jdk-17/bin/javac" "$(command -v javac || true)"; do
  [ -n "$c" ] && [ -x "$c" ] && { JAVAC="$c"; break; }
done
# A missing JDK is a refusal, never a skip: a guard that passes when it could not run says nothing.
[ -n "$JAVAC" ] || { echo "FAIL: no JDK found; set JAVA_HOME. This guard compiles Java and cannot be skipped."; exit 1; }
JAVA="$(dirname "$JAVAC")/java"

# The copy apps/mobile links (the one autolinking compiles), built from THIS patch file. A copy
# named in PEER_KEY_SRC is graded instead: that is how a mutation arm grades a scratch copy
# without touching the package store.
if [ -n "${PEER_KEY_SRC:-}" ]; then
  SRC="$PEER_KEY_SRC"
else
  PKG="$(cd "$ROOT/apps/mobile" && node -e "console.log(require.resolve('react-native-tcp-socket/package.json'))" 2>/dev/null || true)"
  [ -n "$PKG" ] || { echo "FAIL: apps/mobile cannot resolve react-native-tcp-socket; install the workspace's dependencies"; exit 1; }
  SRC="$(dirname "$PKG")/android/src/main/java/com/asterinet/react/tcpsocket/SSLCertificateHelper.java"
  WANT="$(sha256sum "$ROOT/patches/react-native-tcp-socket@6.4.2.patch" | cut -c1-40)"
  case "$(readlink -f "$SRC")" in
    *"$WANT"*) : ;;
    *) echo "FAIL: apps/mobile links a copy built from a different patch (wanted $WANT); run pnpm install"; exit 1;;
  esac
fi
[ -f "$SRC" ] || { echo "FAIL: no SSLCertificateHelper.java at $SRC"; exit 1; }
grep -q "static Map<String, Object> keyFacts(" "$SRC" || { echo "FAIL: $SRC carries no keyFacts; the patch is not in this copy"; exit 1; }

python3 - "$SRC" "$WORK" <<'PY'
import sys
src, work = sys.argv[1], sys.argv[2]
s = open(src).read()
def lift(head):
    start = s.index(head)
    i = s.index("{", start); depth = 0
    for j in range(i, len(s)):
        if s[j] == "{": depth += 1
        elif s[j] == "}":
            depth -= 1
            if depth == 0: return s[start:j + 1]
facts = lift("    static Map<String, Object> keyFacts(")
curve = lift("    private static String[] nistCurveOf(")
# B: upstream's cast, unconditionally — every key read as RSA.
defect = facts.replace("if (key instanceof RSAPublicKey) {", "if (true) {", 1)
assert defect != facts, "the RSA dispatch this guard reverts has moved"
defect = defect.replace("static Map<String, Object> keyFacts(", "static Map<String, Object> keyFactsUpstream(", 1)
harness = """import java.math.BigInteger;
import java.security.*;
import java.security.interfaces.*;
import java.security.spec.*;
import java.util.*;

public class PeerKeyGuard {
%s
%s
%s
    static Map<String, Object> read(boolean upstream, PublicKey k) {
        return upstream ? keyFactsUpstream(k) : keyFacts(k);
    }
    static PublicKey ec(String curve) throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec(curve));
        return g.generateKeyPair().getPublic();
    }
    static void want(boolean ok, String what) {
        if (!ok) { System.out.println("FAIL A: " + what); System.exit(1); }
    }
    public static void main(String[] args) throws Exception {
        KeyPairGenerator rg = KeyPairGenerator.getInstance("RSA");
        rg.initialize(2048);
        Map<String, Object> rsa = read(false, rg.generateKeyPair().getPublic());
        want(Integer.valueOf(2048).equals(rsa.get("bits")) && "0x10001".equals(rsa.get("exponent")) && rsa.get("modulus") != null, "RSA read " + rsa.keySet());
        String[][] curves = { { "secp256r1", "256", "prime256v1", "P-256" }, { "secp384r1", "384", "secp384r1", "P-384" }, { "secp521r1", "521", "secp521r1", "P-521" } };
        for (String[] c : curves) {
            Map<String, Object> f = read(false, ec(c[0]));
            want(Integer.valueOf(c[1]).equals(f.get("bits")) && c[2].equals(f.get("asn1Curve")) && c[3].equals(f.get("nistCurve")) && !f.containsKey("modulus"), c[0] + " read " + f);
        }
        Map<String, Object> ed = read(false, KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic());
        want(ed.isEmpty(), "Ed25519 read " + ed);
        System.out.println("A ok: RSA, P-256, P-384, P-521 read; Ed25519 reads nothing and does not throw");
        try {
            System.out.println("FAIL B: upstream's cast read an EC key: " + read(true, ec("secp256r1")));
            System.exit(1);
        } catch (ClassCastException e) {
            System.out.println("B ok: upstream's cast throws on an EC key (" + e.getClass().getSimpleName() + ")");
        }
        System.out.println("ALL OK");
    }
}
""" % (facts, curve, defect)
open(work + "/PeerKeyGuard.java", "w").write(harness)
PY

"$JAVAC" -nowarn -d "$WORK" "$WORK/PeerKeyGuard.java"
OUT="$("$JAVA" -cp "$WORK" PeerKeyGuard)" && RC=0 || RC=$?
echo "$OUT"
[ "$RC" -eq 0 ] || exit 1
case "$OUT" in *"ALL OK"*) echo "PASS: every key type answers, and upstream's cast is the defect this replaced";; *) echo "FAIL: no verdict"; exit 1;; esac
