// Office TV Remote: controller page. The relay protocol itself lives in otv.js.
import {
    ALPHABET, CONTROLLER_URL, DEFAULT_RELAY, MAX_FILE_BYTES, TvLink, cleanName, displayCode, normalizeCode,
    normalizeRelay, parsePairFragment,
} from './otv.js';

const $ = id => document.getElementById(id);
const STORE_KEY = 'officetv.tvs';
const SELECTED_KEY = 'officetv.selected';
const ALL = 'all';
const ADD = '+add';
const PING_FRESH_MS = 60 * 1000;        // re-selecting a TV within a minute does not ping again
const VISIBLE_PING_MS = 5 * 60 * 1000;  // coming back to the tab pings only after 5 minutes away

const STATE_TEXT = { online: 'online', offline: 'jawab nahi aaya', unknown: 'status pata nahi' };
const KEY_TEXT = {
    next_slide: 'Agli slide.', prev_slide: 'Pichhli slide.', scroll_down: 'Neeche scroll kiya.',
    scroll_up: 'Upar scroll kiya.', back: 'Back dabaya.', home: 'Home dabaya.', recents: 'Recent apps khuli.',
    play_pause: 'Play/Pause dabaya.', next: 'Agla track.', previous: 'Pichhla track.',
    volume_up: 'Volume badhaya.', volume_down: 'Volume kam kiya.', mute: 'Mute/Unmute kiya.', wake: 'Screen jaga di.',
};
// English one-word acks from the TV that read better as the Hinglish text above.
const GENERIC_KEY_MSGS = ['Done', 'Play/Pause', 'Next', 'Previous', 'Volume +', 'Volume -', 'Mute', 'Screen on'];

// ---------- storage (falls back to memory) ----------

const storage = (() => {
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
            if (!ok) return null;
            try { return window.localStorage.getItem(k); } catch (e) { return null; }
        },
        set(k, v) {
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
    tvs: [],               // [{name, code, relay}], same shape as saved
    links: new Map(),      // code -> TvLink
    selected: null,        // code | ALL | null
    apps: new Map(),       // code -> [{label, pkg}]
    appsShownFor: undefined,
    pinging: new Set(),
    pairOpen: false,
    fileBusy: false,
    awakeBusy: false,
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
    return out;
}

function saveTvs() {
    const ok = storage.set(STORE_KEY, JSON.stringify(state.tvs.map(t => ({ name: t.name, code: t.code, relay: t.relay }))));
    $('storageNote').hidden = ok;
}

// ---------- links ----------

function linkFor(tv) {
    let l = state.links.get(tv.code);
    if (l && l.relay !== (normalizeRelay(tv.relay) || DEFAULT_RELAY)) {
        l.close();
        l = null;
    }
    if (!l) {
        l = new TvLink({ code: tv.code, name: tv.name, relay: tv.relay });
        l.onchange = scheduleRender;
        state.links.set(tv.code, l);
        l.init().catch(() => fatal('Is browser mein encryption nahi chal raha. Chrome ya Edge ka naya version use karein.'));
    }
    return l;
}

const statusOf = tv => {
    const l = state.links.get(tv.code);
    return l && l.status ? l.status : null;
};

function tvName(tv) {
    const s = statusOf(tv);
    return tv.name || (s && cleanName(s.name)) || 'TV ' + displayCode(tv.code).slice(0, 5);
}

const prefix = tv => (state.tvs.length > 1 ? tvName(tv) + ': ' : '');
const selectedTv = () => state.tvs.find(t => t.code === state.selected) || null;

function targets() {
    if (state.selected === ALL) return state.tvs.slice();
    const t = selectedTv();
    return t ? [t] : [];
}

function lanUrl(tv) {
    const s = tv && statusOf(tv);
    const list = s && Array.isArray(s.lanUrls) ? s.lanUrls : [];
    for (const u of list) {
        try {
            const url = new URL(String(u));
            if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
        } catch (e) { /* skip */ }
    }
    return '';
}

function lanLink(tv) {
    const href = lanUrl(tv);
    return href ? { href, label: 'Same Wi-Fi page' } : null;
}

// ---------- toast ----------

let toastTimer = 0;

function toast(text, kind = 'ok', { link, duration } = {}) {
    const t = $('toast');
    $('toastText').textContent = text;
    t.className = 'toast show' + (kind === 'bad' ? ' bad' : '');
    const a = $('toastLink');
    if (link && link.href) {
        a.href = link.href;
        a.textContent = link.label;
        a.hidden = false;
    } else {
        a.hidden = true;
        a.removeAttribute('href');
    }
    clearTimeout(toastTimer);
    const ms = duration != null ? duration : (kind === 'bad' ? 9000 : 3500);
    if (ms > 0) toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
    clearTimeout(toastTimer);
    $('toast').classList.remove('show');
}

function fmtMB(bytes) {
    return (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0) + ' MB';
}

function tooBigText(size) {
    return 'Yeh file ' + fmtMB(size) + ' ki hai. Internet se sirf ' + Math.round(MAX_FILE_BYTES / 1e6)
        + ' MB tak ki file TV par ja sakti hai. Badi file ke liye: use Google Drive par daal kar link upar '
        + '"Link kholo" box mein bhejein, ya laptop ko TV wale Wi-Fi par rakh kar TV ka Same Wi-Fi page kholein.';
}

function errText(e) {
    switch (e && e.code) {
        case 'timeout':
            return 'TV se jawab nahi aaya. TV on hai aur internet se juda hai? TV par Office TV app ek baar kholein.';
        case 'rate_limit':
            return 'Aaj ki free limit poori ho gayi. Commands free ntfy.sh se jaate hain, jo poore office ko roz '
                + 'seemit messages deta hai. Kuch der baad try karein, ya TV wale Wi-Fi par TV ka Same Wi-Fi page kholein.';
        case 'network':
            return 'Internet check karein. Yeh laptop/phone abhi internet se juda nahi lag raha.';
        case 'too_big':
            return tooBigText(e.size || 0);
        case 'relay':
            return 'Relay server se jawab theek nahi aaya' + (e.status ? ' (' + e.status + ')' : '')
                + '. Thodi der baad dobara try karein.';
        default:
            return 'Kuch gadbad hui. Dobara try karein.';
    }
}

function showError(tv, e) {
    const link = e && (e.code === 'rate_limit' || e.code === 'too_big') ? lanLink(tv) : null;
    toast((tv ? prefix(tv) : '') + errText(e), 'bad', { link });
}

function ackText(cmd, args, ack, okText) {
    if (!ack.ok) return ack.msg || 'TV ne yeh command nahi maani.';
    if (cmd === 'key' && (!ack.msg || GENERIC_KEY_MSGS.indexOf(ack.msg) >= 0)) return KEY_TEXT[args.key] || 'Ho gaya.';
    return ack.msg || okText || 'Ho gaya.';
}

function fatal(text) {
    $('fatalText').textContent = text;
    $('fatal').hidden = false;
}

// ---------- rendering ----------

let renderQueued = false;

function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    Promise.resolve().then(() => {
        renderQueued = false;
        render();
    });
}

