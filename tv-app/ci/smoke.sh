#!/usr/bin/env bash
# Office TV smoke test on a running emulator/device (debug APK: it logs OTV_TEST lines and has a loopback test API).
#
#   smoke.sh <apk> <flavor: full|lite> <grant: a11y|overlay|both|none>
#
# grant: how the app is allowed to open the cast screen from the background on Android 10+:
#   a11y = enable RemoteA11yService (full only), overlay = "Display over other apps", both, none.
# Env: OTV_OUT (default ci-out), ADB, OTV_WAIT (seconds to wait for the OTV_TEST line, default 60),
#      OTV_RELAY (default https://ntfy.sh), NODE (default node).
# Checks: install, launch, home screen (code, link, no overlapping text), no crash/ANR, removed features answer
# "not available", screen sharing from the background (open, one screen per session, Back, stop), the relay
# reaches CONNECTED, a real encrypted ping + cast start/stop through ntfy.sh (relay-cast.mjs), restarts.
# Writes $OTV_OUT/results.txt (PASS/FAIL/WARN lines), screenshots, UI dumps, logcat.txt and otv-test.env.
# Exit 0 only if no check failed. Network problems and relay limits (HTTP 429) are warnings, not failures.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"

APK=${1:-}
FLAVOR=${2:-full}
GRANT=${3:-a11y}
RELAY=${OTV_RELAY:-https://ntfy.sh}
NODE=${NODE:-node}
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

# The test API (and its OTV_TEST line) must appear; stops the test if not.
need_api() {
    if ! wait_otv "${OTV_WAIT:-60}" "${1:-}"; then
        fail "$2: no 'OTV_TEST port=' log line within ${OTV_WAIT:-60} s (background service did not start)"
        grep -E ' (OfficeTV|AndroidRuntime)' "$LOGCAT_FILE" | tail -n 30 | sed 's/^/      /'
        screenshot "no-service"
        finish
    fi
    log "OTV_TEST pid=$OTV_PID port=$PORT code=$CODE"
    forward "$PORT" || { fail "$2: adb forward to port $PORT failed"; finish; }
    if wait_until 20 server_up; then
        pass "$2: test API answers on port $PORT"
    else
        fail "$2: GET /api/status on port $PORT did not answer"
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
a11y_on() { [ "$(status_field accessibility)" = true ]; }
relay_connected() { RELAY_STATE=$(status_field relay); [ "$RELAY_STATE" = CONNECTED ]; }

# relay_step <step> [session] [expect]: runs relay-cast.mjs; sets RELAY_RC (0/1/2) and RELAY_OUT (RESULT json).
relay_step() {
    local out
    refresh_code
    out=$("$NODE" "$HERE/relay-cast.mjs" --relay "$RELAY" --code "$CODE" --step "$1" ${2:+--session "$2"} \
        --expect "${3:-ok}" --timeout 45 2>&1)
    RELAY_RC=$?
    printf '%s\n' "$out" >> "$OUT/relay-cast.log"
    RELAY_OUT=$(printf '%s\n' "$out" | grep '^RESULT ' | tail -n 1 | cut -c8-)
    [ -n "$RELAY_OUT" ] || RELAY_OUT="$(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
}
# relay_verdict <label>: PASS / WARN (network, 429, or the app itself rate limited) / FAIL from RELAY_RC.
relay_verdict() {
    case $RELAY_RC in
        0) pass "$1 via $RELAY: $RELAY_OUT"; return 0 ;;
        2) warn "$1 via $RELAY: relay unreachable or rate limited (not an app failure): $RELAY_OUT" ;;
        *) if [ "$(status_field relay)" = RATE_LIMITED ]; then
               warn "$1 via $RELAY: the TV is rate limited by the relay: $RELAY_OUT"
           else
               fail "$1 via $RELAY: $RELAY_OUT"
           fi ;;
    esac
    return 1
}

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
    echo "screen=$(S wm size | tail -n 1) density=$(S wm density | tail -n 1)"
} | tee "$OUT/device.txt"
logcat_start
wake_and_unlock
S settings put global package_verifier_enable 0 >/dev/null
detect_home
info "device: API $SDK, Android $(S getprop ro.build.version.release), tv=$IS_TV, launcher: ${HOME_PKGS:-unknown}, $(S wm size | tail -n 1)"

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
for gone in ViewerActivity ScreenCaptureActivity FilesProvider; do
    if printf '%s\n' "$pkgdump" | grep -q "$gone"; then fail "removed component still in the APK: $gone"; fi
