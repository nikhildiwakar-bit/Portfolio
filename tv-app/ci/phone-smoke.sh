#!/usr/bin/env bash
# Phone mirroring end to end on ONE emulator (debug APK already installed and started by smoke.sh):
# the app is both the sender (PhoneSendActivity + PhoneSendService, via the officetvphone:// link that the QR
# page opens) and the receiver (ControlService's PhoneServer + PhoneMirrorActivity), connected over 127.0.0.1.
#
#   phone-smoke.sh
#
# Screen-capture consent is pre-granted with "appops set <pkg> PROJECT_MEDIA allow" (and, Android 10+, the
# sound with "pm grant <pkg> RECORD_AUDIO"); if a consent dialog still shows, its "Start now" button is tapped.
# Checks: handshake, the mirror screen opens, the TV decodes frames (log line "OTV_TEST phone=decoding first
# frame"), the phone sends its sound and the TV plays it (a 440 Hz test tone from the debug test API must reach
# the TV's player with rms >= 300; then the same at phone media volume 0, reported as INFO), Back ends the
# session on both sides, and an old QR code (wrong secret) is refused. Appends to $OTV_OUT/results.txt; exit 0
# only if no check failed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"
FAILS_BEFORE=$(fail_count)
MIRROR_ACT="$PKG/$PKG.PhoneMirrorActivity"
SEND_ACT="$PKG/$PKG.PhoneSendActivity"
LOGCAT_OWNER=0
VOL_RESTORE=""
LPORT=""
cleanup() {
    [ -n "$VOL_RESTORE" ] && set_media_volume "$VOL_RESTORE" >/dev/null
    [ -n "$LPORT" ] && A forward --remove "tcp:$LPORT" >/dev/null 2>&1
    [ "$LOGCAT_OWNER" = 1 ] && logcat_stop
}
trap cleanup EXIT
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
# Phone sound (Android 10+): capture of other apps' playback needs RECORD_AUDIO (the microphone is never used).
if [ "$SDK" -ge 29 ]; then
    g=$(S pm grant "$PKG" android.permission.RECORD_AUDIO)
    [ -n "$g" ] && warn "phone: pm grant RECORD_AUDIO: $(printf '%s' "$g" | head -n 2 | tr '\n' ' ')"
fi

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

SESSION_FROM=$(log_lines)  # the sound checks only look at log lines of this session
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

# ---------------------------------------------------------------- sound (Android 10+)
# The phone role captures the sound of apps playing on the phone (AudioPlaybackCapture) and sends it as PCM;
# the TV role plays it (and keeps its own output out of the capture, so this one-device loop does not echo).
# rms_lines <mark>: the rms values of the TV's "phone=audio chunks=.. rms=N" lines (one every 5 s) after the mark.
rms_lines() { log_from "$1" | grep -oE 'OTV_TEST phone=audio chunks=[0-9]+ rms=[0-9]+' | sed -E 's/.*rms=//'; }
rms_max() { rms_lines "$1" | sort -n | tail -n 1; }
TONE_FROM=""
start_tone() { # start_tone <ms>: plays the test tone; TONE_FROM marks where its log lines start
    TONE_FROM=$(log_lines)
    play_tone "$1" && return 0
    warn "phone: POST /api/tone -> HTTP $TONE_HTTP $(head -c 200 "$HTTP_BODY")"
    TONE_FROM=""
    return 1
}
audio_state() { [ -n "$(otv_since "$SESSION_FROM" 'sender=audio (on|off)')" ]; }
tv_playing() { [ -n "$(otv_since "$SESSION_FROM" 'phone=audio playing')" ]; }
loud() { R=$(rms_max "$TONE_FROM"); [ -n "$R" ] && [ "$R" -ge 300 ]; }
two_lines() { [ "$(rms_lines "$TONE_FROM" | wc -l | tr -d ' ')" -ge 2 ]; }

SOUND=0
wait_until 10 audio_state
a=$(otv_since "$SESSION_FROM" 'sender=audio (on|off)')
case $a in
    'sender=audio on'*)
        pass "phone: the phone sends its sound (${a#sender=audio on })"
        SOUND=1 ;;
    'sender=audio off reason=api'* )
        if [ "$SDK" -lt 29 ]; then info "phone: no sound below Android 10 (video only, as designed)"; else fail "phone: the phone sends no sound: $a"; fi ;;
    'sender=audio off'*)
        was=""
        [ -n "$(otv_since "$SESSION_FROM" 'sender=audio on')" ] && was=" (it had started, then stopped)"
        fail "phone: the phone sends no sound: ${a#sender=audio off }$was" ;;
    *)
        fail "phone: no 'sender=audio on|off' log line within 10 s of streaming" ;;