function render() {
    const has = state.tvs.length > 0;
    $('picker').hidden = !has;
    $('tvBar').hidden = !has;
    $('controls').hidden = !has;
    const pair = $('pairCard');
    pair.hidden = has && !state.pairOpen;
    pair.classList.toggle('with-tvs', has);
    $('pairCancel').hidden = !has;
    if (state.selected !== ALL) $('results').hidden = true;
    if (!has) {
        $('permBanner').hidden = true;
        return;
    }
    renderPicker();
    renderBar();
    renderNotices();
    renderScreen();
    if (state.appsShownFor !== state.selected) renderApps();
}

function makeChip(code) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tv-chip' + (code === ADD ? ' add' : '');
    b.dataset.code = code;
    if (code === ADD) {
        b.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-plus"/></svg><span>TV jodein</span>';
        b.addEventListener('click', () => (state.pairOpen ? closePair() : openPair()));
    } else if (code === ALL) {
        b.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-all"/></svg><span class="nm"></span>';
        b.addEventListener('click', () => select(ALL));
    } else {
        b.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="nm"></span><span class="sr-only"></span>';
        b.addEventListener('click', () => select(code));
    }
    return b;
}

function renderPicker() {
    const nav = $('picker');
    const want = state.tvs.map(t => t.code);
    if (state.tvs.length > 1) want.push(ALL);
    want.push(ADD);
    const existing = new Map();
    for (const el of Array.from(nav.children)) existing.set(el.dataset.code, el);
    want.forEach((code, i) => {
        const b = existing.get(code) || makeChip(code);
        existing.delete(code);
        if (code === ADD) {
            b.setAttribute('aria-expanded', String(!!state.pairOpen));
        } else {
            b.setAttribute('aria-pressed', String(state.selected === code));
            if (code === ALL) {
                b.querySelector('.nm').textContent = 'Sab TV (' + state.tvs.length + ')';
            } else {
                const tv = state.tvs.find(t => t.code === code);
                const l = state.links.get(code);
                const st = l ? l.state : 'unknown';
                b.querySelector('.dot').className = 'dot ' + st;
                b.querySelector('.nm').textContent = tvName(tv);
                b.querySelector('.sr-only').textContent = ', ' + STATE_TEXT[st];
                b.title = tvName(tv) + ' (' + STATE_TEXT[st] + ')';
            }
        }
        if (nav.children[i] !== b) nav.insertBefore(b, nav.children[i] || null);
    });
    for (const el of existing.values()) el.remove();
}