done
perms=$(printf '%s\n' "$pkgdump" | sed -n '/requested permissions:/,/install permissions:/p')
# POST_NOTIFICATIONS and FOREGROUND_SERVICE_MEDIA_PROJECTION are for the phone side (mirroring notification);
# RECORD_AUDIO is for the phone's sound (Android 10+ playback capture of other apps, never the microphone).
for p in READ_EXTERNAL_STORAGE ACCESS_WIFI_STATE QUERY_ALL_PACKAGES CAMERA; do
    if printf '%s\n' "$perms" | grep -q "android.permission.$p"; then fail "unexpected permission requested: $p"; fi
done
info "requested permissions: $(printf '%s\n' "$perms" | grep -oE 'android\.permission\.[A-Z_]+' | sed 's/android.permission.//' | sort -u | tr '\n' ' ')"

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
if wait_app_on_screen 30 && resumed_is_main; then
    pass "home screen shown: $RESUMED"
else
    fail "home screen not shown (resumed: ${RESUMED:-nothing})"
    S dumpsys activity activities > "$OUT/dumpsys-activities-start.txt"
fi
need_api "" "first start"
refresh_code
FIRST_CODE=$CODE
if printf '%s' "$CODE" | grep -qE '^[0-9]{4}$'; then pass "TV code is 4 digits ($CODE)"; else fail "TV code '$CODE' is not 4 digits"; fi
save_env

# ---------------------------------------------------------------- status
http GET /api/status >/dev/null
cp "$HTTP_BODY" "$OUT/http/status-1.json"
ver=$(jget "$HTTP_BODY" appVersion)
case $ver in '' | '!json') fail "status has no appVersion: $(head -c 300 "$HTTP_BODY")" ;; *) pass "status: $(head -c 400 "$HTTP_BODY")" ;; esac
fl=$(jget "$HTTP_BODY" flavor)
if [ "$fl" = "$FLAVOR" ]; then pass "status flavor is $fl"; else fail "status flavor is '$fl', expected $FLAVOR"; fi
case ",$(jget "$HTTP_BODY" features)," in *,cast,*) pass "status lists the cast feature" ;; *) fail "status.features has no 'cast'" ;; esac
WEBVIEW_OK=$(jget "$HTTP_BODY" webviewOk)
info "web engine: $(jget "$HTTP_BODY" webview) (webviewOk=$WEBVIEW_OK)"
code=$(http GET /api/status "" 0000)
if [ "$code" = 401 ]; then pass "test API refuses a wrong token (401)"; else fail "wrong token -> HTTP $code (expected 401)"; fi

case $GRANT in
    a11y | both)
        if wait_until 20 a11y_on; then pass "accessibility service connected"; else fail "accessibility service did not connect (status.accessibility != true)"; fi ;;
esac
need=$(status_field needsPermission)
if [ "$SDK" -ge 29 ] && [ "$GRANT" = none ]; then
    if [ "$need" = true ]; then pass "app says it needs the one-time setup (Android 10+, nothing granted)"; else warn "needsPermission=$need with nothing granted on API $SDK"; fi
elif [ "$need" = false ]; then
    pass "needsPermission=false"
else
    fail "needsPermission=$need although grant=$GRANT"
fi