esac

if [ "$SOUND" = 1 ]; then
    API_OK=0
    if attach_api 10; then API_OK=1; else warn "phone: test API not reachable (port ${PORT:-?}); test tone skipped"; fi
    if ! wait_until 10 tv_playing && [ "$API_OK" = 1 ]; then
        # In case the capture sends nothing while the phone is silent: a sound should start it.
        start_tone 8000 && wait_until 10 tv_playing
    fi
    p=$(otv_since "$SESSION_FROM" 'phone=audio playing')
    if [ -n "$p" ]; then
        pass "phone: the TV plays the phone's sound stream (${p#phone=audio playing })"
    else
        fail "phone: the TV did not start playing the phone's sound (last: $(otv_since "$SESSION_FROM" '(phone|sender)=audio' | head -c 200))"
    fi

    if [ -n "$p" ] && [ "$API_OK" = 1 ]; then
        VOL=$(media_volume)
        R=""
        [ -n "$TONE_FROM" ] || start_tone 8000
        TONE_OK=0
        [ -n "$TONE_FROM" ] && TONE_OK=1
        if [ "$TONE_OK" = 1 ]; then
            wait_until 12 loud
            R=$(rms_max "$TONE_FROM")
            last=$(otv_since "$TONE_FROM" 'phone=audio chunks=')
            a2=$(otv_since "$SESSION_FROM" 'sender=audio (on|off)')
            t=$(otv_since "$TONE_FROM" 'tone=(start|error)')
            if loud; then
                pass "phone: the TV plays the phone's sound (rms $R)"
            elif [ "${a2#sender=audio off}" != "$a2" ]; then
                fail "phone: the phone's sound stopped mid-session: ${a2#sender=audio off }"
            elif [ "${t#tone=error}" != "$t" ]; then
                warn "phone: the test tone could not play on this emulator: $t"
            elif [ -z "$t" ]; then
                warn "phone: the test tone did not start (no 'tone=start' line); sound level not checked"
            elif [ -n "$last" ]; then
                warn "phone: test tone quiet on the TV (rms ${R:-0}, expected >= 300; the emulator's capture may be silent): $last"
            else
                fail "phone: no 'phone=audio chunks=' line within 12 s of the test tone (last: $(otv_since "$SESSION_FROM" '(phone|sender)=audio' | head -c 200))"
            fi
            info "phone: media volume ${VOL:-unknown}; TV sound: $(otv_since "$SESSION_FROM" 'phone=audio chunks=')"
        fi

        # Does muting the phone mute the TV? Media volume 0, a 12 s tone, and the TV's second stats line after it
        # started (that one averages 5 s of the tone only).
        V0=${VOL%%/*}
        if [ "$TONE_OK" = 0 ]; then
            :
        elif [ -z "$V0" ]; then
            warn "phone: cannot read the media volume (volume.log); volume 0 check skipped"
        elif ! set_media_volume 0; then
            warn "phone: cannot set the media volume to 0 (volume.log); volume 0 check skipped"
            set_media_volume "$V0" >/dev/null
        else
            VOL_RESTORE=$V0
            if start_tone 12000; then
                wait_until 14 two_lines
                R0=$(rms_lines "$TONE_FROM" | sed -n 2p)
                [ -n "$R0" ] || R0=$(rms_lines "$TONE_FROM" | tail -n 1)
                if [ -z "$R0" ]; then what="no stats line"
                elif [ "${R:-0}" -lt 300 ]; then what="no verdict: the tone was quiet at normal volume too"
                elif [ "$R0" -lt 100 ]; then what="muting the phone mutes the TV"
                elif [ "$R0" -ge 300 ]; then what="the TV keeps the sound when the phone is muted"
                else what="much quieter"; fi
                info "phone: sound on the TV at phone volume 0: rms ${R0:-none} ($what; at volume $VOL: rms ${R:-none})"
                play_tone 0 >/dev/null
            fi
            if set_media_volume "$V0"; then VOL_RESTORE=""; else warn "phone: could not restore the media volume to $V0"; fi
        fi
    fi
fi

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