function renderBar() {
    const meta = $('barMeta');
    meta.classList.remove('bad');
    if (state.selected === ALL) {
        const counts = { online: 0, offline: 0, unknown: 0 };
        for (const tv of state.tvs) counts[(state.links.get(tv.code) || {}).state || 'unknown']++;
        $('barDot').className = 'dot ' + (counts.offline ? 'offline' : counts.unknown ? 'unknown' : 'online');
        $('barName').textContent = 'Sab TV (' + state.tvs.length + ')';
        const parts = [];
        if (counts.online) parts.push(counts.online + ' online');
        if (counts.offline) parts.push(counts.offline + ' se jawab nahi aaya');
        if (counts.unknown) parts.push(counts.unknown + ' ka status pata nahi');
        meta.textContent = 'Har command sab TV par jayegi. ' + parts.join(', ') + '.';
        $('refreshBtn').lastElementChild.textContent = 'Sab refresh';
        $('renameBtn').hidden = true;
        $('removeBtn').hidden = true;
        $('barLan').hidden = true;
        return;
    }
    const tv = selectedTv();
    if (!tv) return;
    const l = linkFor(tv);
    const s = l.status;
    $('barDot').className = 'dot ' + l.state;
    $('barName').textContent = tvName(tv);
    $('refreshBtn').lastElementChild.textContent = 'Refresh';
    $('renameBtn').hidden = false;
    $('removeBtn').hidden = false;
    if (state.pinging.has(tv.code) && l.state !== 'online') {
        meta.textContent = 'TV se baat kar rahe hain…';
    } else if (l.state === 'offline') {
        meta.textContent = 'TV se jawab nahi aaya. TV on hai aur internet se juda hai? TV par Office TV app ek baar kholein.';
        meta.classList.add('bad');
    } else if (s) {
        const bits = [];
        if (s.model) bits.push(String(s.model));
        if (s.android) bits.push('Android ' + s.android);
        if (s.appVersion) bits.push('App ' + s.appVersion + (s.flavor === 'lite' ? ' (lite)' : ''));
        bits.push(l.state === 'online' ? 'Online' : 'Status purana hai');
        meta.textContent = bits.join(' · ');
    } else {
        meta.textContent = l.state === 'online' ? 'Online' : 'Status pata nahi. Refresh dabayein.';
    }
    const lan = lanUrl(tv);
    $('barLan').hidden = !lan;
    if (lan) $('barLan').href = lan;
}

function renderNotices() {
    const list = targets().map(tv => ({ tv, s: statusOf(tv) })).filter(x => x.s && x.s.needsPermission);
    const banner = $('permBanner');
    if (!list.length) {
        banner.hidden = true;
    } else {
        let text;
        if (state.selected === ALL) {
            text = 'In TV par ek permission baaki hai: ' + list.map(x => tvName(x.tv)).join(', ')
                + '. Us TV par Office TV app kholein aur jo permission maange (Accessibility ya "Display over other apps") on karein, '
                + 'warna links aur files TV par nahi khulenge.';
        } else if (list[0].s.flavor === 'lite') {
            text = 'TV par ek permission baaki hai. TV par Office TV app kholein aur "Display over other apps" allow karein, '
                + 'warna links aur files TV par nahi khulenge.';
        } else {
            text = 'TV par ek permission baaki hai. TV par Office TV app kholein aur Accessibility on karein '
                + '(Settings > Accessibility > Office TV > On), warna links, files aur remote buttons TV par nahi chalenge.';
        }
        $('permText').textContent = text;
        banner.hidden = false;
    }
    const tv = selectedTv();
    const s = tv && statusOf(tv);
    $('a11yNote').hidden = !(s && s.accessibility === false && !s.needsPermission && s.flavor !== 'lite');
    const lan = lanUrl(tv);
    $('fileLan').hidden = !lan;
    if (lan) $('fileLan').href = lan;
}

function renderScreen() {
    const known = targets().map(statusOf).filter(Boolean);
    if (!state.awakeBusy && known.length) $('awake').checked = known.every(s => s.keepAwake !== false);
    const vol = $('vol');
    const s = state.selected !== ALL && known[0];
    if (s && s.maxVolume > 0 && document.activeElement !== vol) {
        vol.value = String(Math.round(s.volume * 100 / s.maxVolume / 5) * 5);
        $('volOut').textContent = vol.value + '%';
    }
}

