// Office TV: show a laptop screen on an office TV (PROTOCOL.md section 8). The relay protocol lives in
// otv.js, screen sharing in cast.js. The ?v= queries keep app.js, cast.js and otv.js from mixing versions
// in a browser cache; bump them together (and the one in index.html) whenever a file changes.
//
// One screen: type the code the TV shows (4 digits on Office TV 3.6+, which shows a new one every time it
// opens; 10 letters and numbers on older TVs) and press Share screen. Nothing is saved: the code is typed
// each time. Nothing talks to the relay until Share screen is pressed, and the relay connection is closed
// again when sharing ends.
import { ALPHABET, CONTROLLER_URL, DEFAULT_RELAY, TvLink, cleanName, displayCode, normalizeCode, normalizeRelay, parsePairFragment } from './otv.js?v=4';
import { CastSender, captureScreen, senderSupport } from './cast.js?v=10';

const $ = id => document.getElementById(id);
const INFO_KEY = 'officetv.info';
/** Keys of the saved-TV list older versions kept; removed on load. */
const OLD_KEYS = ['officetv.tvs', 'officetv.selected'];
const INFO_MS = 2000;
/** While connecting: after this long without an answer from the TV, the panel asks to check the code. */
const SLOW_MS = 8000;
const UNSUPPORTED_TEXT = 'Screen sharing needs Chrome, Edge or Safari on a laptop, Chromebook or Mac.';
const TEST = window.__otvTest || {}; // test-only overrides (shorter timeouts)

// ---------- storage (only the "Connection info" toggle; falls back to memory) ----------

const storage = (() => {
    const mem = new Map();
    const ls = () => { try { return window.localStorage; } catch (e) { return null; } };
    return {
        get(k) {
            try { const v = ls() && ls().getItem(k); if (v !== null && v !== undefined) return v; } catch (e) { /* blocked */ }
            return mem.has(k) ? mem.get(k) : null;
        },
        set(k, v) {
            mem.set(k, v);
            try { if (ls()) ls().setItem(k, v); } catch (e) { /* memory only */ }
        },
        remove(k) {
            mem.delete(k);
            try { if (ls()) ls().removeItem(k); } catch (e) { /* ignore */ }
        },
    };
})();

const state = {
    session: null,          // {code, relay, link, phase, sender, stream, clickedAt, startedAt, info}
    notice: null,           // {kind: 'info' | 'bad', title, text} on the home card
    lastCode: '',           // the code of the last session: the button says "Share again" while it is typed
    relay: DEFAULT_RELAY,   // from a '#pair=...&relay=...' link (tests, other relays)
    unsupported: '',        // why this browser cannot share its screen
    view: '',
    infoOpen: false,        // "Connection info" details expanded (remembered)
};

// ---------- code input ----------