# ---------------------------------------------------------------- home screen
sleep 2
screenshot 01-home
refresh_code
DISPLAY_CODE="$CODE"
if ui_dump home; then
    problems=$(ui_check "$OUT/ui-home.xml" "$DISPLAY_CODE" "$SITE")
    # With a too-old WebView the "Update Android System WebView" card takes focus and scrolls the
    # website line off this small emulator screen; that is the intended behaviour, so only the code must show.
    if [ -n "$problems" ] && [ "$WEBVIEW_OK" != true ] && ! printf '%s' "$problems" | grep -q "$DISPLAY_CODE\|overlap"; then
        info "website line scrolled off by the 'Update Android System WebView' card (old WebView): $problems"
        problems=""
    fi
    if [ -z "$problems" ]; then
        pass "home screen shows the TV code $DISPLAY_CODE and the website; no overlapping text or buttons"
    else
        fail "home screen: $(printf '%s' "$problems" | head -n 5 | tr '\n' ';')"
    fi
    # The settings row may be below the fold on small portrait screens (the page scrolls).
    if ui_check "$OUT/ui-home.xml" "Rename TV" "New TV code" | grep -q missing; then
        info "settings row not on the first screen (scrolls on this display)"
    else
        pass "settings row visible (Keep screen on, Rename TV, New TV code)"
    fi
    if [ "$SDK" -ge 29 ] && [ "$GRANT" = none ]; then
        if ui_check "$OUT/ui-home.xml" "Allow Office TV to open automatically" | grep -q missing; then
            fail "one-time setup row not shown although nothing is granted"
        else
            pass "one-time setup row shown (nothing granted)"
        fi
    elif [ "$WEBVIEW_OK" = true ] && ! ui_check "$OUT/ui-home.xml" "ONE-TIME SETUP" | grep -q missing; then
        # 'uiautomator dump' suppresses other accessibility services while it runs, so with grant=a11y the app
        # briefly (and correctly) sees Accessibility as off. The status API check above is the real signal.
        case $GRANT in
            a11y | both) info "setup card visible during the UI dump (uiautomator suspends Accessibility); status says needsPermission=false" ;;
            *) fail "one-time setup card shown although nothing is missing" ;;
        esac
    fi
else
    warn "uiautomator dump failed; home screen text not checked"
fi

# ---------------------------------------------------------------- removed features
for c in open youtube key volume apps app file screen awake rename; do
    api_cmd "{\"cmd\":\"$c\",\"args\":{\"url\":\"https://example.com\",\"key\":\"home\"}}" "removed-$c"
    if [ "$CMD_OK" = false ] && [ "$CMD_MSG" = "$NOT_AVAILABLE" ]; then
        pass "'$c' -> not available"
    else
        fail "'$c' -> ok=$CMD_OK \"$CMD_MSG\" (expected ok=false \"$NOT_AVAILABLE\")"
    fi
done
api_cmd '{"cmd":"ping","args":{}}' ping-local
if [ "$CMD_OK" = true ]; then pass "ping -> \"$CMD_MSG\""; else fail "ping -> ok=$CMD_OK \"$CMD_MSG\""; fi

# ---------------------------------------------------------------- relay
if wait_until 90 relay_connected; then
    pass "relay CONNECTED ($RELAY)"
    RELAY_UP=1
    logged 'relay=CONNECTED' && pass "debug log has 'OTV_TEST relay=CONNECTED'" || warn "no 'OTV_TEST relay=CONNECTED' log line"
else
    RELAY_UP=0
    rc=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$RELAY/v1/health" 2>/dev/null)
    if [ "$RELAY_STATE" = RATE_LIMITED ] || [ "$rc" != 200 ]; then
        warn "relay not CONNECTED (state $RELAY_STATE, runner -> $RELAY/v1/health: HTTP ${rc:-none}); relay tests skipped"
    else
        fail "relay not CONNECTED after 90 s although the runner reaches $RELAY (state $RELAY_STATE: $(status_field relayDetail))"
    fi
fi

# ---------------------------------------------------------------- screen sharing (local, from the background)
# The app is in the background (launcher on screen), as when a laptop starts sharing during another app.
EXPECT_OPEN=1
[ "$SDK" -ge 29 ] && [ "$GRANT" = none ] && EXPECT_OPEN=0
go_home || warn "could not get back to the launcher (resumed: ${RESUMED:-nothing})"
S1=$(new_session)
api_cmd "{\"cmd\":\"cast\",\"args\":{\"action\":\"start\",\"session\":\"$S1\"}}" cast-start-1
if [ "$EXPECT_OPEN" = 0 ]; then
    case $CMD_OK:$CMD_MSG in
        false:*"one-time setup"* | false:*WebView*) pass "cast start without the setup -> \"$CMD_MSG\"" ;;
        *) fail "cast start without the setup -> ok=$CMD_OK \"$CMD_MSG\" (expected the one-time setup message)" ;;
    esac
    sleep 2
    if resumed_is_cast; then fail "cast screen opened from the background without the setup?"; fi
