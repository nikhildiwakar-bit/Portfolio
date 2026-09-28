#!/bin/sh
# Compile-checks all TV app Java sources against the Android 13 framework jar (no Android SDK needed).
# Two passes, like Gradle's build types: src/main + src/debug, and src/main + src/release (each has its own
# DebugHooks). Generates stub R and BuildConfig classes. Exit code != 0 means a compile error.
# Jar expected in $JARS (default /tmp/claude-0): android-all-13-robolectric-9030017.jar.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
JARS=${JARS:-/tmp/claude-0}
CP="$JARS/android-all-13-robolectric-9030017.jar"
[ -f "$CP" ] || { echo "android-all jar not found: $CP (set JARS)"; exit 1; }
SRC="$HERE/app/src"

# APIs missing on Android 5 (API 21) that the API 33 jar would happily compile.
if grep -rnE 'java\.util\.Base64|String\.join|getOrDefault|putIfAbsent|computeIfAbsent|\.forEach\(|\.stream\(|java\.util\.function|Optional<|java\.time|requireNonNullElse|\.removeIf\(|List\.of\(|Map\.of\(|Set\.of\(|\.readAllBytes\(|\.isBlank\(|\.repeat\(|Math\.(floorMod|floorDiv|addExact|multiplyExact|toIntExact)|Long\.hashCode|Integer\.toUnsignedString|\.chars\(\)' \
    "$SRC"/main/java "$SRC"/debug/java "$SRC"/release/java; then
  echo "API newer than Android 21 used in the app"; echo "COMPILE FAILED"; exit 1
fi

FAILED=0
for TYPE in debug release; do
  OUT=$(mktemp -d)
  STUB="$OUT/stub/com/nikhil/officetv"
  mkdir -p "$STUB" "$OUT/classes"
  DEBUG=false
  [ "$TYPE" = debug ] && DEBUG=true
  cat > "$STUB/R.java" <<'J'
package com.nikhil.officetv;
public final class R {
  public static final class drawable { public static final int ic_launcher = 1, banner = 2; }
  public static final class string { public static final int app_name = 3, a11y_desc = 4; }
  public static final class xml { public static final int a11y_config = 5; }
  public static final class style { public static final int OfficeTv = 6, OfficeTv_Cast = 7; }
  public static final class color { public static final int otv_bg = 8, otv_accent = 9; }
}
J
  cat > "$STUB/BuildConfig.java" <<J
package com.nikhil.officetv;
public final class BuildConfig {
  public static final boolean DEBUG = $DEBUG;
  public static final String APPLICATION_ID = "com.nikhil.officetv";
  public static final String BUILD_TYPE = "$TYPE";
  public static final String FLAVOR = "full";
  public static final int VERSION_CODE = 9;
  public static final String VERSION_NAME = "3.0";
}
J
  find "$SRC/main/java" "$SRC/$TYPE/java" -name '*.java' > "$OUT/sources.txt"
  find "$OUT/stub" -name '*.java' >> "$OUT/sources.txt"
  javac --release 8 -encoding UTF-8 -nowarn -Xlint:none -d "$OUT/classes" -cp "$CP" @"$OUT/sources.txt" 2>&1 \
    | grep -v -e '^Picked up JAVA_TOOL_OPTIONS' -e '^Note:' || true
  # javac's exit status is lost in the pipe above, so check for class output of every source instead.
  while read -r f; do
    c=$(basename "$f" .java)
    [ -n "$(find "$OUT/classes" -name "$c.class" | head -1)" ] || { echo "NOT COMPILED ($TYPE): $f"; FAILED=1; }
  done < "$OUT/sources.txt"
  rm -rf "$OUT"
done
[ $FAILED = 0 ] && echo "COMPILE OK" || { echo "COMPILE FAILED"; exit 1; }
