// Shared setup for the browser tests: one Chromium (with a fake screen picker), the local mock relay
// standing in for https://ntfy.sh (real encryption end to end), the static site, and fake TVs that ack
// 'ping' and 'cast' like the Office TV app. receiverFor(tv) opens tv/receive.html for each 'cast start',
// like CastActivity does, and closes it on 'cast stop'. Screenshots go to $OTV_SHOTS (default: <tmp>/officetv-shots).
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelay } from './mock-relay.mjs';
import { makeCert, startRelayServers, startStatic } from './servers.mjs';
import { createFakeTv } from '../node/fake-tv.mjs';
import { receiverUrl } from '../../../tv/cast.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../..');
export const SHOTS = process.env.OTV_SHOTS || join(tmpdir(), 'officetv-shots');
export const CODE_A = '7K3M9QX2TD';   // "Conference Room", answers
export const CODE_B = 'Q4W8Z2M6N0';   // "Reception", never answers (switched off)
export const CODE_C = 'H7P2K9R4T1';   // "Board Room", answers; used for real screen sharing
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
    // The TV publishes its acks with cache=no, so they are never replayed.
    const publish = (t, env) => relay.publish(t, env, undefined, { cache: false });
    const tvA = await createFakeTv({ code: CODE_A, name: 'Conference Room', publish });
    const tvB = await createFakeTv({ code: CODE_B, name: 'Reception', publish, silent: true });
    const tvC = await createFakeTv({ code: CODE_C, name: 'Board Room', publish });
    for (const tv of [tvA, tvB, tvC]) relay.subscribe(tv.topic, ev => tv.handle(ev));
    // Keep the sandbox proxy away from Chromium; map ntfy.sh to the local HTTPS mock relay.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
    const args = ['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'];
    if (tls) args.push('--host-resolver-rules=MAP ntfy.sh 127.0.0.1:' + relaySrv.httpsPort);
    const browser = await chromium.launch({ env, args });
    return { browser, relay, relaySrv, web, tvA, tvB, tvC, tvs: [tvA, tvB, tvC], contexts: new Set() };
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
    await e.web.close();
}

/** Resets TVs and relay counters between tests and closes pages a failed test left open. */
export async function reset() {
    for (const c of Array.from(E.contexts)) await c.close().catch(() => {});
    E.contexts.clear();
    for (const tv of E.tvs) tv.reset();
    E.relay.rateLimit = false;
    E.relay.errors.length = 0;
    E.relay.requests.length = 0;
    E.relay.posts.length = 0;
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
 */
export const RECORD_DISPLAY = () => {
    const md = navigator.mediaDevices;
    window.__gdm = { calls: [], source: '' };
    if (!md || !md.getDisplayMedia) return;
    const real = md.getDisplayMedia.bind(md);
    md.getDisplayMedia = async function (options) {
        window.__gdm.calls.push({ options: JSON.parse(JSON.stringify(options || {})), active: !!(navigator.userActivation && navigator.userActivation.isActive) });
        let stream;
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

/** Saved TVs for a returning visitor, written before the page loads. */
export const savedTvs = (list, selected) => ({
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

/**
 * New isolated context + page that records console errors. init: function or array of functions /
 * {fn, arg} objects run before the page scripts. page.done() closes it and asserts no console errors.
 */
export async function open({ viewport = { width: 1366, height: 768 }, colorScheme = 'light', init = [], mobile = false } = {}) {
    const opts = { viewport, colorScheme, ignoreHTTPSErrors: true };
    if (mobile) Object.assign(opts, { isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
    const ctx = await E.browser.newContext(opts);
    E.contexts.add(ctx);
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

/**
 * Acts like the TV app's CastActivity for `tv`: each 'cast start' opens tv/receive.html (after delayMs, so
 * the offer is already on the relay and must be replayed) and 'cast stop' closes it.
 */
export function receiverFor(tv, { delayMs = 300 } = {}) {
    const r = { pages: [], closed: 0 };
    tv.oncast = session => {
        const url = receiverUrl({ session, code: tv.code }, E.web.url + '/tv/receive.html');
        (async () => {
            const p = await open({ viewport: { width: 1280, height: 720 }, colorScheme: 'dark', init: () => {
                window.OfficeTvCast = { close() { window.__closed = (window.__closed || 0) + 1; } };
            } });
            p.session = session;
            await sleep(delayMs);
            await p.goto(url);
            r.pages.push(p);
        })();
    };
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
        return { time: v.currentTime, width: v.videoWidth, height: v.videoHeight, fit: getComputedStyle(v).objectFit,
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
