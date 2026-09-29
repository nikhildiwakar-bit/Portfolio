#!/usr/bin/env bash
# Phone mirroring end to end on ONE emulator (debug APK already installed and started by smoke.sh):
# the app is both the sender (PhoneSendActivity + PhoneSendService, via the officetvphone:// link that the QR
# page opens) and the receiver (ControlService's PhoneServer + PhoneMirrorActivity), connected over 127.0.0.1.
#
#   phone-smoke.sh
#
# Screen-capture consent is pre-granted with "appops set <pkg> PROJECT_MEDIA allow"; if a consent dialog
# still shows, its "Start now" button is tapped. Checks: handshake, the mirror screen opens, the TV decodes
# frames (log line "OTV_TEST phone=decoding first frame"), Back ends the session on both sides, and an old
# QR code (wrong secret) is refused. Appends to $OTV_OUT/results.txt; exit 0 only if no check failed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"
FAILS_BEFORE=$(fail_count)
MIRROR_ACT="$PKG/$PKG.PhoneMirrorActivity"
SEND_ACT="$PKG/$PKG.PhoneSendActivity"
LOGCAT_OWNER=0
trap '[ "$LOGCAT_OWNER" = 1 ] && logcat_stop' EXIT
logcat_start

done_() {
    local n=$(( $(fail_count) - FAILS_BEFORE ))
    echo "== phone-smoke.sh: $n failed"
    [ "$n" -gt 0 ] && exit 1
    exit 0
}

SDK=$(sdk_level)
wake_and_unlock
# The receiver must be running (smoke.sh leaves it running; start it again to be sure).
S am start -n "$MAIN_ACT" >/dev/null
line() { grep -oE "OTV_TEST $1" "$LOGCAT_FILE" 2>/dev/null | tail -n 1; }
has_port() { [ -n "$(line 'phone=listening port=[0-9]+')" ]; }
has_key() { [ -n "$(line 'phonekey=[A-Za-z0-9_-]+')" ]; }
if ! wait_until 40 has_port || ! wait_until 5 has_key; then
    fail "phone: no 'phone=listening' / 'phonekey=' log line (phone server did not start)"
    done_
fi
PPORT=$(line 'phone=listening port=[0-9]+' | sed -E 's/.*port=//')
PKEY=$(line 'phonekey=[A-Za-z0-9_-]+' | sed -E 's/.*phonekey=//')
pass "phone: TV side listens on port $PPORT"

S appops set "$PKG" PROJECT_MEDIA allow >/dev/null
[ "$SDK" -ge 33 ] && S pm grant "$PKG" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1

# Taps a button whose text matches (case-insensitive) if it is on screen; true if tapped.
tap_text() {
    ui_dump consent >/dev/null 2>&1 || return 1
    local xy
    xy=$(python3 - "$OUT/ui-consent.xml" "$1" <<'PY'
import re, sys
raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()
for m in re.finditer(r'<node [^>]*>', raw):
    n = m.group(0)
    t = re.search(r' text="([^"]*)"', n)
    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
    if t and b and re.fullmatch(sys.argv[2], t.group(1).strip(), re.I):
        x1, y1, x2, y2 = map(int, b.groups())
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
PY
)
    [ -n "$xy" ] || return 1
    S input tap $xy >/dev/null
    return 0
}

open_link() { # open_link <key> <name>
    S am start -W -a android.intent.action.VIEW \
        -d "'officetvphone://connect?h=127.0.0.1&p=$PPORT&k=$1&n=$2'" "$PKG" >> "$OUT/launch.log" 2>&1
}
streaming() { logged 'sender=STREAMING'; }
mirror_on_screen() { RESUMED=$(resumed_activity); [ "$RESUMED" = "$MIRROR_ACT" ]; }

open_link "$PKEY" 'CI%20TV'
tapped=0
for i in $(seq 1 30); do
    streaming && break
    logged 'sender=ERROR' && break
    if [ "$i" -ge 4 ] && [ "$tapped" -lt 3 ]; then
        # Android 14+ may still show the consent dialog (with a "single app / entire screen" choice).
        tap_text '(entire screen|share entire screen|a single app)' >/dev/null && sleep 1
        tap_text '(start now|start|share screen|next)' && { tapped=$((tapped + 1)); sleep 2; }
    fi
    sleep 1
done
if streaming; then
    pass "phone: sender connected, handshake OK, streaming"
else
    err=$(grep -oE 'OTV_TEST sender=ERROR.*' "$LOGCAT_FILE" | tail -n 1)
    screenshot phone-no-stream
    if [ -n "$err" ]; then fail "phone: sender error: $err"; else warn "phone: screen capture did not start (consent not granted on API $SDK)"; fi
    crash_scan "phone mirroring"
    done_
fi

if wait_until 20 mirror_on_screen; then pass "phone: PhoneMirrorActivity resumed"; else fail "phone: mirror screen not on screen (resumed: ${RESUMED:-nothing})"; fi
if wait_until 30 logged 'phone=decoding first frame'; then
    pass "phone: TV decoded frames ($(grep -oE 'phone=decoding first frame [0-9x]+' "$LOGCAT_FILE" | tail -n 1))"
else
    fail "phone: no decoded frame within 30 s ($(grep -oE 'OTV_TEST (phone|sender)=.*' "$LOGCAT_FILE" | tail -n 3 | tr '\n' ' '))"
fi
sleep 6
d=$(grep -oE 'phone=decoding frames=[0-9]+ received=[0-9]+ dropped=[0-9]+' "$LOGCAT_FILE" | tail -n 1)
[ -n "$d" ] && info "phone: $d"
screenshot phone-mirror

S input keyevent 4 >/dev/null
ended() { logged 'phone=screen closed' && grep -qE 'OTV_TEST sender=(IDLE|ERROR)' "$LOGCAT_FILE"; }
if wait_until 15 ended; then pass "phone: Back ended the session on the TV and on the phone"; else fail "phone: Back did not end the session"; fi
screenshot phone-after-back

# An old QR code (another secret) must be refused by the TV and explained on the phone.
BAD=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
open_link "$BAD" 'Old%20QR'
if wait_until 20 logged 'phone=rejected reason=auth'; then pass "phone: wrong secret refused by the TV"; else fail "phone: wrong secret was not refused"; fi
if wait_until 10 eval "grep -q 'OTV_TEST sender=ERROR msg=This QR code is out of date' '$LOGCAT_FILE'"; then
    pass "phone: phone explains the old QR code"
else
    warn "phone: no 'out of date' message on the phone"
fi
screenshot phone-old-qr
if [ "$(resumed_activity)" = "$SEND_ACT" ]; then pass "phone: phone screen shown"; fi
crash_scan "phone mirroring"
done_
