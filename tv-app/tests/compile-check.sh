#!/bin/sh
# Compile-checks all TV app Java sources against the Android 13 framework jar (no Android SDK needed).
# Generates stub R and BuildConfig classes. Exit code != 0 means a compile error.
# Jars are expected in $JARS (default /tmp/claude-0): android-all-13-robolectric-9030017.jar,
# nanohttpd-2.3.1.jar, core-3.3.0.jar.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
JARS=${JARS:-/tmp/claude-0}
OUT=$(mktemp -d)
STUB="$OUT/stub/com/nikhil/officetv"
mkdir -p "$STUB" "$OUT/classes"
cat > "$STUB/R.java" <<'J'
package com.nikhil.officetv;
public final class R {
  public static final class drawable { public static final int ic_launcher = 1, banner = 2; }
  public static final class string { public static final int app_name = 3, a11y_desc = 4; }
  public static final class xml { public static final int a11y_config = 5; }
}
J
cat > "$STUB/BuildConfig.java" <<'J'
package com.nikhil.officetv;
public final class BuildConfig {
  public static final boolean DEBUG = false;
  public static final String APPLICATION_ID = "com.nikhil.officetv";
  public static final String BUILD_TYPE = "release";
  public static final String FLAVOR = "full";
  public static final int VERSION_CODE = 3;
  public static final String VERSION_NAME = "1.2";
}
J
CP="$JARS/android-all-13-robolectric-9030017.jar:$JARS/nanohttpd-2.3.1.jar:$JARS/core-3.3.0.jar"
find "$HERE/app/src/main/java" -name '*.java' > "$OUT/sources.txt"
find "$OUT/stub" -name '*.java' >> "$OUT/sources.txt"
javac --release 8 -nowarn -Xlint:none -d "$OUT/classes" -cp "$CP" @"$OUT/sources.txt" 2>&1 | grep -v -e '^Picked up JAVA_TOOL_OPTIONS' -e '^Note:' || true
# javac's exit status is lost in the pipe above, so check for class output of every source instead.
MISSING=0
while read -r f; do
  c=$(basename "$f" .java)
  [ -n "$(find "$OUT/classes" -name "$c.class" | head -1)" ] || { echo "NOT COMPILED: $f"; MISSING=1; }
done < "$OUT/sources.txt"
rm -rf "$OUT"
[ $MISSING = 0 ] && echo "COMPILE OK" || { echo "COMPILE FAILED"; exit 1; }