elif [ "$WEBVIEW_OK" != true ]; then
    # Old web engine (older emulator images): the TV explains it, then returns to the home screen by itself.
    case $CMD_OK:$CMD_MSG in
        false:*WebView*) pass "cast start with an old web engine -> \"$CMD_MSG\"" ;;
        *) fail "cast start with an old web engine -> ok=$CMD_OK \"$CMD_MSG\"" ;;
    esac
    if wait_until 15 resumed_is_cast; then pass "cast screen shows the update message"; else fail "cast screen not shown (resumed: ${RESUMED:-nothing})"; fi
    sleep 2
    screenshot 02-cast-old-engine
    if wait_until 25 resumed_is_main; then pass "back to the home screen by itself after the message"; else fail "not back home after the message (resumed: ${RESUMED:-nothing})"; fi
else
    if [ "$CMD_OK" = true ]; then pass "cast start (from the background) -> \"$CMD_MSG\""; else fail "cast start -> ok=$CMD_OK \"$CMD_MSG\""; fi
    if wait_until 15 resumed_is_cast; then
        pass "cast screen on top: $RESUMED"
    else
        fail "cast screen not shown (resumed: ${RESUMED:-nothing})"
        S dumpsys activity activities > "$OUT/dumpsys-activities-cast.txt"
    fi
    if wait_until 40 logged "cast=page-loaded session=$S1"; then
        pass "receiver page loaded from the website"
    else
        warn "receiver page did not load in 40 s: $(grep -oE 'OTV_TEST cast=message.*' "$LOGCAT_FILE" | tail -n 1)"
    fi
    sleep 2
    screenshot 02-cast-waiting
    [ "$(cast_count)" -le 1 ] || fail "more than one cast screen after one session"

    # A second session replaces the first one in the same screen.
    S2=$(new_session)
    api_cmd "{\"cmd\":\"cast\",\"args\":{\"action\":\"start\",\"session\":\"$S2\"}}" cast-start-2
    if [ "$CMD_OK" = true ] && wait_until 10 logged "cast=open session=$S2"; then
        n=$(cast_count)
        if [ "$n" -le 1 ]; then pass "new session reuses the one cast screen ($n open)"; else fail "$n cast screens open after a second session"; fi
    else
        fail "second cast start -> ok=$CMD_OK \"$CMD_MSG\""
    fi
    api_cmd "{\"cmd\":\"cast\",\"args\":{\"action\":\"stop\",\"session\":\"$S1\"}}" cast-stop-old
    sleep 1
    if [ "$CMD_OK" = true ] && resumed_is_cast; then pass "stop for an old session leaves the current one on screen"; else warn "stop(old session): ok=$CMD_OK \"$CMD_MSG\", resumed ${RESUMED:-nothing}"; fi

    # Back on the remote ends the cast and shows Office TV's home screen.
    S input keyevent 4 >/dev/null
    if wait_until 10 resumed_is_main; then pass "Back ends the cast and returns to the home screen"; else fail "after Back: resumed ${RESUMED:-nothing}, expected $MAIN_ACT"; fi
    wait_until 10 logged "cast=closed reason=back" || warn "no 'cast=closed reason=back' log line"

    # The laptop's stop command closes it too.
    go_home >/dev/null
    S3=$(new_session)
    api_cmd "{\"cmd\":\"cast\",\"args\":{\"action\":\"start\",\"session\":\"$S3\"}}" cast-start-3
    if [ "$CMD_OK" = true ] && wait_until 15 resumed_is_cast; then
        api_cmd "{\"cmd\":\"cast\",\"args\":{\"action\":\"stop\",\"session\":\"$S3\"}}" cast-stop-3
        if [ "$CMD_OK" = true ] && wait_until 10 resumed_is_main; then
            pass "cast stop -> \"$CMD_MSG\", home screen shown"
        else
            fail "cast stop -> ok=$CMD_OK \"$CMD_MSG\", resumed ${RESUMED:-nothing}"
        fi
    else
        fail "third cast start -> ok=$CMD_OK \"$CMD_MSG\", resumed ${RESUMED:-nothing}"
    fi
    if [ "$(cast_count)" = 0 ]; then pass "no cast screen left behind"; else warn "cast screens still alive: $(cast_count)"; fi
