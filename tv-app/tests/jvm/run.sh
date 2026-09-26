#!/bin/sh
# JVM tests for the pure-Java relay package (com.nikhil.officetv.relay). Needs only a JDK (8+ API; 11+ to run)
# and org.json. Exit 0 only if everything passed.
#
#   run.sh                       compile + run VectorsTest and RelayClientTest (default)
#   run.sh fake-ntfy [args]      run the fake relay:  [port] [--https] [--host H] [--keepalive-ms N] [--fail429 N] [--cert-out F]
#   run.sh e2e <relay> <code> [--trust cert.pem]   run the stand-in TV (E2EHarness)
#   run.sh live [relay]          RelayLiveTest against https://ntfy.sh (exit 2 = no network / 429)
#
# Env: VECTORS (default tests/vectors.json), ORGJSON_JAR (default /tmp/claude-0/json-20240303.jar), ANDROID_ALL_JAR (default
# /tmp/claude-0/android-all-13-robolectric-9030017.jar; if present, the unit tests run a second time with
# Android's own org.json, which escapes '/' and has checked JSONException, to catch size/API differences).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/../.." && pwd)
ORGJSON_JAR=${ORGJSON_JAR:-/tmp/claude-0/json-20240303.jar}
ANDROID_ALL_JAR=${ANDROID_ALL_JAR:-/tmp/claude-0/android-all-13-robolectric-9030017.jar}
RELAY_SRC="$APP/app/src/main/java/com/nikhil/officetv/relay"
VECTORS=${VECTORS:-$APP/tests/vectors.json}
[ -f "$ORGJSON_JAR" ] || { echo "org.json jar not found: $ORGJSON_JAR (set ORGJSON_JAR)"; exit 1; }

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT INT TERM
filter() { grep -v -e '^Picked up JAVA_TOOL_OPTIONS' -e '^warning: \[options\]' -e '^[0-9]* warnings\?$' -e '^Note: ' || true; }
# Runs a command with filtered output and returns its real exit status (a pipe would hide it in POSIX sh).
filtered() {
  ( rc=0; "$@" || rc=$?; echo $rc > "$OUT/rc" ) 2>&1 | filter
  return "$(cat "$OUT/rc" 2>/dev/null || echo 1)"
}

# Relay code must build for Android (Java 8 language level, no android.* imports).
if grep -n '^import android\.' "$RELAY_SRC"/*.java; then echo "relay package must not import android.*"; exit 1; fi
# APIs missing on Android API 21 (compile-check.sh builds against the API 33 jar, so it cannot catch these).
if grep -nE 'java\.util\.Base64|String\.join|getOrDefault|putIfAbsent|computeIfAbsent|\.forEach\(|\.stream\(|java\.util\.function|Optional<|java\.time|requireNonNullElse|\.removeIf\(|List\.of\(|Map\.of\(|Set\.of\(|\.readAllBytes\(|\.isBlank\(|\.repeat\(|Math\.(floorMod|floorDiv|addExact|multiplyExact|toIntExact)|Long\.hashCode|Integer\.toUnsignedString|\.chars\(\)' "$RELAY_SRC"/*.java; then
  echo "API newer than Android 21 used in the relay package"; exit 1
fi
mkdir -p "$OUT/classes"
filtered javac --release 8 -encoding UTF-8 -Xlint:all -Xlint:-options -Werror -d "$OUT/classes" -cp "$ORGJSON_JAR" \
  "$RELAY_SRC"/*.java || { echo "relay package did not compile"; exit 1; }
filtered javac -encoding UTF-8 -nowarn -d "$OUT/classes" -cp "$OUT/classes:$ORGJSON_JAR" "$HERE"/*.java \
  || { echo "tests did not compile"; exit 1; }
CP="$OUT/classes:$ORGJSON_JAR"
PKG=com.nikhil.officetv.relay

case "${1:-test}" in
  # exec so that killing this script's PID stops the server (leaves the small temp class dir behind).
  fake-ntfy) shift; exec java -cp "$CP" $PKG.FakeNtfy "$@" ;;
  e2e) shift; exec java -cp "$CP" $PKG.E2EHarness "$@" ;;
  live) shift; rc=0; filtered java -cp "$CP" $PKG.RelayLiveTest "$@" || rc=$?; exit $rc ;;
  test) ;;
  *) echo "unknown command: $1"; exit 1 ;;
esac

FAILED=0
suite() {
  echo "== $1"; shift
  filtered java "$@" || { echo "!! FAILED: $*"; FAILED=1; }
}
suite "VectorsTest (org.json $(basename "$ORGJSON_JAR"))" -cp "$CP" $PKG.VectorsTest "$VECTORS"
suite "RelayClientTest" -cp "$CP" $PKG.RelayClientTest
if [ -f "$ANDROID_ALL_JAR" ]; then
  suite "VectorsTest with Android's org.json" -cp "$OUT/classes:$ANDROID_ALL_JAR" $PKG.VectorsTest "$VECTORS"
  suite "RelayClientTest with Android's org.json" -cp "$OUT/classes:$ANDROID_ALL_JAR" $PKG.RelayClientTest
else
  echo "(skipping the Android org.json pass: $ANDROID_ALL_JAR not found)"
fi
if [ "$FAILED" = 0 ]; then echo "ALL JVM TESTS PASSED"; else echo "JVM TESTS FAILED"; exit 1; fi
