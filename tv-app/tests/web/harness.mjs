// Shared setup for the browser tests: one Chromium (with a fake screen picker), the local mock relay
// standing in for https://ntfy.sh (real encryption end to end), the static site, and fake TVs that ack
// 'ping' and 'cast' like the Office TV app. receiverFor(tv) opens tv/receive.html for each 'cast start',
// like CastActivity does, and closes it on 'cast stop'. Screenshots go to $OTV_SHOTS (default: <tmp>/officetv-shots).
// A local MQTT broker (servers.mjs startMqttBroker, wss://) stands in for the public ones: Chromium maps
// broker.emqx.io to it, and open() sets globalThis.__otvRelayConfig (tv/relay.js) before the page loads, by default
// { brokers: ['wss://broker.emqx.io:8084/mqtt'] }. The fake TVs listen on the broker and the ntfy mock and ack on
// the transport a command came over, like the app (the old 10-symbol TV only on ntfy). relay: NTFY_ONLY is a
// network that blocks MQTT.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelay, tvTransport } from './mock-relay.mjs';
import { makeCert, startMqttBroker, startRelayServers, startStatic } from './servers.mjs';
import { MQTT_PREFIX } from '../../../tv/relay.js';
import { createFakeTv } from '../node/fake-tv.mjs';
import { receiverUrl } from '../../../tv/cast.js';
import * as otv from '../../../tv/otv.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../..');
export const SHOTS = process.env.OTV_SHOTS || join(tmpdir(), 'officetv-shots');
// Office TV 3.6+ shows a new 4-digit code every time it opens; older TVs keep a 10-symbol code.
export const CODE_A = '4821';         // "Conference Room", answers
export const CODE_B = '7390';         // "Reception", never answers (switched off, or a mistyped code)
export const CODE_C = '2615';         // "Board Room", answers; used for real screen sharing
export const CODE_OLD = 'H7P2K9R4T1'; // "Lobby", an Office TV 3.5 (10-symbol code: ntfy only, offer after the ack)
/** Relay config for pages: no MQTT broker, so 4-digit codes use the ntfy mock only. */
export const NTFY_ONLY = { brokers: [] };
/** The broker the pages use (mapped to the local one). */
export const BROKER_URL = 'wss://broker.emqx.io:8084/mqtt';
export const HAS_TLS = !!makeCert();
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const HINGLISH = /\b(nahi|nahin|karein|karo|kholo|kholein|jodein|jod|juda|jud|kiya|dabaya|dabayein|chalao|dikhao|hatao|badlo|aaya|akshar|jaise|mein|baaki|zyada|sab|rahe|gaya|gayi|hamesha|jagao|chunein|likhein|madad|dein|haan|naam|pehle|kuch|abhi|bas|chahiye|wala|sirf|bina|kahin|hoga|hota|hai)\b/i;

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch (e) {
        const root = execSync('npm root -g').toString().trim();
        return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
    }
}

/** Like the TV app: the ack of 'cast start' carries the status object (the TV's name) and opens the receiver. */
function likeTheApp(tv) {
    tv.castAck = a => {
        if (typeof tv.oncast === 'function') tv.oncast(a.session);
        return { ok: true, msg: 'The TV is ready to show your screen.', data: Object.assign({}, tv.status) };
    };
}

let users = 0;
let envP = null;
let E = null;

async function create() {
    const { chromium } = await loadPlaywright();
    mkdirSync(SHOTS, { recursive: true });
    const relay = createRelay();
    const tls = makeCert('ntfy.sh');
    const relaySrv = await startRelayServers(relay, { tls });
    const web = await startStatic(REPO);
    // wss:// like the public brokers (the pages' CSP allows nothing else); without openssl: ntfy only.
    const brokerTls = tls ? makeCert('broker.emqx.io') : null;
    const broker = brokerTls ? await startMqttBroker({ tls: brokerTls }) : null;
    // The TV acks on the transport the command came over; over ntfy with cache=no, so acks are never replayed.
    const t = tvTransport(relay, broker);
    const tvA = await createFakeTv({ code: CODE_A, name: 'Conference Room', publish: t.publish });
    const tvB = await createFakeTv({ code: CODE_B, name: 'Reception', publish: t.publish, silent: true });
    const tvC = await createFakeTv({ code: CODE_C, name: 'Board Room', publish: t.publish });
    const tvOld = await createFakeTv({ code: CODE_OLD, name: 'Lobby', publish: t.publish, status: { appVersion: '3.5' } });
    const tvs = [tvA, tvB, tvC, tvOld];
    for (const tv of tvs) {
        t.listen(tv, { mqtt: tv !== tvOld }); // Office TV 3.5 has no MQTT
        likeTheApp(tv);
    }
    // Keep the sandbox proxy away from Chromium; map ntfy.sh and the broker to the local servers.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
    const args = ['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'];
    const rules = [];
    if (tls) rules.push('MAP ntfy.sh 127.0.0.1:' + relaySrv.httpsPort);
    if (broker) rules.push('MAP broker.emqx.io 127.0.0.1:' + broker.port);
    if (rules.length) args.push('--host-resolver-rules=' + rules.join(', '));
    const browser = await chromium.launch({ env, args });
    return {
        browser, relay, relaySrv, broker, web, tvA, tvB, tvC, tvOld, tvs, contexts: new Set(),
        relayConfig: broker ? { brokers: [BROKER_URL] } : NTFY_ONLY,
    };
}

