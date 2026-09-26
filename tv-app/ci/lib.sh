# Shared helpers for the Office TV emulator scripts (bash). Source it, do not run it.
# Env: ADB (default adb), OTV_OUT (output folder, default ci-out), ADB_TIMEOUT (seconds per adb call, default 90).

PKG=com.nikhil.officetv
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
fail_count() { grep -c '^FAIL' "$RESULTS" 2>/dev/null || true; }

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

RESUMED=""
is_home() { # is_home <component>
    local p=${1%%/*} h
    for h in $HOME_PKGS; do [ "$p" = "$h" ] && return 0; done
    return 1
}
# Condition helpers for wait_until; they leave the last seen activity in $RESUMED.
resumed_any() { RESUMED=$(resumed_activity); [ -n "$RESUMED" ]; }
resumed_is_ours() { RESUMED=$(resumed_activity); [ "${RESUMED%%/*}" = "$PKG" ]; }
resumed_is_home() { RESUMED=$(resumed_activity); [ -n "$RESUMED" ] && is_home "$RESUMED"; }
# Some other app, or our own ViewerActivity (used when no app on the TV can open the link/file).
resumed_is_other() {
    RESUMED=$(resumed_activity)
    [ -n "$RESUMED" ] || return 1
    case $RESUMED in
        "$PKG/$PKG.ViewerActivity") return 0 ;;
        "$PKG"/*) return 1 ;;
    esac
    ! is_home "$RESUMED"
}
describe_other() {
    case $RESUMED in
        "$PKG/$PKG.ViewerActivity") printf '%s (app ka apna viewer)' "$RESUMED" ;;
        android/*ResolverActivity | android/*ChooserActivity) printf '%s (app chooser dialog)' "$RESUMED" ;;
        *) printf '%s' "$RESUMED" ;;
    esac
}

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

# ---------- screenshots, logcat ----------

screenshot() { # screenshot <name>
    local f="$OUT/shots/$1.png"
    A exec-out screencap -p > "$f" 2>/dev/null
    if [ "$(head -c 4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')" != 89504e47 ]; then
        S screencap -p /data/local/tmp/otv-shot.png >/dev/null
        A pull /data/local/tmp/otv-shot.png "$f" >/dev/null 2>&1 || rm -f "$f"
    fi
    [ -s "$f" ] && log "screenshot $f" || log "screenshot $1 failed"
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

# Last "OTV_TEST pin=.. port=.. code=.." line (debug builds log it after the server starts) as
# "<pid> <pin> <port> <code>", or nothing.
otv_last() {
    logcat_alive || logcat_start
    grep 'OTV_TEST pin=' "$LOGCAT_FILE" 2>/dev/null | tail -n 1 \
        | sed -nE 's/^[0-9-]+ [0-9:.]+ +([0-9]+) .*OTV_TEST pin=([0-9]+) port=([0-9]+) code=([0-9A-Za-z]+).*/\1 \2 \3 \4/p'
}

# wait_otv <seconds> [old-pid]: waits for an OTV_TEST line (from a process other than old-pid) and sets
# OTV_PID PIN PORT CODE.
wait_otv() {
    local end=$(( $(date +%s) + $1 )) old=${2:-} l
    while :; do
        l=$(otv_last)
        if [ -n "$l" ] && [ "${l%% *}" != "$old" ]; then
            set -- $l
            OTV_PID=$1 PIN=$2 PORT=$3 CODE=$4
            return 0
        fi
        [ "$(date +%s)" -ge "$end" ] && return 1
        sleep 1
    done
}

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
        printf '%s\n' "$new" | grep -A 25 'FATAL EXCEPTION' | head -n 60 > "$OUT/crash-$(date +%s).txt"
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

# ---------- HTTP (through adb forward) ----------

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

# http <METHOD> <path> [json-body | @file-for-upload] [pin]: prints the HTTP status (000 = no answer);
# the body is in $HTTP_BODY.
http() {
    local m=$1 path=$2 body=${3-} pin=${4-${PIN:-}} code
    local args=(-sS --noproxy '*' -o "$HTTP_BODY" -w '%{http_code}' -m 30 -H "X-Pin: $pin")
    case $m:$body in
        POST:@*) args+=(-F "file=@${body#@};type=application/pdf") ;;
        POST:*) args+=(-X POST -H 'Content-Type: application/json; charset=utf-8' --data-binary "$body") ;;
    esac
    : > "$HTTP_BODY"
    code=$(curl "${args[@]}" "http://127.0.0.1:$LPORT$path" 2>>"$OUT/http/curl.log") || true
    printf '%s' "${code:-000}"
}

server_up() { [ "$(http GET /)" = 200 ] && grep -q 'Office TV' "$HTTP_BODY"; }
server_down() { [ "$(http GET /)" = 000 ]; }

# jget <file> <key>: a top-level field of a JSON object (booleans as true/false, missing/null as empty).
# Prints "!json" if the file is not a JSON object.
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
    print('true' if v is True else 'false' if v is False else '' if v is None else v)
PY
}

# jlen <file>: items in a JSON array (or in the first array field of an object); -1 if there is none.
jlen() {
    python3 - "$1" <<'PY'
import json, sys
try:
    o = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    o = None
if isinstance(o, dict):
    o = next((v for v in o.values() if isinstance(v, list)), None)
print(len(o) if isinstance(o, list) else -1)
PY
}

# post_ok <path> <json> <label> [expect-ok=true]: POST and check {ok, msg}. Leaves the answer in $HTTP_BODY.
post_ok() {
    local code ok msg
    code=$(http POST "$1" "$2")
    cp "$HTTP_BODY" "$OUT/http/$(printf '%s' "$1" | tr '/' '_').json" 2>/dev/null
    ok=$(jget "$HTTP_BODY" ok)
    msg=$(jget "$HTTP_BODY" msg)
    if [ "$code" = 200 ] && [ "$ok" = "${4:-true}" ] && [ -n "$msg" ]; then
        pass "$3 -> ok=$ok \"$msg\""
        return 0
    fi
    fail "$3 -> HTTP $code, ok=$ok, msg=\"$msg\""
    return 1
}

# Minimal valid one-page PDF with correct xref offsets.
make_pdf() {
    local text=${2:-Office TV test} out i xref line
    local -a obj off
    local stream="BT /F1 48 Tf 72 640 Td ($text) Tj ET"
    obj[1]='<< /Type /Catalog /Pages 2 0 R >>'
    obj[2]='<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
    obj[3]='<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'
    obj[4]=$(printf '<< /Length %d >>\nstream\n%s\nendstream' "${#stream}" "$stream")
    obj[5]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    out=$'%PDF-1.4\n'
    for i in 1 2 3 4 5; do
        off[i]=${#out}
        out+="$i 0 obj"$'\n'"${obj[i]}"$'\n'"endobj"$'\n'
    done
    xref=${#out}
    out+=$'xref\n0 6\n0000000000 65535 f \n'
    for i in 1 2 3 4 5; do
        printf -v line '%010d 00000 n \n' "${off[i]}"
        out+=$line
    done
    out+=$'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'"$xref"$'\n%%EOF\n'
    printf '%s' "$out" > "$1"
}

save_env() {
    cat > "$OUT/otv-test.env" <<EOF
PIN=$PIN
PORT=$PORT
LPORT=$LPORT
CODE=$CODE
OTV_PID=$OTV_PID
SDK=$SDK
IS_TV=$IS_TV
HOME_PKGS='$HOME_PKGS'
EOF
}
