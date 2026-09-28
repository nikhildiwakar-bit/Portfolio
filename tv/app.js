// Office TV: show a laptop screen on an office TV (PROTOCOL.md section 8). The relay protocol lives in
// otv.js, screen sharing in cast.js. The ?v= queries keep app.js, cast.js and otv.js from mixing versions
// in a browser cache; bump them together (and the one in index.html) whenever a file changes.
//
// Relay use is kept small (the free relay has a daily limit per office network): one 'ping' per saved TV
// when the page loads (no polling), then per sharing session: 'cast' start + ack + offer + answer.
import { ALPHABET, CONTROLLER_URL, DEFAULT_RELAY, TvLink, cleanName, displayCode, normalizeCode, normalizeRelay, parsePairFragment } from './otv.js?v=3';
import { CastSender, captureScreen, senderSupport } from './cast.js?v=2';

const $ = id => document.getElementById(id);
const STORE_KEY = 'officetv.tvs';
const SELECTED_KEY = 'officetv.selected';
const MAX_TVS = 12;
const MAX_PINGS = 6;
const UNSUPPORTED_TEXT = 'Screen sharing needs Chrome, Edge or Safari on a laptop, Chromebook or Mac.';
const TEST = window.__otvTest || {}; // test-only overrides (shorter timeouts)

// ---------- storage (falls back to memory) ----------

const storage = (() => {
    const mem = new Map();
    let ok = true;
    try {
        const k = 'officetv.probe';
        window.localStorage.setItem(k, '1');
        window.localStorage.removeItem(k);
    } catch (e) {
        ok = false;
    }
    return {
        get ok() { return ok; },
        get(k) {
            if (ok) {
                try { return window.localStorage.getItem(k); } catch (e) { ok = false; }
            }
            return mem.has(k) ? mem.get(k) : null;
        },
        set(k, v) {
            mem.set(k, v);
            if (!ok) return false;
            try {
                window.localStorage.setItem(k, v);
                return true;
            } catch (e) {
                ok = false;
                return false;
            }
        },
    };
})();

const state = {
    tvs: [],                // saved TVs [{name, code, relay}]
    selected: null,         // code of the selected saved TV
    links: new Map(),       // code -> TvLink
    health: new Map(),      // code -> 'checking' | 'online' | 'offline' | 'unknown'
    adding: false,          // the code form is open although TVs are saved
    confirmForget: false,
    session: null,          // {tv, link, pending, phase, sender, stream, startedAt}
    notice: null,           // {kind: 'info' | 'bad', title, text} under the saved TVs
    setupError: null,       // {title, text} in the code form
    shared: false,          // a session ended: the big button says "Share again"
    unsupported: '',        // why this browser cannot share its screen
    view: '',
};

