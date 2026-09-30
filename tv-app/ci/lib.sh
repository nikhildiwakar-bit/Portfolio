# Shared helpers for the Office TV emulator scripts (bash). Source it, do not run it.
# Env: ADB (default adb), OTV_OUT (output folder, default ci-out), ADB_TIMEOUT (seconds per adb call, default 90).

PKG=com.nikhil.officetv
MAIN_ACT="$PKG/$PKG.MainActivity"
CAST_ACT="$PKG/$PKG.CastActivity"
NOT_AVAILABLE='This feature is not available on this TV app version.'
SITE='nikhildiwakar-bit.github.io/Portfolio/tv'
ADB=${ADB:-adb}
OUT=${OTV_OUT:-ci-out}
RESULTS="$OUT/results.txt"
LOGCAT_FILE="$OUT/logcat.txt"
export LC_ALL=C
mkdir -p "$OUT/shots" "$OUT/http"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

pass() { printf 'PASS  %s\n' "$*" | tee -a "$RESULTS"; }
fail() { printf 'FAIL  %s\n' "$*" | tee -a "$RESULTS"; }
warn() { printf 'WARN  %s\n' "$*" | tee -a "$RESULTS"; }
info() { printf 'INFO  %s\n' "$*" | tee -a "$RESULTS"; }
fail_count() { local n; n=$(grep -c '^FAIL' "$RESULTS" 2>/dev/null); printf '%s\n' "${n:-0}"; }

# adb with a hard timeout, so a stuck device cannot hang the job.
A() { timeout "${ADB_TIMEOUT:-90}" "$ADB" "$@"; }
# adb shell with CR stripped (adbd before Android 7 uses a pty and sends CRLF). Never trust its exit code:
# before Android 7 it is always 0.
S() { timeout "${ADB_TIMEOUT:-90}" "$ADB" shell "$@" 2>&1 | tr -d '\r'; }

# wait_until <seconds> <command...>: runs the command once a second until it succeeds or time runs out.
wait_until() {
    local end=$(( $(date +%s) + $1 ))
    shift
    while :; do
        "$@" && return 0
        [ "$(date +%s)" -ge "$end" ] && return 1
        sleep 1
    done
}

sdk_level() { S getprop ro.build.version.sdk | tr -dc '0-9'; }
is_tv() { S pm list features | grep -q 'android.software.leanback'; }

wake_and_unlock() {
    S input keyevent 224 >/dev/null  # KEYCODE_WAKEUP
    S input keyevent 82 >/dev/null   # MENU dismisses a non-secure keyguard on old images
    S wm dismiss-keyguard >/dev/null
    S svc power stayon true >/dev/null
}

# A random cast session id (12-32 chars of [a-z0-9], PROTOCOL.md section 8).
new_session() { printf 'ci%s\n' "$(head -c 64 /dev/urandom | od -An -tx1 | tr -dc 'a-f0-9' | head -c 14)"; }

# ---------- activities ----------

# "pkg/.Cls" -> "pkg/pkg.Cls"
norm_comp() {
    local p=${1%%/*} c=${1#*/}
    case $c in .*) c=$p$c ;; esac
    printf '%s/%s\n' "$p" "$c"
}

# Prints the resumed activity as pkg/full.Class, or nothing. The field name differs by Android version:
# mResumedActivity / mFocusedActivity (5-9), ResumedActivity (10+), topResumedActivity (12+).
resumed_activity() {
    local d key line comp
    d=$(S dumpsys activity activities)
    for key in topResumedActivity ResumedActivity mResumedActivity mFocusedActivity; do
        line=$(printf '%s\n' "$d" | grep -E "(^|[[:space:]])${key}[:=][[:space:]]*ActivityRecord\{" | head -n 1)
        comp=$(printf '%s\n' "$line" | sed -nE 's/.*ActivityRecord\{[^ ]+ u[0-9]+ ([^ }]+\/[^ }]+).*/\1/p')
        if [ -n "$comp" ]; then norm_comp "$comp"; return 0; fi
    done
    # Fallback: the window manager's focused app.
    line=$(S dumpsys window windows | grep -E 'mFocusedApp=|mCurrentFocus=' | grep -E 'u[0-9]+ [^ ]+/' | head -n 1)
    comp=$(printf '%s\n' "$line" | sed -nE 's/.* u[0-9]+ ([^ }]+\/[^ }]+).*/\1/p')
    [ -n "$comp" ] && norm_comp "$comp"
    return 0
}