function renderApps() {
    const sel = state.selected;
    state.appsShownFor = sel;
    const allMode = sel === ALL;
    $('loadApps').disabled = allMode || !sel;
    $('appsNote').hidden = !allMode;
    const box = $('apps');
    box.textContent = '';
    const list = !allMode && sel ? state.apps.get(sel) : null;
    const filter = $('appFilter');
    filter.hidden = !list || list.length < 8;
    if (!list) {
        filter.value = '';
        return;
    }
    const q = filter.hidden ? '' : filter.value.trim().toLowerCase();
    const shown = q ? list.filter(a => (a.label + ' ' + a.pkg).toLowerCase().indexOf(q) >= 0) : list;
    for (const a of shown) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        b.title = a.label + ' (' + a.pkg + ')';
        b.addEventListener('click', () => act('app', { pkg: a.pkg }, { btn: b, okText: a.label + ' TV par khul gaya.' }));
        box.appendChild(b);
    }
    if (!shown.length) {
        const p = document.createElement('p');
        p.className = 'note';
        p.textContent = q ? 'Is naam ki koi app nahi mili.' : 'TV par koi app nahi mili.';
        box.appendChild(p);
    }
}

function showResults(title, res, textFor) {
    $('resultsTitle').textContent = title;
    const ul = $('resultsList');
    ul.textContent = '';
    for (const r of res) {
        const ok = !!(r.ack && r.ack.ok);
        const li = document.createElement('li');
        li.className = ok ? 'ok' : 'bad';
        const dot = document.createElement('span');
        dot.className = 'dot ' + (r.ack ? 'online' : r.err && r.err.code === 'timeout' ? 'offline' : 'unknown');
        dot.setAttribute('aria-hidden', 'true');
        const b = document.createElement('b');
        b.textContent = tvName(r.tv);
        const msg = document.createElement('span');
        msg.className = 'msg';
        msg.textContent = r.ack ? textFor(r.ack) : errText(r.err);
        li.append(dot, b, msg);
        ul.appendChild(li);
    }
    $('results').hidden = false;
}

function summaryToast(res, textFor) {
    const good = res.filter(r => r.ack && r.ack.ok).length;
    if (good === res.length) {
        toast('Sab ' + res.length + ' TV par ho gaya.', 'ok');
        return;
    }
    const bad = res.find(r => !(r.ack && r.ack.ok));
    const why = bad.ack ? textFor(bad.ack) : errText(bad.err);
    const rl = res.find(r => r.err && r.err.code === 'rate_limit');
    toast(res.length + ' mein se ' + good + ' TV par ho gaya. ' + tvName(bad.tv) + ': ' + why, 'bad',
        { link: rl ? lanLink(rl.tv) : null, duration: 12000 });
}

// ---------- actions ----------