function loadTvs() {
    let list;
    try { list = JSON.parse(storage.get(STORE_KEY) || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    const out = [];
    for (const t of list) {
        const code = t && normalizeCode(String(t.code || ''));
        if (!code || out.some(x => x.code === code)) continue;
        out.push({ name: cleanName(t.name || ''), code, relay: normalizeRelay(t.relay || DEFAULT_RELAY) || DEFAULT_RELAY });
    }
    return out.slice(0, MAX_TVS);
}

function saveTvs() {
    storage.set(STORE_KEY, JSON.stringify(state.tvs.map(t => ({ name: t.name, code: t.code, relay: t.relay }))));
    storage.set(SELECTED_KEY, state.selected || '');
}

/** Adds a TV (or updates the saved one with the same code), selects it and saves. */
function keepTv({ code, name, relay }) {
    let tv = state.tvs.find(t => t.code === code);
    if (tv) {
        if (name) tv.name = cleanName(name);
        if (relay) tv.relay = normalizeRelay(relay) || tv.relay;
    } else {
        tv = { name: cleanName(name || ''), code, relay: normalizeRelay(relay || DEFAULT_RELAY) || DEFAULT_RELAY };
        state.tvs.unshift(tv);
        state.tvs = state.tvs.slice(0, MAX_TVS);
    }
    state.selected = tv.code;
    saveTvs();
    return tv;
}

/** Uses the name the TV reports for a TV the user did not name. */
function adoptName(tv, name) {
    const n = cleanName(name);
    if (!n || tv.name) return;
    tv.name = n;
    if (state.tvs.indexOf(tv) >= 0) saveTvs();
}

const tvName = tv => tv.name || 'TV ' + displayCode(tv.code).slice(0, 5);
const selectedTv = () => state.tvs.find(t => t.code === state.selected) || null;

// ---------- relay links ----------

function linkFor(tv) {
    let l = state.links.get(tv.code);
    if (l && l.relay !== (normalizeRelay(tv.relay) || DEFAULT_RELAY)) {
        l.close();
        l = null;
    }
    if (!l) {
        l = new TvLink({ code: tv.code, name: tv.name, relay: tv.relay });
        state.links.set(tv.code, l);
    }
    return l;
}

/** Closes a link's event stream unless a sharing session uses it, so an idle page holds no relay connection. */
function rest(link) {
    if (link && !(state.session && state.session.link === link)) link.suspend();
}

function dropLink(code) {
    const l = state.links.get(code);
    if (l) l.close();
    state.links.delete(code);
}

async function ping(tv) {
    const link = linkFor(tv);
    state.health.set(tv.code, 'checking');
    render();
    try {
        const ack = await link.ping({ timeoutMs: TEST.pingTimeoutMs || 12000 });
        state.health.set(tv.code, ack.ok ? 'online' : 'unknown');
        if (ack.ok && ack.data && typeof ack.data.name === 'string') adoptName(tv, ack.data.name);
    } catch (e) {
        state.health.set(tv.code, e && e.code === 'timeout' ? 'offline' : 'unknown');
    }
    rest(link);
    render();
}

// ---------- code input ----------

function looseCode(raw) {
    return String(raw || '').toUpperCase().replace(/[\s\-‐-―]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Explains what is wrong with a typed code, or returns '' when it is valid. */
function explainCode(raw) {
    const s = looseCode(raw);
    if (!s) return 'Type the TV code. It is shown on the TV in the Office TV app (for example 7K3M9-QX2TD).';
    const bad = [];
    for (const ch of s) if (ALPHABET.indexOf(ch) < 0 && bad.indexOf(ch) < 0) bad.push(ch);
    if (bad.indexOf('U') >= 0) return 'TV codes never contain the letter U. Could it be a V? Check the TV and try again.';
    if (bad.length) return 'TV codes only use the letters A to Z and the numbers 0 to 9. Remove "' + bad.join(' ') + '".';
    if (s.length !== 10) return 'A TV code has 10 characters. This one has ' + s.length + '.';
    return '';
}

function setCodeError(text) {
    $('codeErr').textContent = text;
    $('codeErr').hidden = !text;
    $('codeHint').hidden = !!text;
    if (text) $('code').setAttribute('aria-invalid', 'true');
    else $('code').removeAttribute('aria-invalid');
}

function onCodeInput() {
    const raw = $('code').value;
    const hint = $('codeHint');
    const s = looseCode(raw);
    setCodeError('');
    hint.classList.remove('good');
    if (/pair=/i.test(raw)) {
        const ok = !!parsePairFragment(raw);
        hint.textContent = ok ? 'TV link found.' : 'This TV link is incomplete. Type the code shown on the TV instead.';
        hint.classList.toggle('good', ok);
        return;
    }
    const problem = s ? explainCode(raw) : '';
    if (!s) {
        hint.textContent = '10 letters and numbers, as shown on the TV.';
    } else if (!problem) {
        hint.textContent = 'Looks good: ' + displayCode(s);
        hint.classList.add('good');
    } else if (s.length <= 10 && /letter U|only use/.test(problem)) {
        setCodeError(problem);
        hint.textContent = '';
    } else {
        hint.textContent = Math.min(s.length, 99) + ' of 10 characters';
    }
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
    const name = tvName(s.tv);
    switch (code) {
        case 'timeout':
            return s.pending
                ? { title: 'The TV did not answer.', text: 'Check that the code matches the one on the TV and that the TV is on. If it was just switched on, open the Office TV app on it once.' }
                : { title: name + ' did not answer.', text: 'Make sure the TV is on, open the Office TV app on it once, then try again.' };
        case 'rate_limit':
            return e.limit === 'burst'
                ? { title: 'Too many attempts in a short time.', text: 'Wait a minute, then try again.' }
                : { title: 'The free relay limit for today has been reached.', text: 'This office network has used up today\'s free messages. Please try again later.' };
        case 'network':
            return { title: 'This laptop seems to be offline.', text: 'Check the internet connection, then try again.' };
        case 'relay':
            return { title: 'The connection service did not respond.', text: 'Please try again in a moment.' };
        case 'tv':
            return { title: e.message || 'The TV could not open the screen receiver.', text: '' };
        case 'no_answer':
            return { title: 'The TV did not connect.', text: 'Update the Office TV app and Android System WebView on the TV, then try again.' };
        case 'tv_error':
            return { title: 'The TV could not show your screen.', text: 'Update Android System WebView on the TV, then try again.' };
        case 'ice':
            return { title: 'Could not connect to the TV.', text: 'Works best when the laptop and TV are on the same Wi-Fi. Check the network, then try again.' };
        case 'lost':
            return { title: 'The connection to the TV was lost.', text: 'Check the Wi-Fi, then share again.' };
        default:
            return { title: 'Screen sharing stopped unexpectedly.', text: 'Please try again.' };
    }
}

function stopStream(stream) {
    if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch (e) { /* ignore */ } }
}

/**
 * Starts sharing to `tv`. Must run synchronously inside the click (or submit) handler: getDisplayMedia is
 * the very first call, so the browser still sees the user gesture. Key derivation and the relay connection
 * then run while the picker is open. `pending`: a TV typed in just now; it is saved once it answers.
 */
function share(tv, pending) {
    if (state.session || state.unsupported) return;
    const picked = captureScreen();
    const link = linkFor(tv);
    link.ready(8000).catch(() => {});
    const s = { tv, link, pending, phase: 'picking', sender: null, stream: null, startedAt: 0 };
    state.session = s;
    state.notice = null;
    state.setupError = null;
    state.confirmForget = false;
    render();
    picked.then(stream => {
        if (state.session !== s) {
            stopStream(stream);
            return;
        }
        s.stream = stream;
        const sender = new CastSender({
            link, onstate: (st, d) => onCastState(s, st, d),
            ackTimeoutMs: TEST.ackTimeoutMs, dropMs: TEST.dropMs, reconnectTimeoutMs: TEST.reconnectTimeoutMs,
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
    if (st === 'connecting') {
        // The TV answered, so the code is right: remember it.
        if (s.pending) {
            s.tv = keepTv(s.tv);
            s.pending = false;
            state.adding = false;
        }
        state.health.set(s.tv.code, 'online');
        if (d && d.data && typeof d.data.name === 'string') adoptName(s.tv, d.data.name);
    }
    if (st === 'stopped') {
        if (d.reason === 'tv') endSession(s, { title: 'The TV stopped showing your screen.', text: '' }, 'bad');
        else endSession(s, s.pending ? null : { title: 'Sharing stopped.', text: '' }, 'info');
        return;
    }
    if (st === 'error') {
        if (d.code === 'timeout') state.health.set(s.tv.code, 'offline');
        endSession(s, castProblem(d.code, d.error, s));
        return;
    }
    s.phase = st;
    if (st === 'sharing' && !s.startedAt) s.startedAt = Date.now();
    render();
}

function endSession(s, problem, kind = 'bad') {
    state.session = null;
    stopStream(s.stream);
    if (s.pending) {
        dropLink(s.tv.code);
        if (problem) state.setupError = problem;
    } else {
        rest(s.link);
        state.shared = state.shared || !!s.sender;
        if (problem) state.notice = Object.assign({ kind }, problem);
    }
    render();
    const target = state.view === 'setup' ? (problem ? $('code') : $('connectBtn')) : $('shareBtn');
    if (target && !target.hidden) target.focus({ preventScroll: false });
}

function stopSharing(reason) {
    const s = state.session;
    if (!s) return;
    if (s.sender) s.sender.stop(reason);
    else endSession(s, null);
}

// ---------- view ----------

let clock = null;

const hms = ms => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const p = n => (n < 10 ? '0' : '') + n;
    return p(Math.floor(t / 3600)) + ':' + p(Math.floor(t / 60) % 60) + ':' + p(t % 60);
};

function tick() {
    const s = state.session;
    const on = !!(s && s.phase === 'sharing' && s.startedAt);
    $('liveTimer').hidden = !on;
    $('liveSep').textContent = on ? ' · ' : '';
    $('liveClock').textContent = on ? hms(Date.now() - s.startedAt) : '';
}

function showNotice(el, titleEl, textEl, n) {
    el.hidden = !n;
    if (!n) return;
    if (n.kind) {
        el.classList.toggle('bad', n.kind === 'bad');
        const icon = el.querySelector('use');
        if (icon) icon.setAttribute('href', n.kind === 'bad' ? '#i-alert' : '#i-info');
    }
    titleEl.textContent = n.title;
    textEl.textContent = n.text ? ' ' + n.text : '';
}

function setBusy(btn, labelEl, busy, idleText) {
    btn.disabled = busy;
    if (busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
    labelEl.textContent = busy ? 'Choose what to share…' : idleText;
}

const HEALTH_TEXT = { checking: 'Checking…', online: 'Online', offline: 'Not answering', unknown: 'Status unknown' };

function renderTvList() {
    const list = $('tvList');
    const seen = new Set();
    list.classList.toggle('single', state.tvs.length === 1);
    for (const tv of state.tvs) {
        seen.add(tv.code);
        let b = list.querySelector('[data-code="' + tv.code + '"]');
        if (!b) {
            b = document.createElement('button');
            b.type = 'button';
            b.className = 'tv';
            b.setAttribute('role', 'radio');
            b.dataset.code = tv.code;
            b.innerHTML = '<span class="tv-ic"><svg class="ic"><use href="#i-tv"/></svg></span>'
                + '<span class="tv-txt"><span class="tv-name"></span><span class="tv-meta"><span class="dot"></span>'
                + '<span class="tv-status"></span><span class="tv-code"></span></span></span>'
                + '<span class="tv-check" aria-hidden="true"><svg class="ic"><use href="#i-check"/></svg></span>';
        }
        list.appendChild(b); // keeps the saved order
        const on = tv.code === state.selected;
        const health = state.health.get(tv.code) || 'unknown';
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        b.querySelector('.tv-name').textContent = tvName(tv);
        b.querySelector('.dot').className = 'dot ' + health;
        b.querySelector('.tv-status').textContent = HEALTH_TEXT[health];
        b.querySelector('.tv-code').textContent = '· ' + displayCode(tv.code);
    }
    for (const b of Array.from(list.children)) if (!seen.has(b.dataset.code)) b.remove();
}

const LIVE_TEXT = {
    starting: ['Connecting', 'Connecting to {tv}…', 'Getting the connection ready.'],
    waiting: ['Connecting', 'Connecting to {tv}…', 'Opening the screen receiver on the TV.'],
    connecting: ['Connecting', 'Connecting to {tv}…', 'The TV is getting ready. This takes a few seconds.'],
    sharing: ['Live', 'Sharing to {tv}', 'Everything in the screen, window or tab you picked is visible on the TV.'],
    reconnecting: ['Reconnecting', 'Reconnecting to {tv}…', 'The connection dropped for a moment. Trying again.'],
};

function render() {
    const s = state.session;
    const hasTvs = state.tvs.length > 0;
    const live = !!s && s.phase !== 'picking';
    let view;
    if (state.unsupported) view = 'unsupported';
    else if (live) view = 'live';
    else if (!hasTvs || state.adding || (s && s.pending)) view = 'setup';
    else view = 'home';
    const changed = view !== state.view;
    state.view = view;
    document.body.classList.toggle('is-live', view === 'live');
    document.body.classList.toggle('unsupported', view === 'unsupported');
    $('setupCard').hidden = view !== 'setup';
    $('homeCard').hidden = view !== 'home';
    $('livePanel').hidden = view !== 'live';
    $('unsupportedCard').hidden = view !== 'unsupported';

    if (view === 'setup') {
        $('setupTitle').textContent = hasTvs ? 'Add a TV' : 'Connect to a TV';
        $('setupBackRow').hidden = !hasTvs || !!s;
        showNotice($('setupErr'), $('setupErrTitle'), $('setupErrText'), state.setupError);
        setBusy($('connectBtn'), $('connectLabel'), !!s, 'Connect and share screen');
    }

    if (view === 'home') {
        const tv = selectedTv();
        const one = state.tvs.length === 1;
        $('homeTitle').textContent = one ? 'Your TV' : 'Your TVs';
        renderTvList();
        $('offlineHint').hidden = !(tv && state.health.get(tv.code) === 'offline') || !!(state.notice && state.notice.kind === 'bad');
        showNotice($('notice'), $('noticeTitle'), $('noticeText'), state.notice);
        setBusy($('shareBtn'), $('shareLabel'), !!s, state.shared ? 'Share again' : 'Share my screen');
        $('forgetBtn').hidden = !tv;
        $('forgetConfirm').hidden = !state.confirmForget || !tv;
        if (tv) $('forgetText').textContent = 'Forget ' + tvName(tv) + ' on this laptop? You will need the TV code to add it again.';
        $('storageNote').hidden = storage.ok;
    }

    if (view === 'live') {
        const [chip, title, text] = LIVE_TEXT[s.phase] || LIVE_TEXT.starting;
        const name = tvName(s.tv);
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
            const p = pv.play && pv.play();
            if (p && p.catch) p.catch(() => {});
        }
        document.title = (s.phase === 'sharing' ? 'Sharing to ' : s.phase === 'reconnecting' ? 'Reconnecting to ' : 'Connecting to ') + name + ' · Office TV';
    } else {
        if ($('preview').srcObject) $('preview').srcObject = null;
        document.title = 'Office TV · Share your laptop screen';
    }
    tick();
    const ticking = view === 'live' && s.phase === 'sharing';
    if (ticking && !clock) clock = setInterval(tick, 1000);
    if (!ticking && clock) { clearInterval(clock); clock = null; }
    if (changed && view === 'live') $('stopBtn').focus();
}

// ---------- actions ----------

function select(code) {
    if (!state.tvs.some(t => t.code === code) || state.selected === code) return;
    state.selected = code;
    state.confirmForget = false;
    storage.set(SELECTED_KEY, code);
    render();
}

function onSetupSubmit(e) {
    e.preventDefault();
    if (state.session || state.unsupported) return;
    const raw = $('code').value;
    const name = cleanName($('tvName').value);
    let target = null;
    if (/pair=/i.test(raw)) target = parsePairFragment(raw);
    if (!target) {
        const problem = explainCode(raw);
        if (problem) {
            setCodeError(problem);
            $('codeHint').textContent = '';
            $('code').focus();
            return;
        }
        target = { code: normalizeCode(looseCode(raw)), name: '', relay: DEFAULT_RELAY };
    }
    setCodeError('');
    const tv = { code: target.code, name: name || target.name, relay: target.relay };
    const saved = state.tvs.find(t => t.code === tv.code);
    if (saved) {
        // Already known: share right away (same click), updating its name if one was typed.
        if (name) saved.name = name;
        state.selected = saved.code;
        state.adding = false;
        saveTvs();
        share(saved, false);
    } else {
        share(tv, true);
    }
}

function forgetSelected() {
    const tv = selectedTv();
    if (!tv) return;
    dropLink(tv.code);
    state.health.delete(tv.code);
    state.tvs = state.tvs.filter(t => t !== tv);
    state.selected = state.tvs.length ? state.tvs[0].code : null;
    state.confirmForget = false;
    state.notice = { kind: 'info', title: 'Forgot ' + tvName(tv) + '.', text: '' };
    saveTvs();
    render();
    (state.view === 'setup' ? $('code') : $('shareBtn')).focus();
}

/** '#pair=<code>&name=<name>' links (from the TV): save the TV, then clear the fragment. Returns the TV or null. */
function handleFragment() {
    const hash = location.hash || '';
    if (!/pair=/i.test(hash)) return null;
    const p = parsePairFragment(hash);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    if (!p) {
        state.adding = true;
        state.setupError = { title: 'This TV link is incomplete.', text: 'Type the code shown on the TV instead.' };
        return null;
    }
    const tv = keepTv(p);
    state.adding = false;
    state.notice = null;
    return tv;
}

function onTvListKey(e) {
    const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
    if (!(e.key in keys) || !state.tvs.length) return;
    e.preventDefault();
    const i = Math.max(0, state.tvs.findIndex(t => t.code === state.selected));
    const d = keys[e.key];
    const n = state.tvs.length;
    const j = d === -Infinity ? 0 : d === Infinity ? n - 1 : (i + d + n) % n;
    select(state.tvs[j].code);
    const b = $('tvList').querySelector('[data-code="' + state.tvs[j].code + '"]');
    if (b) b.focus();
}

function wire() {
    $('setupForm').addEventListener('submit', onSetupSubmit);
    $('code').addEventListener('input', onCodeInput);
    $('setupBack').addEventListener('click', () => {
        state.adding = false;
        state.setupError = null;
        setCodeError('');
        render();
        $('shareBtn').focus();
    });
    $('shareBtn').addEventListener('click', () => {
        const tv = selectedTv();
        if (tv) share(tv, false);
    });
    $('tvList').addEventListener('click', e => {
        const b = e.target.closest('.tv');
        if (b) select(b.dataset.code);
    });
    $('tvList').addEventListener('keydown', onTvListKey);
    $('addBtn').addEventListener('click', () => {
        state.adding = true;
        state.notice = null;
        state.setupError = null;
        state.confirmForget = false;
        $('setupForm').reset();
        onCodeInput();
        render();
        $('code').focus();
    });
    $('forgetBtn').addEventListener('click', () => {
        state.confirmForget = true;
        render();
        $('forgetNo').focus();
    });
    $('forgetNo').addEventListener('click', () => {
        state.confirmForget = false;
        render();
        $('forgetBtn').focus();
    });
    $('forgetYes').addEventListener('click', forgetSelected);
    $('stopBtn').addEventListener('click', () => stopSharing('user'));
    // Closing or leaving the tab stops sharing (the TV hears it over the data channel).
    window.addEventListener('pagehide', () => stopSharing('page'));
    window.addEventListener('hashchange', () => {
        const tv = handleFragment();
        render();
        if (tv && !state.session) ping(tv);
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
    state.tvs = loadTvs();
    const saved = storage.get(SELECTED_KEY);
    state.selected = state.tvs.some(t => t.code === saved) ? saved : state.tvs.length ? state.tvs[0].code : null;
    handleFragment();
    render();
    if (!state.unsupported) for (const tv of state.tvs.slice(0, MAX_PINGS)) ping(tv);
}

start();