# Number of distinct CastActivity records alive (0, 1, ...). Must never be more than 1.
cast_count() {
    S dumpsys activity activities | grep -oE "ActivityRecord\{[0-9a-f]+ u[0-9]+ $PKG/(\.|$PKG\.)CastActivity" \
        | awk '{print $1}' | sort -u | wc -l | tr -d ' '
}

RESUMED=""
is_home() { # is_home <component>
    local p=${1%%/*} h
    for h in $HOME_PKGS; do [ "$p" = "$h" ] && return 0; done
    return 1
}
# Condition helpers for wait_until; they leave the last seen activity in $RESUMED.
resumed_any() { RESUMED=$(resumed_activity); [ -n "$RESUMED" ]; }
resumed_is_ours() { RESUMED=$(resumed_activity); [ "${RESUMED%%/*}" = "$PKG" ]; }
resumed_is_main() { RESUMED=$(resumed_activity); [ "$RESUMED" = "$MAIN_ACT" ]; }
resumed_is_cast() { RESUMED=$(resumed_activity); [ "$RESUMED" = "$CAST_ACT" ]; }
resumed_is_home() { RESUMED=$(resumed_activity); [ -n "$RESUMED" ] && is_home "$RESUMED"; }

# Launcher packages: the one on screen after HOME, plus what the system resolves HOME to (Android 7+).
detect_home() {
    local r
    S input keyevent 3 >/dev/null
    sleep 2
    wait_until 15 resumed_any
    HOME_PKGS=${RESUMED%%/*}
    if [ "${SDK:-0}" -ge 24 ]; then
        r=$(S cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME \
            | grep / | tail -n 1 | tr -d ' ')
        case $r in
            */*ResolverActivity | "") ;;
            */*) HOME_PKGS="$HOME_PKGS ${r%%/*}" ;;
        esac
    fi
    HOME_PKGS=$(printf '%s\n' $HOME_PKGS | grep -v "^$PKG\$" | sort -u | tr '\n' ' ')
}

go_home() { S input keyevent 3 >/dev/null; wait_until 10 resumed_is_home; }

# Opens the app the way a user does: from the launcher (the TV launcher uses LEANBACK_LAUNCHER).
launch_app() {
    local cat=android.intent.category.LAUNCHER out
    [ "${IS_TV:-0}" = 1 ] && cat=android.intent.category.LEANBACK_LAUNCHER
    out=$(S monkey -p "$PKG" -c "$cat" 1)
    printf '%s\n' "$out" >> "$OUT/launch.log"
    case $out in *"No activities found"* | *"monkey aborted"* | *"Error"*) return 1 ;; esac
    return 0
}

# Waits until one of our activities is on screen. A runtime-permission dialog on top counts as opened (it is
# dismissed so the tests can go on).
wait_app_on_screen() {
    wait_until "${1:-30}" resumed_is_ours && return 0
    case $RESUMED in
        *permissioncontroller*/*GrantPermissions* | *packageinstaller*/*GrantPermissions*)
            info "permission dialog shown over the app: $RESUMED"
            screenshot permission-dialog
            S input keyevent 4 >/dev/null
            wait_until 10 resumed_is_ours
            return ;;
    esac
    return 1
}

# ---------- screenshots, UI dump, logcat ----------

screenshot() { # screenshot <name>
    local f="$OUT/shots/$1.png"
    A exec-out screencap -p > "$f" 2>/dev/null
    if [ "$(head -c 4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')" != 89504e47 ]; then
        S screencap -p /data/local/tmp/otv-shot.png >/dev/null
        A pull /data/local/tmp/otv-shot.png "$f" >/dev/null 2>&1 || rm -f "$f"
    fi
    [ -s "$f" ] && log "screenshot $f" || log "screenshot $1 failed"
}

# ui_dump <name>: the view tree on screen (uiautomator XML) into $OUT/ui-<name>.xml. Fails if unavailable.
ui_dump() {
    local f="$OUT/ui-$1.xml"
    S uiautomator dump /data/local/tmp/otv-ui.xml >/dev/null
    S cat /data/local/tmp/otv-ui.xml > "$f"
    grep -q '<hierarchy' "$f"
}

# ui_check <xml> <must-contain...>: prints problems (missing texts, overlapping texts/buttons), one per line.
ui_check() {
    python3 - "$@" <<'PY'
import re, sys
import xml.etree.ElementTree as ET
path, musts = sys.argv[1], sys.argv[2:]
raw = open(path, encoding='utf-8', errors='replace').read()
raw = raw[raw.find('<hierarchy'):raw.rfind('</hierarchy>') + len('</hierarchy>')]
root = ET.fromstring(raw)
nodes = []
for n in root.iter('node'):
    if n.get('package') != 'com.nikhil.officetv':
        continue
    text = (n.get('text') or '').strip()
    m = re.match(r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', n.get('bounds') or '')
    if not text or not m or not n.get('class', '').endswith(('TextView', 'Button', 'EditText')):
        continue
    x1, y1, x2, y2 = map(int, m.groups())
    if x2 - x1 > 2 and y2 - y1 > 2:
        nodes.append((text, x1, y1, x2, y2))
alltext = '\n'.join(t for t, *_ in nodes)
for want in musts:
    if want not in alltext:
        print('missing text: %r' % want)
for i in range(len(nodes)):
    for j in range(i + 1, len(nodes)):
        a, b = nodes[i], nodes[j]
        w = min(a[3], b[3]) - max(a[1], b[1])
        h = min(a[4], b[4]) - max(a[2], b[2])
        if w > 3 and h > 3:
            print('overlap: %r %s and %r %s' % (a[0][:40], a[1:], b[0][:40], b[1:]))
PY
}

logcat_alive() { [ -f "$OUT/logcat.pid" ] && kill -0 "$(cat "$OUT/logcat.pid")" 2>/dev/null; }

# Captures the whole device log into $LOGCAT_FILE in the background (no-op if already running).
logcat_start() {
    logcat_alive && return 0
    [ -s "$LOGCAT_FILE" ] || A logcat -c >/dev/null 2>&1
    ( exec "$ADB" logcat -v threadtime >> "$LOGCAT_FILE" 2>&1 < /dev/null ) &
    echo $! > "$OUT/logcat.pid"
    LOGCAT_OWNER=1
}

logcat_stop() {
    logcat_alive && kill "$(cat "$OUT/logcat.pid")" 2>/dev/null
    rm -f "$OUT/logcat.pid"
}

# Last "OTV_TEST port=.. token=.. code=.." line (debug builds log it when the test API starts) as
# "<pid> <port> <token> <code>", or nothing.
otv_last() {
    logcat_alive || logcat_start
    grep 'OTV_TEST port=' "$LOGCAT_FILE" 2>/dev/null | tail -n 1 \
        | sed -nE 's/^[0-9-]+ [0-9:.]+ +([0-9]+) .*OTV_TEST port=([0-9]+) token=([0-9a-f]+) code=([0-9A-Za-z]+).*/\1 \2 \3 \4/p'
}