/** Starts (once) and returns the shared environment. Pair with release() in an after() hook. */
export async function acquire() {
    users++;
    if (!envP) envP = create();
    E = await envP;
    return E;
}

export async function release() {
    if (--users > 0 || !envP) return;
    const e = await envP;
    envP = null;
    for (const c of Array.from(e.contexts)) await c.close().catch(() => {});
    await e.browser.close();
    await e.relaySrv.close();
    if (e.broker) await e.broker.close();
    await e.web.close();
}

/** Resets TVs and relay counters between tests and closes pages a failed test left open. */
export async function reset() {
    for (const c of Array.from(E.contexts)) await c.close().catch(() => {});
    E.contexts.clear();
    for (const tv of E.tvs) {
        tv.reset();
        likeTheApp(tv);
    }
    E.relay.rateLimit = false;
    E.relay.errors.length = 0;
    E.relay.requests.length = 0;
    E.relay.posts.length = 0;
    if (E.broker) {
        E.broker.published.length = 0;
        E.broker.errors.length = 0;
    }
}

/** Relay messages the pages sent to `tv`'s topic: ntfy POSTs + MQTT publishes. */
export function sentTo(tv) {
    return E.relay.posts.filter(p => p.topic === tv.topic).length + mqttTo(tv).length;
}

/** MQTT publishes of the pages to `tv`'s topic. */
export function mqttTo(tv) {
    return E.broker ? E.broker.published.filter(p => p.topic === MQTT_PREFIX + tv.topic) : [];
}

export async function until(fn, ms = 10000, what = 'condition') {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out waiting for ' + what);
        await sleep(40);
    }
}

/**
 * Records every getDisplayMedia call (with the options and whether the click's user activation was still
 * active), then uses Chromium's fake capture. Falls back to an animated canvas if that is unavailable.
 * With STILL_DISPLAY (window.__gdmStill) it returns a canvas that is drawn a few times at the start and then
 * never changes, like a slide on the laptop: the capture then produces (almost) no new frames.
 * window.__gdmPoke() draws the next slide once.
 */
export const RECORD_DISPLAY = () => {
    const md = navigator.mediaDevices;
    window.__gdm = { calls: [], source: '' };
    if (!md || !md.getDisplayMedia) return;
    const real = md.getDisplayMedia.bind(md);
    md.getDisplayMedia = async function (options) {
        window.__gdm.calls.push({ options: JSON.parse(JSON.stringify(options || {})), active: !!(navigator.userActivation && navigator.userActivation.isActive) });
        let stream;
        if (window.__gdmStill) {
            const c = document.createElement('canvas');
            c.width = 1280;
            c.height = 720;
            const g = c.getContext('2d');
            const draw = n => {
                g.fillStyle = '#123';
                g.fillRect(0, 0, 1280, 720);
                g.fillStyle = '#fff';
                g.font = '64px sans-serif';
                g.fillText('Quarterly results ' + n, 60, 160);
            };
            let n = 0;
            draw(n);
            stream = c.captureStream(); // a frame only when the canvas changes
            [50, 200, 600].forEach(ms => setTimeout(() => draw(++n), ms));
            window.__gdmPoke = () => draw(++n); // one change (the next slide), then still again
            window.__gdm.source = 'still canvas';
            window.__gdm.stream = stream;
            return stream;
        }
        try {
            stream = await real(options);
            window.__gdm.source = 'getDisplayMedia';
        } catch (e) {
            if (e && e.name === 'TypeError') throw e;
            window.__gdm.source = 'canvas';
            const c = document.createElement('canvas');
            c.width = 1280;
            c.height = 720;
            const g = c.getContext('2d');
            let n = 0;
            setInterval(() => {
                g.fillStyle = 'hsl(' + (n++ * 7 % 360) + ',60%,45%)';
                g.fillRect(0, 0, 1280, 720);
                g.fillStyle = '#fff';
                g.font = '64px sans-serif';
                g.fillText('Slide ' + n, 60, 160);
            }, 33);
            stream = c.captureStream(30);
        }
        window.__gdm.stream = stream;
        return stream;
    };
};