function looseCode(raw) {
    return String(raw || '').toUpperCase().replace(/[\s\-‐-―]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** The code in the field ({code, relay}; a pasted pairing link works too), or null. */
function typedTarget(raw) {
    if (/pair=/i.test(raw)) {
        const p = parsePairFragment(raw);
        return p ? { code: p.code, relay: p.relay } : null;
    }
    const code = normalizeCode(looseCode(raw));
    return code ? { code, relay: state.relay } : null;
}

/** Explains what is wrong with a typed code, or returns '' when it is valid. */
function explainCode(raw) {
    if (/pair=/i.test(raw)) return parsePairFragment(raw) ? '' : 'This TV link is incomplete. Type the code shown on the TV instead.';
    const s = looseCode(raw);
    if (!s) return 'Type the code shown on the TV.';
    if (/^\d+$/.test(s)) {
        if (s.length === 4 || s.length === 10) return '';
        return 'The code on the TV has 4 digits. This one has ' + s.length + '.';
    }
    // Letters: an older TV's code (10 letters and numbers, Office TV 3.5 and older).
    const bad = [];
    for (const ch of s) if (ALPHABET.indexOf(ch) < 0 && bad.indexOf(ch) < 0) bad.push(ch);
    if (bad.indexOf('U') >= 0) return 'TV codes never contain the letter U. Could it be a V? Check the TV and try again.';
    if (bad.length) return 'Remove "' + bad.join(' ') + '". The code on the TV has only numbers (older TVs: letters and numbers).';
    if (s.length !== 10) return 'Older TV codes have 10 letters and numbers. This one has ' + s.length + '.';
    return '';
}

function setCodeError(text) {
    $('codeErr').textContent = text;
    $('codeErr').hidden = !text;
    if (text) $('code').setAttribute('aria-invalid', 'true');
    else $('code').removeAttribute('aria-invalid');
}

function onCodeInput() {
    const raw = $('code').value;
    const s = looseCode(raw);
    $('code').classList.toggle('long', s.length > 4 || /[^0-9]/.test(s));
    // Explain only clear mistakes while typing (a wrong character, too many digits); the rest on submit.
    const problem = explainCode(raw);
    const now = problem && (/letter U|^Remove/.test(problem) || (/^\d+$/.test(s) && s.length > 10));
    setCodeError(now ? problem : '');
    renderButton();
}

// ---------- sharing ----------

function captureProblem(e) {
    const name = e && e.name;
    const msg = String((e && e.message) || '');
    if (e && e.code === 'unsupported') return { title: UNSUPPORTED_TEXT, text: '' };
    if (name === 'NotAllowedError' && /system/i.test(msg)) {
        return {
            title: 'Your computer blocked screen recording.',
            text: 'On a Mac, open System Settings → Privacy & Security → Screen Recording, allow your browser, then reopen the browser.',
        };
    }
    if (name === 'NotAllowedError' || name === 'AbortError') return null; // the user closed the picker
    if (name === 'InvalidStateError') return { title: 'Please click the button again.', text: 'Your browser needs a fresh click to show its screen picker.' };
    if (name === 'NotReadableError') return { title: 'The screen could not be captured.', text: 'Close other apps that record the screen, then try again.' };
    if (name === 'NotFoundError') return { title: 'There is no screen to share.', text: 'Please try again.' };
    return { title: 'Your browser could not start screen sharing.', text: 'Please try again.' };
}

function castProblem(code, err, s) {
    const e = err || {};
    switch (code) {
        case 'timeout':
            return { title: 'No TV answered with code ' + displayCode(s.code) + '.', text: 'Check the code on the TV.', codeProblem: true };
        case 'rate_limit':
            return e.limit === 'burst'
                ? { title: 'Too many attempts in a short time.', text: 'Wait a minute, then try again.' }
                : { title: 'The free relay limit for today has been reached.', text: 'This office network has used up today\'s free messages. Please try again later.' };
        case 'offline':
            return { title: 'This laptop seems to be offline.', text: 'Check the internet connection, then try again.' };
        case 'network':
            return { title: 'Screen sharing works only from a laptop on the same network as this TV.', text: 'Connect the laptop to the same Wi-Fi as the TV, then try again.' };
        case 'relay':
            return { title: 'The connection service did not respond.', text: 'Please try again in a moment.' };
        case 'tv':
            return { title: e.message || 'The TV could not open the screen receiver.', text: '' };
        case 'no_answer':
            return { title: 'The TV did not connect.', text: 'Update the Office TV app and Android System WebView on the TV, then try again.' };
        case 'tv_error':
            return { title: 'The TV could not show your screen.', text: 'Update Android System WebView on the TV, then try again.' };
        case 'ice':
            return { title: 'Could not reach the TV.', text: 'Connect the laptop to the same Wi-Fi as the TV.' };
        case 'lost':
            return { title: 'The connection to the TV was lost.', text: 'Check the Wi-Fi, then share again.' };
        default:
            return { title: 'Screen sharing stopped unexpectedly.', text: 'Please try again.' };
    }
}

function stopStream(stream) {
    if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch (e) { /* ignore */ } }
}

/** The TV's name from its answer (the status object), or "the TV". */
function tvName(s) {
    const d = s && s.sender && s.sender.tvData;
    return (d && typeof d.name === 'string' && cleanName(d.name)) || 'the TV';
}

/**
 * Starts sharing to the TV with `code`. Must run synchronously inside the click (or submit) handler:
 * getDisplayMedia is the very first call, so the browser still sees the user gesture. Key derivation and
 * the relay connections then run while the picker is open.
 */
function share(code, relay) {
    if (state.session || state.unsupported) return;
    const picked = captureScreen();
    const link = new TvLink({ code, relay });
    link.ready(8000).catch(() => {});
    const s = { code, relay, link, phase: 'picking', sender: null, stream: null, clickedAt: Date.now(), startedAt: 0 };
    state.session = s;
    state.notice = null;
    state.lastCode = code;
    setCodeError('');
    render();
    picked.then(stream => {
        if (state.session !== s) {
            stopStream(stream);
            return;
        }
        s.stream = stream;
        s.clickedAt = Date.now(); // the connecting clock starts once something was picked
        const sender = new CastSender({
            link, onstate: (st, d) => onCastState(s, st, d),
            ackTimeoutMs: TEST.ackTimeoutMs, answerTimeoutMs: TEST.answerTimeoutMs, connectTimeoutMs: TEST.connectTimeoutMs,
            dropMs: TEST.dropMs, reconnectTimeoutMs: TEST.reconnectTimeoutMs,
        });
        s.sender = sender;
        window.__otvCastSender = sender; // for tests
        s.phase = 'starting';
        render();
        sender.start(stream);
    }, err => {
        if (state.session !== s) return;
        endSession(s, captureProblem(err));
    });
}

function onCastState(s, st, d) {
    if (state.session !== s) return;
    if (st === 'stopped') {
        if (d.reason === 'tv') endSession(s, { title: 'The TV stopped showing your screen.', text: '' }, 'bad');
        else endSession(s, { title: 'Sharing stopped.', text: '' }, 'info');
        return;
    }
    if (st === 'error') {
        endSession(s, castProblem(d.code, d.error, s));
        return;
    }
    s.phase = st;
    if (st === 'sharing' && !s.startedAt) s.startedAt = Date.now();
    render();
}

/**
 * Closes a finished session's relay link once nothing needs it: the sender may still be telling the TV to close
 * its receiver ('cast stop' when the share was cancelled before the connection was up), so wait for that
 * command's ack (TvLink.suspend() refuses while one is pending), at most about 10 s.
 */
function retire(link) {
    let tries = 0;
    const attempt = () => {
        let idle = false;
        try { idle = link.suspend(); } catch (e) { idle = true; }
        if (idle || ++tries > 40) {
            try { link.close(); } catch (e) { /* ignore */ }
            return;
        }
        setTimeout(attempt, 250);
    };
    setTimeout(attempt, 0); // after the sender's last send() has registered
}

function endSession(s, problem, kind = 'bad') {
    state.session = null;
    stopStream(s.stream);
    retire(s.link);
    if (problem) state.notice = Object.assign({ kind }, problem);
    render();
    // A wrong code: back to the field, selected, ready for the right one. Otherwise one click on Share again.
    if (problem && problem.codeProblem) {
        $('code').focus();
        try { $('code').select(); } catch (e) { /* ignore */ }
    } else {
        $('shareBtn').focus();
    }
}

function stopSharing(reason) {
    const s = state.session;
    if (!s) return;
    if (s.sender) s.sender.stop(reason);
    else endSession(s, null);
}

// ---------- connection info (while sharing) ----------

let clock = null;
let infoClock = null;

/** Reads the connection numbers (this browser's getStats() + the TV's, from the data channel) and shows them. */
async function refreshInfo() {
    const s = state.session;
    if (!s || s.phase !== 'sharing' || !s.sender) return;
    const info = await s.sender.connectionInfo();
    if (state.session !== s || s.phase !== 'sharing' || !info) return;
    s.info = info;
    renderInfo(s);
}

function renderInfo(s) {
    const info = s && s.info;
    const v = info ? info.verdict : { text: 'Measuring…', level: 'wait', hints: [] };
    $('connText').textContent = v.text;
    $('connDot').className = 'dot ' + v.level;
    const open = state.infoOpen;
    $('connToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('connDetails').hidden = !open;
    $('connHint').hidden = open || !v.hints.length;
    $('connHint').textContent = v.hints[0] || '';
    const hints = $('connHints');
    hints.hidden = !v.hints.length;
    hints.textContent = '';
    for (const h of v.hints) {
        const li = document.createElement('li');
        li.textContent = h;
        hints.appendChild(li);
    }
    const rows = $('connRows');
    rows.textContent = '';
    for (const r of (info ? info.rows : [])) {
        const div = document.createElement('div');
        div.dataset.k = r.k;
        const dt = document.createElement('dt');
        dt.textContent = r.label;
        const dd = document.createElement('dd');
        dd.textContent = r.value;
        div.appendChild(dt);
        div.appendChild(dd);
        rows.appendChild(div);
    }
}

function toggleInfo() {
    state.infoOpen = !state.infoOpen;
    storage.set(INFO_KEY, state.infoOpen ? '1' : '');
    renderInfo(state.session);
}

// ---------- view ----------

const hms = ms => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const p = n => (n < 10 ? '0' : '') + n;
    return p(Math.floor(t / 3600)) + ':' + p(Math.floor(t / 60) % 60) + ':' + p(t % 60);
};

const LIVE_TEXT = {
    starting: ['Connecting', 'Connecting to {tv}…', 'Getting the connection ready.'],
    waiting: ['Connecting', 'Connecting to {tv}…', 'Opening the screen receiver on the TV.'],
    connecting: ['Connecting', 'Connecting to {tv}…', 'The TV is getting ready. This takes a moment.'],
    sharing: ['Live', 'Sharing to {tv}', 'Everything in the screen, window or tab you picked is visible on the TV.'],
    reconnecting: ['Reconnecting', 'Reconnecting to {tv}…', 'The connection dropped for a moment. Trying again.'],
};
const SLOW_TEXT = 'No answer from the TV yet. Check that the code matches the one on the TV.';

/** Clock and slow-connection hint, every second while the live panel shows. */
function tick() {
    const s = state.session;
    const on = !!(s && s.phase === 'sharing' && s.startedAt);
    $('liveTimer').hidden = !on;
    $('liveSep').textContent = on ? ' · ' : '';
    $('liveClock').textContent = on ? hms(Date.now() - s.startedAt) : '';
    if (s && LIVE_TEXT[s.phase] && s.phase !== 'sharing' && s.phase !== 'reconnecting') {
        const slow = (s.phase === 'starting' || s.phase === 'waiting') && Date.now() - s.clickedAt > (TEST.slowMs || SLOW_MS);
        $('liveText').textContent = slow ? SLOW_TEXT : LIVE_TEXT[s.phase][2];
    }
}

function showNotice(n) {
    const el = $('notice');
    el.hidden = !n;
    if (!n) return;
    el.classList.toggle('bad', n.kind === 'bad');
    el.setAttribute('role', n.kind === 'bad' ? 'alert' : 'status');
    $('noticeIcon').setAttribute('href', n.kind === 'bad' ? '#i-alert' : '#i-info');
    $('noticeTitle').textContent = n.title;
    $('noticeText').textContent = n.text ? ' ' + n.text : '';
}

/** "Share screen", "Share again" (the last code is still typed) or busy while the picker is open. */
function renderButton() {
    const busy = !!state.session;
    const btn = $('shareBtn');
    btn.disabled = busy;
    if (busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
    const t = typedTarget($('code').value);
    const again = !!state.lastCode && !!t && t.code === state.lastCode;
    $('shareLabel').textContent = busy ? 'Choose what to share…' : again ? 'Share again' : 'Share screen';
    $('code').readOnly = busy;
}

/**
 * Sound: a shared tab's sound plays on the TV only (suppressLocalAudioPlayback in the capture options);
 * system audio of an entire screen cannot be muted on the laptop; no audio track: how to share it.
 */
function soundStatus(stream) {
    const a = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
    if (!a) {
        return { on: false, text: 'No sound is shared. To play sound on the TV, stop and share a Chrome tab with “Also share tab audio” on.' };
    }
    const v = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    let surface = '';
    let suppressed = null;
    try { surface = (v && v.getSettings && v.getSettings().displaySurface) || ''; } catch (e) { /* unknown */ }
    try {
        const as = a.getSettings ? a.getSettings() : {};
        if (typeof as.suppressLocalAudioPlayback === 'boolean') suppressed = as.suppressLocalAudioPlayback;
    } catch (e) { /* unknown */ }
    const md = navigator.mediaDevices;
    const canSuppress = !!(md && md.getSupportedConstraints && md.getSupportedConstraints().suppressLocalAudioPlayback);
    if (surface === 'browser' && canSuppress && suppressed !== false) return { on: true, text: 'Sound plays on the TV only.' };
    return { on: true, text: 'Sound plays on the TV. Lower the laptop volume if you hear the sound twice.' };
}

function renderSound(s) {
    const show = s.phase === 'sharing' || s.phase === 'reconnecting';
    $('soundNote').hidden = !show;
    if (!show) return;
    const st = soundStatus(s.stream);
    $('soundNote').classList.toggle('off', !st.on);
    $('soundIcon').setAttribute('href', st.on ? '#i-sound' : '#i-mute');
    $('soundText').textContent = st.text;
}

function render() {
    const s = state.session;
    const live = !!s && s.phase !== 'picking';
    let view;
    if (state.unsupported) view = 'unsupported';
    else if (live) view = 'live';
    else view = 'home';
    const changed = view !== state.view;
    state.view = view;
    document.body.classList.toggle('is-live', view === 'live');
    document.body.classList.toggle('unsupported', view === 'unsupported');
    $('homeCard').hidden = view !== 'home';
    $('livePanel').hidden = view !== 'live';
    $('unsupportedCard').hidden = view !== 'unsupported';

    if (view === 'home') {
        showNotice(state.notice);
        renderButton();
    }

    if (view === 'live') {
        const [chip, title, text] = LIVE_TEXT[s.phase] || LIVE_TEXT.starting;
        const name = tvName(s);
        $('liveChip').textContent = chip;
        $('liveChip').classList.toggle('on', s.phase === 'sharing');
        $('liveLabel').textContent = title.replace('{tv}', name);
        $('liveText').textContent = text;
        $('stopLabel').textContent = s.phase === 'sharing' || s.phase === 'reconnecting' ? 'Stop sharing' : 'Cancel';
        $('onAir').hidden = s.phase !== 'sharing';
        $('veil').hidden = s.phase === 'sharing';
        const pv = $('preview');
        if (pv.srcObject !== s.stream) {
            pv.srcObject = s.stream;
            // A still picture, refreshed every 3 s: playing the shared screen here all the time costs a slow laptop
            // a full extra video, and with the whole screen shared it would never let the screen go still.
            const glimpse = () => {
                if (pv.srcObject !== s.stream) { clearInterval(pv._otvGlimpse); return; }
                const p = pv.play && pv.play();
                if (p && p.then) p.then(() => setTimeout(() => { try { pv.pause(); } catch (e) { /* ignore */ } }, 250), () => {});
            };
            clearInterval(pv._otvGlimpse);
            pv._otvGlimpse = setInterval(glimpse, 3000);
            glimpse();
        }
        renderSound(s);
        document.title = (s.phase === 'sharing' ? 'Sharing to ' : s.phase === 'reconnecting' ? 'Reconnecting to ' : 'Connecting to ') + name + ' · Office TV';
    } else {
        if ($('preview').srcObject) { clearInterval($('preview')._otvGlimpse); $('preview').srcObject = null; }
        document.title = 'Office TV · Share your laptop screen';
    }
    tick();
    if (view === 'live' && !clock) clock = setInterval(tick, 1000);
    if (view !== 'live' && clock) { clearInterval(clock); clock = null; }
    const sharing = view === 'live' && s.phase === 'sharing';
    $('connInfo').hidden = !sharing;
    if (sharing && !infoClock) {
        renderInfo(s);
        refreshInfo();
        infoClock = setInterval(refreshInfo, INFO_MS);
    }
    if (!sharing && infoClock) { clearInterval(infoClock); infoClock = null; }
    if (changed && view === 'live') $('stopBtn').focus();
}

// ---------- actions ----------

function onSubmit(e) {
    e.preventDefault();
    if (state.session || state.unsupported) return;
    const raw = $('code').value;
    const problem = explainCode(raw);
    const target = problem ? null : typedTarget(raw);
    if (!target) {
        setCodeError(problem || 'Type the code shown on the TV.');
        $('code').focus();
        return;
    }
    share(target.code, target.relay);
}

/** '#pair=<code>[&relay=<url>]' links: the code goes into the field (not saved); the fragment is cleared. */
function handleFragment() {
    const hash = location.hash || '';
    if (!/pair=/i.test(hash)) return;
    const p = parsePairFragment(hash);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    if (!p) {
        state.notice = { kind: 'bad', title: 'This TV link is incomplete.', text: 'Type the code shown on the TV instead.' };
        return;
    }
    state.relay = normalizeRelay(p.relay) || DEFAULT_RELAY;
    $('code').value = displayCode(p.code);
    state.notice = null;
}

function wire() {
    $('shareForm').addEventListener('submit', onSubmit);
    $('code').addEventListener('input', onCodeInput);
    $('stopBtn').addEventListener('click', () => stopSharing('user'));
    $('connToggle').addEventListener('click', toggleInfo);
    // Closing or leaving the tab stops sharing (the TV hears it over the data channel).
    window.addEventListener('pagehide', () => stopSharing('page'));
    window.addEventListener('hashchange', () => {
        if (state.session) return;
        handleFragment();
        onCodeInput();
        render();
    });
}

function detectUnsupported() {
    const ua = navigator.userAgent || '';
    const mobile = (navigator.userAgentData && navigator.userAgentData.mobile === true)
        || /Android.+Mobile|iPhone|iPod|Windows Phone/i.test(ua);
    if (mobile || senderSupport(window) || typeof window.EventSource !== 'function' || typeof window.fetch !== 'function') return UNSUPPORTED_TEXT;
    return '';
}

function start() {
    for (const k of OLD_KEYS) storage.remove(k); // the saved-TV list is gone: codes change every time now
    wire();
    if (!window.crypto || !window.crypto.subtle) {
        // Web Crypto only exists on https pages.
        $('unsupTitle').textContent = 'Open the secure page';
        $('unsupText').textContent = 'This page only works over https: ' + CONTROLLER_URL;
        state.unsupported = 'https';
        render();
        return;
    }
    state.unsupported = detectUnsupported();
    if (state.unsupported) $('unsupText').textContent = state.unsupported;
    state.infoOpen = storage.get(INFO_KEY) === '1';
    handleFragment();
    onCodeInput();
    render();
    if (!state.unsupported && !$('code').value) {
        try { $('code').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
}

start();