# wait_otv <seconds> [old-pid]: waits for an OTV_TEST port line (from a process other than old-pid) and sets
# OTV_PID PORT TOKEN CODE.
wait_otv() {
    local end=$(( $(date +%s) + $1 )) old=${2:-} l
    while :; do
        l=$(otv_last)
        if [ -n "$l" ] && [ "${l%% *}" != "$old" ]; then
            set -- $l
            OTV_PID=$1 PORT=$2 TOKEN=$3 CODE=$4
            return 0
        fi
        [ "$(date +%s)" -ge "$end" ] && return 1
        sleep 1
    done
}

# logged <regex>: true if an "OTV_TEST <regex>" line is in the log.
logged() { grep -qE "OTV_TEST $1" "$LOGCAT_FILE" 2>/dev/null; }

# log_lines: lines captured so far (a mark for log_from / otv_since).
log_lines() { local n; n=$(wc -l < "$LOGCAT_FILE" 2>/dev/null | tr -d ' '); printf '%s\n' "${n:-0}"; }
# log_from <mark>: the log lines captured after that mark.
log_from() { tail -n "+$(( ${1:-0} + 1 ))" "$LOGCAT_FILE" 2>/dev/null; }
# otv_since <mark> <regex>: text of the last "OTV_TEST <regex>..." line after the mark (without "OTV_TEST "), or nothing.
otv_since() { log_from "$1" | grep -oE "OTV_TEST $2.*" | tail -n 1 | sed 's/^OTV_TEST //'; }