/** The shared screen is a still slide (see RECORD_DISPLAY). */
export const STILL_DISPLAY = () => { window.__gdmStill = true; };

/** The saved-TV list of Office TV 3.5 and older, written before the page loads (the new page deletes it). */
export const oldSavedTvs = (list, selected) => ({
    fn: ([l, s]) => {
        try {
            if (!sessionStorage.getItem('otv.seeded')) {
                localStorage.setItem('officetv.tvs', JSON.stringify(l));
                if (s) localStorage.setItem('officetv.selected', s);
                sessionStorage.setItem('otv.seeded', '1');
            }
        } catch (e) { /* storage blocked in this test */ }
    },
    arg: [list, selected],
});

/** Test-only timeouts for tv/app.js (window.__otvTest). */
export const timeouts = t => ({ fn: x => { window.__otvTest = x; }, arg: t });

/** This machine's first non-internal IPv4 address (the "TV's LAN address" in the receiver URL), or ''. */
export function lanIp() {
    for (const list of Object.values(networkInterfaces())) {
        for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
    return '';
}

/**
 * The plaintext of every message the pages sent to `tv`'s topic (commands and signals): ntfy POSTs in order,
 * then MQTT publishes in order; each has via 'ntfy' | 'mqtt'.
 */
export async function postedTo(tv) {
    const out = [];
    const texts = E.relay.posts.filter(x => x.topic === tv.topic && x.text).map(x => ['ntfy', x.text])
        .concat(mqttTo(tv).map(x => ['mqtt', x.text]));
    for (const [via, text] of texts) {
        const m = await otv.open(tv.key, tv.topic, text);
        if (m) out.push(Object.assign(m, { via }));
    }
    return out;
}

/**
 * New isolated context + page that records console errors. init: function or array of functions /
 * {fn, arg} objects run before the page scripts. relay: the page's __otvRelayConfig (default E.relayConfig:
 * the local broker, or NTFY_ONLY). page.done() closes it and asserts no console errors.
 */
export async function open({ viewport = { width: 1366, height: 768 }, colorScheme = 'light', init = [], mobile = false, relay } = {}) {
    const opts = { viewport, colorScheme, ignoreHTTPSErrors: true };
    if (mobile) Object.assign(opts, { isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
    const ctx = await E.browser.newContext(opts);
    E.contexts.add(ctx);
    await ctx.addInitScript(c => { window.__otvRelayConfig = c; }, relay || E.relayConfig);
    for (const i of [].concat(init)) {
        if (typeof i === 'function') await ctx.addInitScript(i);
        else await ctx.addInitScript(i.fn, i.arg);
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.errors = errors;
    page.ctx = ctx;
    page.done = async (allowed = []) => {
        const bad = errors.filter(t => !allowed.some(re => re.test(t)));
        E.contexts.delete(ctx);
        await ctx.close();
        assert.deepEqual(bad, [], 'console errors');
    };
    return page;
}

/** tv/receive.html for one session, like the TV app builds it (the TV's LAN address as ip=, if known). */
export function receiverPageUrl(tv, session, ip = lanIp()) {
    let url = receiverUrl({ session, code: tv.code, ip }, E.web.url + '/tv/receive.html');
    if (ip && !/[#&]ip=/.test(url)) url += '&ip=' + ip;
    return url;
}

/**
 * Acts like the TV app's CastActivity for `tv`: each 'cast start' opens tv/receive.html (after delayMs, so
 * the offer is already on the relay and must be replayed) and 'cast stop' closes it. init: extra init
 * scripts for the receiver page; ip: the TV's LAN address in the URL (default: this machine's).
 * r.open(session) opens one by hand (for a TV whose ack never arrives).
 */
export function receiverFor(tv, { delayMs = 300, init = [], ip, relay } = {}) {
    const r = { pages: [], closed: 0 };
    r.open = session => {
        const url = receiverPageUrl(tv, session, ip === undefined ? lanIp() : ip);
        (async () => {
            const p = await open({ viewport: { width: 1280, height: 720 }, colorScheme: 'dark', relay, init: [() => {
                window.OfficeTvCast = { close() { window.__closed = (window.__closed || 0) + 1; } };
            }].concat(init) });
            p.session = session;
            await sleep(delayMs);
            await p.goto(url);
            r.pages.push(p);
        })();
    };
    tv.oncast = session => r.open(session);
    tv.oncaststop = session => {
        const p = r.pages.find(x => x.session === session);
        if (p) { r.closed++; p.ctx.close().catch(() => {}); }
    };
    r.last = () => r.pages[r.pages.length - 1];
    r.wait = n => until(() => r.pages.length >= n && r.pages[n - 1], 15000, 'receiver page ' + n);
    return r;
}

/** Resolves with {time, width, ...} once the receiver shows moving video. */
export function receiverPlaying(p) {
    return until(() => p.evaluate(() => {
        const v = document.getElementById('video');
        const s = v.srcObject;
        if (!s || v.paused || v.videoWidth === 0 || v.readyState < 2 || !window.__otvCast || window.__otvCast.state !== 'playing') return null;
        const cs = getComputedStyle(v);
        const r = v.getBoundingClientRect();
        return { time: v.currentTime, width: v.videoWidth, height: v.videoHeight, fit: cs.objectFit,
            render: { imageRendering: cs.imageRendering, transform: cs.transform, filter: cs.filter, position: cs.position },
            box: { left: r.left, top: r.top, width: r.width, height: r.height },
            hash: location.hash, overlay: document.getElementById('status').hidden, tracks: s.getVideoTracks().length };
    }).catch(() => null), 20000, 'video playing on the receiver');
}

/** All user-visible text of the page, including hidden views, placeholders, labels and titles. */
export const pageText = page => page.evaluate(() => {
    const bits = [document.body.innerText, document.title];
    for (const el of document.querySelectorAll('[placeholder],[aria-label],[title]')) {
        bits.push(el.getAttribute('placeholder') || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '');
    }
    for (const el of document.querySelectorAll('[hidden], template')) bits.push(el.textContent);
    return bits.join('\n');
});

async function noHorizontalOverflow(page) {
    return page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const offenders = [];
        for (const el of document.querySelectorAll('body *')) {
            if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
            const r = el.getBoundingClientRect();
            if (r.width && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed' && el.offsetParent !== null) {
                offenders.push(el.tagName + '#' + el.id + '.' + el.className);
            }
        }
        return { scroll: document.documentElement.scrollWidth, width: w, offenders: offenders.slice(0, 5) };
    });
}

/** No horizontal scroll, no overlapping siblings, no clipped text. */
export async function assertLayout(page, what) {
    const o = await noHorizontalOverflow(page);
    const w = page.viewportSize().width;
    assert.ok(o.scroll <= w && o.offenders.length === 0, what + ' overflow: ' + JSON.stringify(o));
    const problems = await page.evaluate(() => {
        const out = [];
        const vis = el => el.offsetParent !== null && !['absolute', 'fixed'].includes(getComputedStyle(el).position);
        for (const box of document.querySelectorAll('.top, .brand, .stage, .hero, .steps, .steps li, .card, .field, form, .tvs, .tv, .tv-txt, .tv-meta, .text-actions, .notice, .notice p, .confirm .row, .live, .live-info, .live-actions, .help-grid, footer, .btn')) {
            const kids = Array.from(box.children).filter(vis);
            for (let a = 0; a < kids.length; a++) {
                for (let b = a + 1; b < kids.length; b++) {
                    const r1 = kids[a].getBoundingClientRect();
                    const r2 = kids[b].getBoundingClientRect();
                    if (!r1.width || !r2.width || !r1.height || !r2.height) continue;
                    const x = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left);
                    const y = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
                    if (x > 1 && y > 1) out.push((box.id || box.className) + ': ' + kids[a].tagName + '#' + kids[a].id + '.' + kids[a].className + ' / ' + kids[b].tagName + '#' + kids[b].id + '.' + kids[b].className);
                }
            }
        }
        // Text wider than its box (clipped) unless it is meant to end with an ellipsis.
        for (const el of document.querySelectorAll('button, .btn, h1, h2, h3, label, p, .tv-name, .chip')) {
            if (el.offsetParent === null) continue;
            const cs = getComputedStyle(el);
            if (cs.textOverflow === 'ellipsis') continue;
            if (el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible') out.push('clipped ' + el.tagName + '#' + el.id + ' ' + el.textContent.trim().slice(0, 30));
        }
        // The main buttons keep their label on one line.
        for (const el of document.querySelectorAll('.btn-big, .btn-stop')) {
            if (el.offsetParent !== null && el.getBoundingClientRect().height > 62) out.push('wrapped button #' + el.id);
        }
        // Tap targets.
        for (const el of document.querySelectorAll('button, input, a')) {
            if (el.offsetParent === null || el.closest('svg')) continue;
            const r = el.getBoundingClientRect();
            if (r.height < 40) out.push('small target ' + el.tagName + '#' + el.id + ' ' + Math.round(r.height) + 'px');
        }
        return out.slice(0, 8);
    });
    assert.deepEqual(problems, [], what + ' layout problems');
}

/** Text of an element, trimmed. */
export const text = (page, sel) => page.$eval(sel, el => el.textContent.trim());
