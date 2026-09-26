#!/usr/bin/env bash
# Office TV smoke test on a running emulator/device (debug APK, it logs the OTV_TEST line).
#
#   smoke.sh <apk> <flavor: full|lite> <grant: a11y|overlay|both|none>
#
# grant: how the app is allowed to open screens from the background on Android 10+:
#   a11y = enable RemoteA11yService (full only), overlay = "Display over other apps", both, none.
# Env: OTV_OUT (default ci-out), ADB, OTV_WAIT (seconds to wait for the OTV_TEST line, default 60).
# Writes $OTV_OUT/results.txt (PASS/FAIL/WARN lines), screenshots, logcat.txt and otv-test.env
# (PIN, PORT, LPORT, CODE, ...) for the steps after it. Exit 0 only if no check failed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"

APK=${1:-}
FLAVOR=${2:-full}
GRANT=${3:-a11y}
usage() { echo "usage: smoke.sh <apk> <full|lite> <a11y|overlay|both|none>" >&2; exit 2; }
[ -f "$APK" ] || { echo "APK not found: $APK" >&2; usage; }
case $FLAVOR in full | lite) ;; *) usage ;; esac
case $GRANT in a11y | overlay | both | none) ;; *) usage ;; esac
case $FLAVOR:$GRANT in lite:a11y | lite:both) echo "the lite APK has no accessibility service" >&2; exit 2 ;; esac

A11Y_COMP="$PKG/.RemoteA11yService"
FAILS_BEFORE=$(fail_count)
LOGCAT_OWNER=0
cleanup() {
    [ -n "${LPORT:-}" ] && [ "${KEEP_FORWARD:-0}" != 1 ] && A forward --remove "tcp:$LPORT" >/dev/null 2>&1
    [ "$LOGCAT_OWNER" = 1 ] && logcat_stop
}
trap cleanup EXIT

finish() {
    local n=$(( $(fail_count) - FAILS_BEFORE ))
    echo
    echo "== smoke.sh summary ($FLAVOR, grant=$GRANT, API ${SDK:-?}${IS_TV:+, tv=$IS_TV})"
    grep -E '^(PASS|FAIL|WARN)' "$RESULTS" | tail -n +1
    if [ "$n" -gt 0 ]; then echo "SMOKE FAIL ($n failed)"; exit 1; fi
    echo "SMOKE PASS"
    exit 0
}

# The web server (and OTV_TEST line) must appear; stops the test if not.
need_server() {
    if ! wait_otv "${OTV_WAIT:-60}" "${1:-}"; then
        fail "$2: no 'OTV_TEST' log line within ${OTV_WAIT:-60} s (server did not start)"
        grep -E ' (OfficeTV|AndroidRuntime)' "$LOGCAT_FILE" | tail -n 30 | sed 's/^/      /'
        screenshot "no-server"
        finish
    fi
    log "OTV_TEST pid=$OTV_PID pin=$PIN port=$PORT code=$CODE"
    forward "$PORT" || { fail "$2: adb forward to port $PORT failed"; finish; }
    if wait_until 20 server_up; then
        pass "$2: LAN page answers on port $PORT (GET / has 'Office TV')"
    else
        fail "$2: GET / on port $PORT did not return the 'Office TV' page"
        finish
    fi
}

# Enables our accessibility service (again) and waits until the app reports it.
grant_a11y() {
    local cur
    cur=$(S settings get secure enabled_accessibility_services)
    case $cur in
        *"$A11Y_COMP"* | *"$PKG/$PKG.RemoteA11yService"*) ;;
        "" | null) S settings put secure enabled_accessibility_services "$A11Y_COMP" >/dev/null ;;
        *) S settings put secure enabled_accessibility_services "$cur:$A11Y_COMP" >/dev/null ;;
    esac
    S settings put secure accessibility_enabled 1 >/dev/null
}
a11y_on() { [ "$(http GET /api/status)" = 200 ] && [ "$(jget "$HTTP_BODY" accessibility)" = true ]; }

# ---------------------------------------------------------------- device
log "waiting for the device"
A wait-for-device
wait_until 180 eval '[ "$(S getprop sys.boot_completed | tr -dc 0-9)" = 1 ]' || { fail "device did not finish booting"; finish; }
wait_until 60 eval 'S pm path android | grep -q package:' || { fail "package manager not ready"; finish; }
SDK=$(sdk_level)
IS_TV=0
is_tv && IS_TV=1
{
    echo "sdk=$SDK release=$(S getprop ro.build.version.release)"
    echo "model=$(S getprop ro.product.model) abi=$(S getprop ro.product.cpu.abi) tv=$IS_TV"
} | tee "$OUT/device.txt"
logcat_start
wake_and_unlock
S settings put global package_verifier_enable 0 >/dev/null
detect_home
info "device: API $SDK, Android $(S getprop ro.build.version.release), tv=$IS_TV, launcher: ${HOME_PKGS:-unknown}"

# ---------------------------------------------------------------- install
S pm uninstall "$PKG" >/dev/null
out=""
for try in 1 2 3; do
    out=$(A install -r "$APK" 2>&1 | tr -d '\r')
    case $out in *Success*) break ;; esac
    log "install attempt $try: $out"
    sleep 5