# Pids of our app's main process (ps output differs: Android 8+ needs -A, older ps rejects it).
app_pids() {
    S 'ps -A 2>/dev/null; ps 2>/dev/null' | awk -v p="$PKG" '$NF == p { print $2 }' | sort -u
}

# crash_scan <label>: FAIL for crashes/ANRs of our app in the log lines not scanned yet.
crash_scan() {
    local from to new
    [ -f "$LOGCAT_FILE" ] || { warn "$1: no logcat captured"; return; }
    from=$(cat "$OUT/crash-scan.offset" 2>/dev/null || echo 0)
    to=$(wc -l < "$LOGCAT_FILE" | tr -d ' ')
    echo "$to" > "$OUT/crash-scan.offset"
    new=$(tail -n "+$((from + 1))" "$LOGCAT_FILE" | head -n "$((to - from))")
    local fatal anr native
    fatal=$(printf '%s\n' "$new" | awk -v p="$PKG" '
        /FATAL EXCEPTION/ { f = NR }
        f && NR <= f + 3 && $0 ~ ("Process: " p "[,:]") { print; f = 0 }' | head -n 5)
    anr=$(printf '%s\n' "$new" | grep -F "ANR in $PKG" | head -n 5)
    native=$(printf '%s\n' "$new" | grep -E ">>> $PKG(:[^ ]*)? <<<" | head -n 5)
    if [ -n "$fatal" ] || [ -n "$native" ]; then
        fail "$1: app crashed (FATAL EXCEPTION / native crash), see logcat.txt"
        printf '%s\n%s\n' "$fatal" "$native" | sed '/^$/d; s/^/      /'
        # The stack trace goes into the job log too, so a crash can be read without downloading artifacts.
        printf '%s\n' "$new" | grep -A 25 'FATAL EXCEPTION' | head -n 60 | tee "$OUT/crash-$(date +%s).txt" \
            | sed 's/^/      | /' | head -n 30
    else
        pass "$1: no crash of $PKG in logcat"
    fi
    if [ -n "$anr" ]; then
        fail "$1: app not responding (ANR)"
        printf '%s\n' "$anr" | sed 's/^/      /'
    else
        pass "$1: no ANR of $PKG"
    fi
    # Android 10+ logs blocked background starts; useful when an open check fails.
    printf '%s\n' "$new" | grep -iE "background activity (start|launch)" | grep -F "$PKG" | head -n 3 \
        | sed 's/^/INFO  blocked-start log: /' | tee -a "$RESULTS"
}

# ---------- debug test API (loopback on the device, through adb forward) ----------

HTTP_BODY="$OUT/http/last"

forward() { # forward <device-port>: sets LPORT
    local p
    [ -n "${LPORT:-}" ] && A forward --remove "tcp:$LPORT" >/dev/null 2>&1
    p=$(A forward tcp:0 "tcp:$1" 2>/dev/null | tr -dc '0-9')
    if [ -z "$p" ]; then
        p=$(( 20000 + RANDOM % 20000 ))
        A forward "tcp:$p" "tcp:$1" >/dev/null 2>&1 || return 1
    fi
    LPORT=$p
}

# http <METHOD> <path> [json-body] [token]: prints the HTTP status (000 = no answer); the body is in $HTTP_BODY.
http() {
    local m=$1 path=$2 body=${3-} tok=${4-${TOKEN:-}} code
    local args=(-sS --noproxy '*' -o "$HTTP_BODY" -w '%{http_code}' -m 30 -H "X-Token: $tok")
    [ "$m" = POST ] && args+=(-X POST -H 'Content-Type: application/json; charset=utf-8' --data-binary "$body")
    : > "$HTTP_BODY"
    code=$(curl "${args[@]}" "http://127.0.0.1:$LPORT$path" 2>>"$OUT/http/curl.log") || true
    printf '%s' "${code:-000}"
}

server_up() { [ "$(http GET /api/status)" = 200 ] && [ "$(jget "$HTTP_BODY" appVersion)" != '!json' ]; }
server_down() { [ "$(http GET /api/status)" = 000 ]; }

# jget <file> <key>: a top-level field of a JSON object (booleans as true/false, missing/null as empty,
# lists joined with commas). Prints "!json" if the file is not a JSON object.
jget() {
    python3 - "$1" "$2" <<'PY'
import json, sys
try:
    o = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    o = None
if not isinstance(o, dict):
    print('!json')
else:
    v = o.get(sys.argv[2])
    if isinstance(v, list):
        v = ','.join(str(x) for x in v)
    print('true' if v is True else 'false' if v is False else '' if v is None else v)
PY
}

# status_field <key>: a field of GET /api/status (empty if the call fails).
status_field() {
    [ "$(http GET /api/status)" = 200 ] || return 0
    cp "$HTTP_BODY" "$OUT/http/status-last.json" 2>/dev/null
    jget "$HTTP_BODY" "$1"
}

# api_cmd <json> <label>: runs a command through the test API exactly as if it came through the relay.
# Sets CMD_OK and CMD_MSG; the answer stays in $HTTP_BODY (and $OUT/http/<label>.json).
api_cmd() {
    local code
    code=$(http POST /api/cmd "$1")
    cp "$HTTP_BODY" "$OUT/http/$(printf '%s' "$2" | tr -c 'A-Za-z0-9_-' '_').json" 2>/dev/null
    CMD_OK=$(jget "$HTTP_BODY" ok)
    CMD_MSG=$(jget "$HTTP_BODY" msg)
    [ "$code" = 200 ] || CMD_OK="http-$code"
}

# attach_api [seconds]: connects to the running app's test API (its last "OTV_TEST port=" line, else the
# otv-test.env that smoke.sh saved); sets PORT TOKEN LPORT. True once GET /api/status answers.
attach_api() {
    if ! wait_otv "${1:-10}" && [ -f "$OUT/otv-test.env" ]; then
        PORT=$(sed -n 's/^PORT=//p' "$OUT/otv-test.env")
        TOKEN=$(sed -n 's/^TOKEN=//p' "$OUT/otv-test.env")
    fi
    [ -n "${PORT:-}" ] && [ -n "${TOKEN:-}" ] && forward "$PORT" && wait_until 10 server_up
}

# play_tone <ms>: the debug app plays a 440 Hz test tone (USAGE_MEDIA, RMS about 8500) for <ms> ms on the device;
# 0 stops it. A new tone replaces the one playing. True if the app accepted it (the answer is in $HTTP_BODY).
play_tone() {
    TONE_HTTP=$(http POST "/api/tone?ms=$1" '{}')
    [ "$TONE_HTTP" = 200 ] && [ "$(jget "$HTTP_BODY" ok)" = true ]
}

# ---------- media volume (STREAM_MUSIC = 3) ----------

# media_volume: the media volume as "<index>/<max>" ("<index>/?" from dumpsys), or nothing if it cannot be read.
# Android 11+ has "cmd media_session volume", Android 10 and older the "media" tool.
media_volume() {
    local c out v
    for c in 'cmd media_session' media; do
        out=$(S "$c volume --stream 3 --get")
        printf '%s\n' "$out" >> "$OUT/volume.log"
        v=$(printf '%s\n' "$out" | sed -nE 's/.*volume is ([0-9]+) in range \[[0-9]+\.\.([0-9]+)\].*/\1\/\2/p' | tail -n 1)
        [ -n "$v" ] && { printf '%s\n' "$v"; return 0; }
    done
    # "- STREAM_MUSIC:" block of dumpsys audio: "Current: 2 (speaker): 5, ..." or "streamVolume:5".
    v=$(S dumpsys audio | awk '/^- STREAM_MUSIC:/ { f = 1; next } f && /^- STREAM_/ { exit }
        f && /streamVolume:/ { sub(/.*streamVolume:/, ""); print $1 + 0; exit }
        f && /\(speaker\): [0-9]+/ { sub(/.*\(speaker\): /, ""); print $1 + 0; exit }')
    [ -n "$v" ] && printf '%s/?\n' "$v"
    return 0
}

# set_media_volume <index>: sets the media volume without showing the volume panel; true if it reads back.
set_media_volume() {
    local c
    for c in 'cmd media_session' media; do
        S "$c volume --stream 3 --set $1" >> "$OUT/volume.log"
        [ "$(media_volume | cut -d/ -f1)" = "$1" ] && return 0
    done
    return 1
}

save_env() {
    cat > "$OUT/otv-test.env" <<EOF
PORT=$PORT
TOKEN=$TOKEN
LPORT=$LPORT
CODE=$CODE
OTV_PID=$OTV_PID
SDK=$SDK
IS_TV=$IS_TV
HOME_PKGS='$HOME_PKGS'
EOF
}