function setBusy(btn, on) {
    if (!btn) return;
    btn._busy = Math.max(0, (btn._busy || 0) + (on ? 1 : -1));
    if (btn._busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
}

/** Sends a command to the selected TV (or every TV) and shows the result. Resolves with [{tv, ack|err}]. */
async function act(cmd, args, { btn, timeoutMs, okText, silent } = {}) {
    const list = targets();
    if (!list.length) {
        toast('Pehle ek TV jodein.', 'bad');
        openPair();
        return [];
    }
    const textFor = ack => ackText(cmd, args, ack, okText);
    setBusy(btn, true);
    try {
        if (state.selected !== ALL) {
            const tv = list[0];
            const slow = setTimeout(() => toast(prefix(tv) + 'TV ko bhej rahe hain…', 'info', { duration: 0 }), 900);
            try {
                const ack = await linkFor(tv).send(cmd, args, { timeoutMs });
                clearTimeout(slow);
                if (!ack.ok || !silent) toast(prefix(tv) + textFor(ack), ack.ok ? 'ok' : 'bad');
                else hideToast();
                return [{ tv, ack }];
            } catch (e) {
                clearTimeout(slow);
                showError(tv, e);
                return [{ tv, err: e }];
            }
        }
        toast(list.length + ' TV ko bhej rahe hain…', 'info', { duration: 0 });
        const res = await Promise.all(list.map(tv => linkFor(tv).send(cmd, args, { timeoutMs })
            .then(ack => ({ tv, ack }), err => ({ tv, err }))));
        showResults('Sab TV: ' + actionTitle(cmd, args), res, textFor);
        summaryToast(res, textFor);
        return res;
    } finally {
        setBusy(btn, false);
        render();
    }
}

function actionTitle(cmd, args) {
    switch (cmd) {
        case 'open': return 'Link kholo';
        case 'youtube': return 'YouTube';
        case 'key': return (KEY_TEXT[args.key] || args.key).replace(/\.$/, '');
        case 'volume': return 'Volume ' + args.percent + '%';
        case 'awake': return args.on ? 'Screen hamesha on' : 'Screen normal';
        case 'ping': return 'Refresh';
        default: return cmd;
    }
}

async function pingTv(tv) {
    const l = linkFor(tv);
    state.pinging.add(tv.code);
    scheduleRender();
    try {
        const ack = await l.ping();
        adoptStatus(tv);
        return { tv, ack };
    } catch (err) {
        return { tv, err };
    } finally {
        state.pinging.delete(tv.code);
        render();
    }
}

function maybePing(tv, freshMs) {
    const l = linkFor(tv);
    if (state.pinging.has(tv.code) || Date.now() - Math.max(l.lastPingAt, l.lastAckAt) < freshMs) return;
    pingTv(tv).then(r => {
        if (r.err && r.err.code !== 'timeout') showError(tv, r.err); // offline already shows on the chip
    });
}

function adoptStatus(tv) {
    const s = statusOf(tv);
    if (s && !tv.name && s.name) {
        tv.name = cleanName(s.name);
        saveTvs();
    }
}

function select(code, { ping = true } = {}) {
    state.selected = code;
    storage.set(SELECTED_KEY, code || '');
    render();
    if (ping) for (const tv of targets()) maybePing(tv, PING_FRESH_MS);
}

// ---------- pairing ----------

function openPair() {
    state.pairOpen = true;
    render();
    $('pairCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('pairCode').focus();
}

function closePair() {
    state.pairOpen = false;
    setPairError('');
    render();
}

function setPairError(text) {
    $('pairErr').textContent = text;
    if (text) $('pairCode').setAttribute('aria-invalid', 'true');
    else $('pairCode').removeAttribute('aria-invalid');
}

function looseCode(raw) {
    return String(raw || '').toUpperCase().replace(/[\s\-‐-―]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Explains what is wrong with a typed code, or returns '' when it is valid. */
function explainCode(raw) {
    const s = looseCode(raw);
    if (!s) return 'TV code likhein. Yeh TV par Office TV app ki screen par dikhta hai (jaise 7K3M9-QX2TD).';
    const bad = [];
    for (const ch of s) if (ALPHABET.indexOf(ch) < 0 && bad.indexOf(ch) < 0) bad.push(ch);
    if (bad.indexOf('U') >= 0) return 'Code mein "U" nahi hota. Shayad woh "V" hai? TV par dobara dekh kar likhein.';
    if (bad.length) return 'Code mein "' + bad.join(' ') + '" nahi hota. Code mein sirf 0-9 aur A-Z akshar hote hain.';
    if (s.length < 10) return 'Code 10 akshar ka hota hai (jaise 7K3M9-QX2TD). Abhi ' + s.length + ' likhe hain, ' + (10 - s.length) + ' baaki hain.';
    if (s.length > 10) return 'Code 10 akshar ka hota hai (jaise 7K3M9-QX2TD). Abhi ' + s.length + ' likhe hain, ' + (s.length - 10) + ' zyada hain.';
    return '';
}

function onCodeInput() {
    const raw = $('pairCode').value;
    const help = $('pairHelp');
    const s = looseCode(raw);
    setPairError('');
    help.classList.remove('good');
    if (/pair=/i.test(raw)) {
        help.textContent = parsePairFragment(raw) ? 'Pairing link mil gaya. "TV jodein" dabayein.' : 'Yeh pairing link poora nahi hai.';
        return;
    }
    const problem = s ? explainCode(raw) : '';
    if (!s) {
        help.textContent = '10 akshar. Chhote ya bade akshar, space aur dash sab chalenge.';
    } else if (!problem) {
        help.textContent = 'Code theek hai: ' + displayCode(s);
        help.classList.add('good');
    } else if (/nahi hota/.test(problem)) {
        setPairError(problem);
        help.textContent = '';
    } else {
        help.textContent = Math.min(s.length, 99) + '/10 akshar';
    }
}

function submitPair() {
    const raw = $('pairCode').value;
    const name = cleanName($('pairName').value);
    if (/pair=/i.test(raw)) {
        const p = parsePairFragment(raw);
        if (p) {
            pairTv({ code: p.code, name: name || p.name, relay: p.relay }, { focus: true });
            return;
        }
    }
    const problem = explainCode(raw);
    if (problem) {
        setPairError(problem);
        $('pairHelp').textContent = '';
        $('pairCode').focus();
        return;
    }
    pairTv({ code: normalizeCode(looseCode(raw)), name, relay: DEFAULT_RELAY }, { focus: true });
}

async function pairTv({ code, name, relay }, { focus = false } = {}) {
    let tv = state.tvs.find(t => t.code === code);
    const existed = !!tv;
    if (tv) {
        if (name) tv.name = name;
        if (relay) tv.relay = relay;
    } else {
        tv = { name: name || '', code, relay: relay || DEFAULT_RELAY };
        state.tvs.push(tv);
    }
    saveTvs();
    $('pairForm').reset();
    onCodeInput();
    state.pairOpen = false;
    select(code, { ping: false });
    if (focus) {
        const chip = $('picker').querySelector('[data-code="' + code + '"]');
        if (chip) chip.focus();
    }
    toast((existed ? tvName(tv) + ' pehle se juda hai. ' : 'TV jud gaya. ') + 'TV se baat kar rahe hain…', 'info', { duration: 0 });
    const r = await pingTv(tv);
    if (r.ack && r.ack.ok) {
        toast(tvName(tv) + ' jud gaya. Ab neeche se TV chalayein.', 'ok', { duration: 5000 });
    } else if (r.ack) {
        toast(prefix(tv) + (r.ack.msg || 'TV ne jawab diya, par kuch gadbad hai.'), 'bad');
    } else if (r.err.code === 'timeout') {
        toast('TV save ho gaya, par TV se abhi jawab nahi aaya. TV on hai, internet se juda hai aur code sahi hai? '
            + 'TV par Office TV app ek baar kholein, phir Refresh dabayein.', 'bad', { duration: 12000 });
    } else {
        showError(tv, r.err);
    }
}

function takeFragment() {
    const h = location.hash || '';
    if (!/pair=/i.test(h)) return null;
    const p = parsePairFragment(h);
    try {
        history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
        location.hash = '';
    }
    return p || { invalid: true };
}

function handleFragment() {
    const frag = takeFragment();
    if (!frag) return false;
    if (frag.invalid) {
        openPair();
        setPairError('Pairing link adhoora ya galat hai. TV par dikh raha TV code yahan haath se likhein.');
    } else {
        pairTv(frag);
    }
    return true;
}

// ---------- link, YouTube, files ----------

/** Turns what people type into a URL: 'meet.google.com/abc' -> https://..., a Meet code, or a Google search. */
function toUrl(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(s)) return 'https://meet.google.com/' + s.toLowerCase();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(mailto|tel|intent|market):/i.test(s)) return s;
    const host = s.split(/[/?#]/)[0];
    if (/\s/.test(s) || !(host.indexOf('.') > 0 || /^localhost(:\d+)?$/i.test(host))) {
        return 'https://www.google.com/search?q=' + encodeURIComponent(s);
    }
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host)) return 'http://' + s;
    return 'https://' + s;
}

function setProgress(f) {
    const pct = Math.round(Math.max(0, Math.min(1, f)) * 100);
    $('progBar').firstElementChild.style.width = pct + '%';
    $('progBar').setAttribute('aria-valuenow', String(pct));
    $('progPct').textContent = pct + '%';
}

function showFileMsg(text) {
    const box = $('fileMsg');
    box.textContent = '';
    const p = document.createElement('p');
    p.textContent = text;
    box.appendChild(p);
    box.hidden = false;
}

async function sendFile(file) {
    if (!file || state.fileBusy) return;
    const list = targets();
    if (!list.length) {
        toast('Pehle ek TV jodein.', 'bad');
        return;
    }
    $('fileMsg').hidden = true;
    if (file.size > MAX_FILE_BYTES) {
        showFileMsg(tooBigText(file.size));
        toast('File ' + fmtMB(file.size) + ' ki hai, 15 MB tak hi ja sakti hai. Google Drive link ya Same Wi-Fi page use karein.',
            'bad', { link: lanLink(list[0]) });
        return;
    }
    if (!file.size) {
        toast('Yeh file khaali hai (0 KB).', 'bad');
        return;
    }
    state.fileBusy = true;
    $('drop').classList.add('busy');
    $('progWrap').hidden = false;
    setProgress(0);
    const res = [];
    try {
        for (let i = 0; i < list.length; i++) {
            const tv = list[i];
            $('progName').textContent = (list.length > 1 ? tvName(tv) + ' (' + (i + 1) + '/' + list.length + '): ' : 'Bhej rahe hain: ') + file.name;
            try {
                const ack = await linkFor(tv).sendFile(file, { onProgress: f => setProgress((i + f) / list.length) });
                res.push({ tv, ack });
            } catch (err) {
                res.push({ tv, err });
            }
        }
    } finally {
        state.fileBusy = false;
        $('drop').classList.remove('busy');
        setTimeout(() => { if (!state.fileBusy) $('progWrap').hidden = true; }, 1500);
        render();
    }
    const textFor = ack => ack.msg || (ack.ok ? file.name + ' TV par bhej di.' : 'TV par file nahi khuli.');
    if (state.selected !== ALL) {
        const r = res[0];
        if (r.ack) toast(prefix(r.tv) + textFor(r.ack), r.ack.ok ? 'ok' : 'bad');
        else showError(r.tv, r.err);
        if (r.err && r.err.code === 'too_big') showFileMsg(tooBigText(file.size));
    } else {
        showResults('Sab TV: ' + file.name, res, textFor);
        summaryToast(res, textFor);
    }
}

// ---------- dialogs ----------

function openDialog(d) {
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
}

function closeDialog(d) {
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
}

// ---------- wiring ----------

function wire() {
    $('pairForm').addEventListener('submit', e => { e.preventDefault(); submitPair(); });
    $('pairCode').addEventListener('input', onCodeInput);
    $('pairCancel').addEventListener('click', closePair);
    $('toastClose').addEventListener('click', hideToast);
    $('resultsClose').addEventListener('click', () => { $('results').hidden = true; });

    $('openForm').addEventListener('submit', e => {
        e.preventDefault();
        const url = toUrl($('url').value);
        if (!url) {
            toast('Pehle link ya website likhein.', 'bad');
            $('url').focus();
            return;
        }
        act('open', { url }, { btn: $('openForm').querySelector('button') });
    });
    $('ytForm').addEventListener('submit', e => {
        e.preventDefault();
        act('youtube', { q: $('yt').value.trim() }, { btn: $('ytForm').querySelector('button') });
    });
    for (const b of document.querySelectorAll('[data-url]')) {
        b.addEventListener('click', () => act('open', { url: b.dataset.url }, { btn: b }));
    }
    for (const b of document.querySelectorAll('[data-key]')) {
        b.addEventListener('click', () => act('key', { key: b.dataset.key }, { btn: b }));
    }
    $('vol').addEventListener('input', () => { $('volOut').textContent = $('vol').value + '%'; });
    $('vol').addEventListener('change', () => act('volume', { percent: Number($('vol').value) }));

    $('awake').addEventListener('change', async () => {
        const el = $('awake');
        const on = el.checked;
        state.awakeBusy = true;
        let res;
        try {
            res = await act('awake', { on }, { btn: null });
        } finally {
            state.awakeBusy = false;
        }
        let any = false;
        for (const r of res) {
            if (r.ack && r.ack.ok) {
                any = true;
                const s = statusOf(r.tv);
                if (s) s.keepAwake = on;
            }
        }
        if (!any) el.checked = !on;
        render();
    });

    $('loadApps').addEventListener('click', async () => {
        const tv = selectedTv();
        if (!tv) return;
        const [r] = await act('apps', {}, { btn: $('loadApps'), timeoutMs: 20000, silent: true });
        if (!r || !r.ack || !r.ack.ok) return;
        const apps = (Array.isArray(r.ack.data.apps) ? r.ack.data.apps : [])
            .filter(a => a && typeof a.pkg === 'string' && a.pkg)
            .map(a => ({ label: cleanName(a.label) || a.pkg, pkg: a.pkg }));
        state.apps.set(tv.code, apps);
        renderApps();
        if (!apps.length) toast(prefix(tv) + 'TV par koi app nahi mili.', 'bad');
        else if (r.ack.partial) toast(prefix(tv) + 'Kuch hi apps aa paayi (' + apps.length + '). Poori list ke liye dobara dabayein.', 'bad');
        else toast(prefix(tv) + apps.length + ' apps mili. Kisi par dabayein, woh TV par khul jayegi.', 'ok');
    });
    $('appFilter').addEventListener('input', renderApps);

    $('file').addEventListener('change', () => {
        const input = $('file');
        const f = input.files && input.files[0];
        sendFile(f).finally(() => { input.value = ''; });
    });
    const drop = $('drop');
    const stop = e => { e.preventDefault(); e.stopPropagation(); };
    drop.addEventListener('dragenter', e => { stop(e); drop.classList.add('drag'); });
    drop.addEventListener('dragover', e => { stop(e); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', e => {
        stop(e);
        drop.classList.remove('drag');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) sendFile(f);
    });
    // A file dropped next to the box must not replace this page.
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());

    $('refreshBtn').addEventListener('click', async () => {
        const btn = $('refreshBtn');
        const list = targets();
        if (!list.length) return;
        setBusy(btn, true);
        const res = await Promise.all(list.map(pingTv));
        setBusy(btn, false);
        const textFor = ack => ack.msg || 'TV online hai.';
        if (state.selected !== ALL) {
            const r = res[0];
            if (r.ack) toast(prefix(r.tv) + (r.ack.ok ? 'TV online hai.' : textFor(r.ack)), r.ack.ok ? 'ok' : 'bad');
            else showError(r.tv, r.err);
        } else {
            showResults('Sab TV: Refresh', res, ack => (ack.ok ? 'Online hai.' : textFor(ack)));
            summaryToast(res, textFor);
        }
    });

    const renameDlg = $('renameDlg');
    $('renameBtn').addEventListener('click', () => {
        const tv = selectedTv();
        if (!tv) return;
        $('renameInput').value = tvName(tv);
        $('renameErr').textContent = '';
        openDialog(renameDlg);
        $('renameInput').select();
    });
    $('renameCancel').addEventListener('click', () => closeDialog(renameDlg));
    $('renameForm').addEventListener('submit', async e => {
        e.preventDefault();
        const tv = selectedTv();
        const name = cleanName($('renameInput').value);
        if (!name) {
            $('renameErr').textContent = 'Naam likhein (1 se 40 akshar).';
            return;
        }
        closeDialog(renameDlg);
        if (!tv) return;
        const [r] = await act('rename', { name }, { btn: $('renameBtn'), silent: true });
        if (r && r.ack && r.ack.ok) {
            tv.name = cleanName((r.ack.data && r.ack.data.name) || name) || name;
            saveTvs();
            render();
            toast('Naam badal diya: ' + tv.name, 'ok');
        }
    });

    const removeDlg = $('removeDlg');
    $('removeBtn').addEventListener('click', () => {
        const tv = selectedTv();
        if (!tv) return;
        $('removeText').textContent = '"' + tvName(tv) + '" ko is browser se hatana hai? TV par kuch nahi badlega. '
            + 'Dobara jodne ke liye TV code chahiye hoga.';
        openDialog(removeDlg);
    });
    $('removeCancel').addEventListener('click', () => closeDialog(removeDlg));
    $('removeOk').addEventListener('click', e => {
        e.preventDefault();
        closeDialog(removeDlg);
        const tv = selectedTv();
        if (!tv) return;
        const name = tvName(tv);
        const l = state.links.get(tv.code);
        if (l) l.close();
        state.links.delete(tv.code);
        state.apps.delete(tv.code);
        state.tvs = state.tvs.filter(t => t !== tv);
        saveTvs();
        state.appsShownFor = undefined;
        select(state.tvs.length ? state.tvs[0].code : null);
        toast(name + ' hata diya.', 'ok');
    });

    // Arrow keys, PageUp/PageDown (and USB presenter clickers) change slides on the TV.
    document.addEventListener('keydown', e => {
        if (e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const key = { ArrowRight: 'next_slide', PageDown: 'next_slide', ArrowLeft: 'prev_slide', PageUp: 'prev_slide' }[e.key];
        if (!key || $('controls').hidden || !targets().length) return;
        const t = e.target;
        if (t && t.closest && t.closest('input, textarea, select, [contenteditable], dialog')) return;
        e.preventDefault();
        act('key', { key }, { btn: document.querySelector('[data-key="' + key + '"]') });
    });

    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            hiddenAt = Date.now();
        } else if (hiddenAt && Date.now() - hiddenAt > VISIBLE_PING_MS) {
            for (const tv of targets()) maybePing(tv, VISIBLE_PING_MS);
        }
    });
    window.addEventListener('hashchange', handleFragment);
}

function start() {
    if (!window.crypto || !window.crypto.subtle) {
        fatal('Yeh page sirf https link par chalta hai. Yeh link kholein: ' + CONTROLLER_URL);
        return;
    }
    if (typeof window.EventSource !== 'function' || typeof window.fetch !== 'function') {
        fatal('Yeh browser purana hai. Chrome ya Edge ka naya version use karein.');
        return;
    }
    state.tvs = loadTvs();
    $('storageNote').hidden = storage.ok;
    const saved = storage.get(SELECTED_KEY);
    if (saved === ALL && state.tvs.length > 1) state.selected = ALL;
    else if (state.tvs.some(t => t.code === saved)) state.selected = saved;
    else state.selected = state.tvs.length ? state.tvs[0].code : null;
    for (const tv of state.tvs) linkFor(tv);
    wire();
    render();
    if (!handleFragment()) {
        for (const tv of targets()) maybePing(tv, PING_FRESH_MS);
    }
}

start();