done
case $out in
    *Success*) pass "install $(basename "$APK")" ;;
    *) fail "install $(basename "$APK"): $(printf '%s' "$out" | tail -n 1)"; finish ;;
esac

pkgdump=$(S dumpsys package "$PKG")
printf '%s\n' "$pkgdump" > "$OUT/dumpsys-package.txt"
if printf '%s\n' "$pkgdump" | grep -q 'RemoteA11yService'; then HAS_A11Y=1; else HAS_A11Y=0; fi
if [ "$FLAVOR" = full ] && [ "$HAS_A11Y" = 0 ]; then fail "full APK must contain RemoteA11yService"; fi
if [ "$FLAVOR" = lite ] && [ "$HAS_A11Y" = 1 ]; then fail "lite APK must not contain RemoteA11yService"; fi

# ---------------------------------------------------------------- permissions
case $GRANT in
    a11y | both) grant_a11y ;;
esac
case $GRANT in
    overlay | both) S appops set "$PKG" SYSTEM_ALERT_WINDOW allow >/dev/null ;;
esac
info "grant style: $GRANT"

# ---------------------------------------------------------------- first start
if launch_app; then pass "app starts from the launcher icon"; else fail "launcher could not start the app: $(tail -n 2 "$OUT/launch.log" | tr '\n' ' ')"; fi
if wait_app_on_screen 30; then
    pass "app screen shown: $RESUMED"
else
    fail "app screen not shown (resumed: ${RESUMED:-nothing})"
    S dumpsys activity activities > "$OUT/dumpsys-activities-start.txt"
fi
sleep 2
screenshot 01-app-start
need_server "" "first start"
FIRST_PIN=$PIN FIRST_CODE=$CODE
if [ ${#CODE} = 10 ]; then pass "pairing code looks valid ($CODE)"; else fail "pairing code '$CODE' is not 10 characters"; fi
save_env

# ---------------------------------------------------------------- API basics
code=$(http GET /api/status)
cp "$HTTP_BODY" "$OUT/http/status-1.json"
if [ "$code" = 200 ] && [ "$(jget "$HTTP_BODY" android)" != '!json' ]; then
    pass "GET /api/status: $(head -c 300 "$HTTP_BODY")"
else
    fail "GET /api/status -> HTTP $code: $(head -c 200 "$HTTP_BODY")"
fi
fl=$(jget "$HTTP_BODY" flavor)
case $fl in
    "$FLAVOR") pass "status flavor is $fl" ;;
    "" | '!json') warn "status has no 'flavor' field" ;;
    *) fail "status flavor is '$fl', expected $FLAVOR" ;;
esac
code=$(http GET /api/status "" 0000x)
if [ "$code" = 401 ]; then pass "wrong PIN is refused (401)"; else fail "wrong PIN -> HTTP $code (expected 401)"; fi

case $GRANT in
    a11y | both)
        if wait_until 20 a11y_on; then pass "accessibility service connected"; else fail "accessibility service did not connect (status.accessibility != true)"; fi ;;
esac
http GET /api/status >/dev/null
need=$(jget "$HTTP_BODY" needsPermission)
if [ "$SDK" -ge 29 ] && [ "$GRANT" = none ]; then
    if [ "$need" = true ]; then pass "app says it needs a permission (Android 10+, nothing granted)"; else warn "needsPermission=$need with nothing granted on API $SDK"; fi
elif [ "$need" = false ]; then
    pass "needsPermission=false"
else
    fail "needsPermission=$need although grant=$GRANT"
fi

for p in /api/apps /api/files; do
    code=$(http GET "$p")
    cp "$HTTP_BODY" "$OUT/http/$(basename "$p").json"
    n=$(jlen "$HTTP_BODY")
    if [ "$code" = 200 ] && [ "$n" -ge 0 ]; then pass "GET $p -> $n items"; else fail "GET $p -> HTTP $code: $(head -c 200 "$HTTP_BODY")"; fi
    if [ "$p" = /api/apps ] && [ "$n" = 0 ]; then warn "/api/apps returned no apps"; fi
done

post_ok /api/key '{"key":"volume_up"}' "POST /api/key volume_up"