fi
crash_scan "screen sharing"

# ---------------------------------------------------------------- real relay: encrypted ping + cast via ntfy.sh
if [ "$RELAY_UP" = 1 ]; then
    relay_step ping
    if relay_verdict "encrypted ping"; then
        case $RELAY_OUT in *'"appVersion"'*) ;; *) fail "ping ack has no status object: $RELAY_OUT" ;; esac
    fi
    if [ "$RELAY_RC" != 2 ] && [ "$EXPECT_OPEN" = 1 ] && [ "$WEBVIEW_OK" = true ]; then
        go_home >/dev/null
        R1=$(new_session)
        relay_step start "$R1"
        if relay_verdict "encrypted cast start"; then
            if wait_until 15 resumed_is_cast; then pass "cast screen opened by a relay command"; else fail "cast screen not shown after the relay start (resumed: ${RESUMED:-nothing})"; fi
            sleep 3
            screenshot 03-cast-relay
            relay_step stop "$R1"
            if relay_verdict "encrypted cast stop"; then
                if wait_until 10 resumed_is_main; then pass "relay stop -> home screen shown"; else fail "after the relay stop: resumed ${RESUMED:-nothing}"; fi
            fi
        fi
    elif [ "$RELAY_RC" != 2 ]; then
        info "relay cast test skipped here (needs the setup and a new enough web engine)"
    fi
fi

# ---------------------------------------------------------------- keep screen on
if [ "$(status_field keepAwake)" = true ]; then pass "keep screen on is the default"; else fail "status.keepAwake is not true by default"; fi
if S dumpsys power | grep -i 'officetv' | grep -qi 'wake'; then pass "screen wake lock held"; else warn "no officetv wake lock in 'dumpsys power'"; fi

# ---------------------------------------------------------------- process death
crash_scan "before restarts"
old=$OTV_PID
pid=$(app_pids | head -n 1)
if [ -z "$pid" ]; then
    warn "could not find the app process; kill test skipped"
else
    S run-as "$PKG" kill -9 "$pid" >/dev/null
    if wait_until 10 eval '! app_pids | grep -qx "$pid"'; then
        # START_STICKY, the accessibility binding or ServiceJob should bring it back without a user.
        if wait_otv 60 "$old" && forward "$PORT" && wait_until 20 server_up; then
            pass "background service came back by itself after the app process was killed"
        else
            warn "background service did not come back by itself within 60 s after the app process was killed"
        fi
    else
        warn "could not kill the app process (run-as); kill test skipped"
    fi
fi

old=$(otv_last | cut -d' ' -f1)
S am force-stop "$PKG" >/dev/null
if wait_until 15 server_down; then pass "force-stop stopped the app"; else info "test API still answered after force-stop"; fi
[ "$GRANT" = a11y ] || [ "$GRANT" = both ] && grant_a11y  # Android disables a force-stopped app's service
launch_app || fail "launcher could not start the app after force-stop"
wait_app_on_screen 30 || fail "home screen not shown after force-stop (resumed: ${RESUMED:-nothing})"
need_api "$old" "after force-stop + start"
refresh_code
if printf '%s' "$CODE" | grep -qE '^[0-9]{4}$'; then pass "TV shows a 4-digit code after restart ($CODE)"; else fail "no 4-digit code after restart ('$CODE')"; fi
case $GRANT in
    a11y | both) wait_until 20 a11y_on && pass "accessibility connected again after restart" || warn "accessibility not connected after restart" ;;
esac
sleep 2
screenshot 04-after-restart
save_env
KEEP_FORWARD=1

crash_scan "smoke test"
finish
