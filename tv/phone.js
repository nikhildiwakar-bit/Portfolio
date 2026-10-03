// Target of the QR code on the Office TV home screen: .../tv/phone.html#h=IP&p=PORT&k=SECRET&n=NAME&c=CODE.
// The TV details live only in the fragment, which browsers never send to a server; it is removed from the
// address bar at once. With the TV code (c: 4 digits on Office TV 3.6+, a new one every time the TV app
// opens, so the QR code changes with it) and a browser that can capture its screen, the phone shares
// straight from this page, like a laptop (no app): the same steady frame rate, and a shared tab's sound plays
// on the TV only. Otherwise the page hands the details to the Office TV app.
import { normalizeCode, TvLink } from './otv.js';
import { CastSender, captureScreen, senderSupport } from './cast.js';

const APP_PACKAGE = 'com.nikhil.officetv';
const $ = id => document.getElementById(id);
const show = id => { $(id).hidden = false; };
const hide = id => { $(id).hidden = true; };

const hash = location.hash.replace(/^#/, '');
const params = {};
for (const kv of hash.split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) { try { params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* ignore */ } }
}
if (hash && history.replaceState) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
}
const validApp = /^[A-Za-z0-9.:-]{1,253}$/.test(params.h || '') && /^\d{1,5}$/.test(params.p || '')
    && /^[A-Za-z0-9_-]{43}$/.test(params.k || '');
const code = normalizeCode(params.c || '');
const name = (params.n || 'Office TV').slice(0, 40);
const ua = navigator.userAgent || '';
const android = /Android/i.test(ua);
const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const canWeb = !!code && senderSupport(window) === null;
for (const el of document.querySelectorAll('.tvName')) el.textContent = name;

function appIntent() {
    const query = 'h=' + encodeURIComponent(params.h) + '&p=' + params.p + '&k=' + params.k + '&n=' + encodeURIComponent(name);
    const fallback = location.origin + location.pathname + '?install=1';
    return 'intent://connect?' + query + '#Intent;scheme=officetvphone;package=' + APP_PACKAGE
        + ';S.browser_fallback_url=' + encodeURIComponent(fallback) + ';end';
}

// ---------- share from the browser (no app) ----------

let session = null;

function setStatus(text, kind) {
    const el = $('webStatus');
    el.textContent = text;
    el.dataset.kind = kind || '';
    el.hidden = !text;
}

function render(phase) {
    const btn = $('webBtn');
    const busy = phase === 'picking' || phase === 'starting' || phase === 'waiting' || phase === 'connecting' || phase === 'reconnecting';
    const on = phase === 'sharing';
    btn.textContent = on ? 'Stop sharing' : busy ? 'Connecting…' : 'Share this phone’s screen';
    btn.disabled = busy && phase !== 'reconnecting';
    btn.classList.toggle('secondary', on);
    if (phase === 'picking') setStatus('Tap “Start now” when the phone asks.', '');
    else if (busy) setStatus('Connecting to ' + name + '…', '');
    else if (on) setStatus('Your screen is showing on ' + name + '. Keep this page open.', 'ok');
}

function stopStream(s) {
    if (s) for (const t of s.getTracks()) { try { t.stop(); } catch (e) { /* ignore */ } }
}

/** Closes the relay link once a last 'cast stop' (a share cancelled before it was up) got its ack, at most ~10 s. */
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
    setTimeout(attempt, 0);
}

function end(text, kind) {
    const s = session;
    session = null;
    if (s) {
        if (s.sender) { try { s.sender.stop('user'); } catch (e) { /* ignore */ } }
        stopStream(s.stream);
        retire(s.link);
    }
    render('idle');
    setStatus(text || '', kind || '');
}

function problem(code, err) {
    if (code === 'tv') return (err && err.message) || 'The TV could not open the screen view.';
    if (code === 'timeout') return name + ' did not answer. Scan the QR code on the TV again: it changes every time Office TV opens.';
    if (code === 'no_answer') return name + ' did not answer. Check that the TV is on and Office TV is open.';
    if (code === 'ice') return 'Could not reach ' + name + '. Put the phone on the same Wi-Fi as the TV, then try again.';
    if (code === 'network') return 'Screen sharing works only from a phone on the same Wi-Fi as ' + name + '. Connect to it, then try again.';
    if (code === 'offline') return 'No internet on this phone. Connect to Wi-Fi and try again.';
    if (code === 'rate_limit') return 'Too many attempts right now. Wait a minute, then try again.';
    return 'Sharing stopped because of a problem. Please try again.';
}

function share() {
    if (session) { end('Sharing stopped.', ''); return; }
    const picked = captureScreen(); // first call in the tap: the browser needs the gesture
    const link = new TvLink({ code, name });
    link.ready(8000).catch(() => {});
    const s = { link, stream: null, sender: null };
    session = s;
    render('picking');
    picked.then(stream => {
        if (session !== s) { stopStream(stream); return; }
        s.stream = stream;
        s.sender = new CastSender({
            link,
            onstate: (st, d) => {
                if (session !== s) return;
                if (st === 'stopped') end(d.reason === 'tv' ? 'The TV stopped showing your screen.' : 'Sharing stopped.', '');
                else if (st === 'error') end(problem(d.code, d.error), 'bad');
                else render(st);
            },
        });
        window.__otvCastSender = s.sender; // for tests
        render('starting');
        s.sender.start(stream);
    }, err => {
        if (session !== s) return;
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
        end(denied ? 'Screen sharing was not allowed. Tap the button and choose “Start now”.'
            : 'This browser could not capture the screen.', 'bad');
    });
}

// ---------- page ----------

if (ios) {
    show('ios');
} else if (canWeb) {
    show('web');
    $('webBtn').addEventListener('click', share);
    if (android && validApp) {
        $('appAlt').href = appIntent();
        show('appAltRow');
    }
} else if (!android) {
    show('desktop');
} else {
    show('castAlt');
    show('install');
    const fromIntent = /[?&]install=1/.test(location.search);
    if (hash && !validApp) show('bad');
    else if (hash && !fromIntent) {
        const intent = appIntent();
        $('openBtn').href = intent;
        show('open');
        $('install').querySelector('h1').textContent = 'Not installed yet?';
        if (code) show('noWeb');
        setTimeout(() => { location.href = intent; }, 50);
    }
}