# ---------------------------------------------------------------- open a link
# Opening from the background needs the grant on Android 10+; before that it always works.
EXPECT_OK=true
[ "$SDK" -ge 29 ] && [ "$GRANT" = none ] && EXPECT_OK=false
post_ok /api/open '{"url":"https://example.com"}' "POST /api/open https://example.com" true
if wait_until 25 resumed_is_other; then
    pass "link opened on screen: $(describe_other)"
    case $RESUMED in android/*) warn "Android showed an app chooser; a real TV user would have to pick an app" ;; esac
else
    fail "link did not open (resumed: ${RESUMED:-nothing})"
    S dumpsys activity activities > "$OUT/dumpsys-activities-open.txt"
fi
sleep 3
screenshot 02-link-opened

# ---------------------------------------------------------------- home key
USE_A11Y_KEYS=0
[ "$HAS_A11Y" = 1 ] && case $GRANT in a11y | both) a11y_on && USE_A11Y_KEYS=1 ;; esac
if [ "$USE_A11Y_KEYS" = 1 ]; then
    post_ok /api/key '{"key":"home"}' "POST /api/key home (accessibility)"
    if wait_until 15 resumed_is_home; then pass "home key reached the launcher ($RESUMED)"; else fail "home key: launcher not shown (resumed: ${RESUMED:-nothing})"; fi
else
    http POST /api/key '{"key":"home"}' >/dev/null
    info "home via accessibility not available here: $(jget "$HTTP_BODY" msg)"
fi
resumed_is_home || go_home || warn "could not get back to the launcher (resumed: ${RESUMED:-nothing})"
screenshot 03-home

# ---------------------------------------------------------------- upload a file (app is in the background now)
PDF="$OUT/OfficeTV-test.pdf"
make_pdf "$PDF" "Office TV test"
code=$(http POST /api/upload "@$PDF")
cp "$HTTP_BODY" "$OUT/http/upload.json"
ok=$(jget "$HTTP_BODY" ok)
if [ "$code" = 200 ] && [ "$ok" = "$EXPECT_OK" ]; then
    pass "POST /api/upload (PDF) -> ok=$ok \"$(jget "$HTTP_BODY" msg)\""
else
    fail "POST /api/upload (PDF) -> HTTP $code: $(head -c 300 "$HTTP_BODY")"
fi
if [ "$EXPECT_OK" = true ]; then
    if wait_until 25 resumed_is_other; then pass "file opened on screen from the background: $(describe_other)"; else fail "uploaded file did not open (resumed: ${RESUMED:-nothing})"; S dumpsys activity activities > "$OUT/dumpsys-activities-upload.txt"; fi
fi
sleep 3
screenshot 04-file-opened
code=$(http GET /api/files)
if [ "$code" = 200 ] && grep -q 'OfficeTV-test' "$HTTP_BODY"; then pass "uploaded file is listed in /api/files"; else fail "uploaded file missing from /api/files: $(head -c 200 "$HTTP_BODY")"; fi

# ---------------------------------------------------------------- volume, keep awake
post_ok /api/volume '{"percent":40}' "POST /api/volume 40%"
post_ok /api/awake '{"on":false}' "POST /api/awake off"
post_ok /api/awake '{"on":true}' "POST /api/awake on"
http GET /api/status >/dev/null
if [ "$(jget "$HTTP_BODY" keepAwake)" = true ]; then pass "status.keepAwake=true"; else fail "status.keepAwake is '$(jget "$HTTP_BODY" keepAwake)' after /api/awake on"; fi
if S dumpsys power | grep -i 'officetv' | grep -qi 'wake'; then pass "screen wake lock held"; else warn "no officetv wake lock in 'dumpsys power'"; fi
go_home >/dev/null

# ---------------------------------------------------------------- process death
crash_scan "before restarts"
old=$OTV_PID
pid=$(app_pids | head -n 1)
if [ -z "$pid" ]; then
    warn "could not find the app process; kill test skipped"
else
    S run-as "$PKG" kill -9 "$pid" >/dev/null
    if wait_until 10 eval '! app_pids | grep -qx "$pid"'; then
        # START_STICKY, the accessibility binding or ServiceJob should bring the server back without a user.
        if wait_otv 60 "$old" && forward "$PORT" && wait_until 20 server_up; then
            pass "server came back by itself after the app process was killed (port $PORT)"
        else
            warn "server did not come back by itself within 60 s after the app process was killed"
        fi
    else
        warn "could not kill the app process (run-as); kill test skipped"
    fi
fi

old=$(otv_last | cut -d' ' -f1)
S am force-stop "$PKG" >/dev/null
if wait_until 15 server_down; then pass "force-stop stopped the server"; else info "server still answered after force-stop"; fi
[ "$GRANT" = a11y ] || [ "$GRANT" = both ] && grant_a11y  # Android disables a force-stopped app's service
launch_app || fail "launcher could not start the app after force-stop"
wait_app_on_screen 30 || fail "app screen not shown after force-stop (resumed: ${RESUMED:-nothing})"
need_server "$old" "after force-stop + start"
if [ "$PIN" = "$FIRST_PIN" ]; then pass "PIN kept after restart"; else fail "PIN changed after restart ($FIRST_PIN -> $PIN)"; fi
if [ "$CODE" = "$FIRST_CODE" ]; then pass "pairing code kept after restart"; else fail "pairing code changed after restart ($FIRST_CODE -> $CODE)"; fi
code=$(http GET /api/status)
if [ "$code" = 200 ]; then pass "GET /api/status after restart"; else fail "GET /api/status after restart -> HTTP $code"; fi
case $GRANT in
    a11y | both) wait_until 20 a11y_on && pass "accessibility connected again after restart" || warn "accessibility not connected after restart" ;;
esac
sleep 2
screenshot 05-after-restart
save_env
KEEP_FORWARD=1

crash_scan "smoke test"
finish
