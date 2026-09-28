// End-to-end test for "Share my screen": the controller page (sender) and tv/receive.html (the page the
// TV app shows) run in two Chromium pages. They signal over the local mock relay (standing in for
// https://ntfy.sh) with real encryption, and WebRTC media flows between the pages. A fake TV acks the
// 'cast' command and "opens" the receiver page like CastActivity does. Run: node --test tv-app/tests/web/
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelay } from './mock-relay.mjs';
import { makeCert, startRelayServers, startStatic } from './servers.mjs';
import { createFakeTv } from '../node/fake-tv.mjs';
import { receiverUrl } from '../../../tv/cast.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const CODE = 'H7P2K9R4T1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch (e) {
        const root = execSync('npm root -g').toString().trim();
        return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
    }
}

async function until(fn, ms, what) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out waiting for ' + what);
        await sleep(50);
    }
}

// If headless Chromium cannot fake getDisplayMedia, fall back to an animated canvas + a tone.
const FAKE_DISPLAY = () => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const real = md.getDisplayMedia ? md.getDisplayMedia.bind(md) : null;
    md.getDisplayMedia = async constraints => {
        if (real) {
            try {
                const s = await real(constraints);
                window.__displaySource = 'getDisplayMedia';
                return s;
            } catch (e) { /* use the canvas */ }
        }
        window.__displaySource = 'canvas';
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 360;
        const g = c.getContext('2d');
        let n = 0;
        setInterval(() => {
            g.fillStyle = 'hsl(' + (n++ * 7 % 360) + ',70%,50%)';
            g.fillRect(0, 0, 640, 360);
            g.fillStyle = '#fff';
            g.font = '48px sans-serif';
            g.fillText('Slide ' + n, 40, 120);
        }, 33);
        const stream = c.captureStream(30);
        try {
            const ac = new AudioContext();
            const osc = ac.createOscillator();
            const dst = ac.createMediaStreamDestination();
            osc.connect(dst);
            osc.start();
            stream.addTrack(dst.stream.getAudioTracks()[0]);
        } catch (e) { /* video only */ }
        return stream;
    };
};

let browser, relay, relaySrv, web, tv, tls;

before(async () => {
    const { chromium } = await loadPlaywright();
    relay = createRelay();
    tls = makeCert('ntfy.sh');
    relaySrv = await startRelayServers(relay, { tls });
    web = await startStatic(REPO);
    tv = await createFakeTv({ code: CODE, name: 'Board Room', publish: (t, env) => relay.publish(t, env, undefined, { cache: false }) });
    relay.subscribe(tv.topic, ev => tv.handle(ev));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
    const args = ['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'];
    if (tls) args.push('--host-resolver-rules=MAP ntfy.sh 127.0.0.1:' + relaySrv.httpsPort);
    browser = await chromium.launch({ env, args });
});

after(async () => {
    if (browser) await browser.close();
    if (relaySrv) await relaySrv.close();
    if (web) await web.close();
});

async function newPage(init) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
    page.ctx = ctx;
    return page;
}

test('laptop screen plays on the receiver page and stops cleanly', { skip: !makeCert() && 'openssl missing' }, async () => {
    const sender = await newPage(FAKE_DISPLAY);
    let receiver = null;
    let receiverUrlSeen = null;
    tv.oncast = session => {
        // What CastActivity does: open the receiver with the session and pairing code in the fragment.
        const u = receiverUrl({ session, code: CODE }, web.url + '/tv/receive.html');
        receiverUrlSeen = u;
        newPage(() => { window.OfficeTvCast = { close() { window.__closed = (window.__closed || 0) + 1; } }; })
            .then(async p => {
                // Load a little later so the offer is already on the relay (the receiver must replay it).
                await sleep(400);
                await p.goto(u);
                receiver = p;
            });
    };

    await sender.goto(web.url + '/tv/#pair=' + CODE + '&name=' + encodeURIComponent('Board Room'));
    await sender.waitForFunction(() => /Board Room is connected/.test(document.getElementById('toastText').textContent), null, { timeout: 10000 });
    assert.ok(await sender.isVisible('#castBtn'), 'Share my screen is visible for one TV');
    const postsBefore = relay.posts.length;

    await sender.click('#castBtn');
    await sender.waitForFunction(() => /Sharing/.test(document.getElementById('castState').textContent), null, { timeout: 30000 });
    assert.ok(await sender.isVisible('#castStop'));
    await until(() => receiver, 10000, 'receiver page');

    const info = await until(() => receiver.evaluate(() => {
        const v = document.getElementById('video');
        const s = v.srcObject;
        if (!s || v.paused || v.videoWidth === 0 || v.readyState < 2) return null;
        return {
            videoTracks: s.getVideoTracks().filter(t => t.readyState === 'live').length,
            audioTracks: s.getAudioTracks().length,
            width: v.videoWidth, height: v.videoHeight, time: v.currentTime, fit: getComputedStyle(v).objectFit,
            state: window.__otvCast.state, hash: location.hash, status: document.getElementById('status').hidden,
        };
    }), 20000, 'playing video on the receiver');
    assert.equal(info.videoTracks, 1);
    assert.ok(info.width > 0 && info.height > 0);
    assert.equal(info.fit, 'contain');
    assert.equal(info.state, 'playing');
    assert.equal(info.hash, '', 'pairing code removed from the address bar');
    assert.ok(info.status, 'status overlay hidden while playing');
    await sleep(700);
    const t2 = await receiver.evaluate(() => document.getElementById('video').currentTime);
    assert.ok(t2 > info.time, 'video keeps playing');
    assert.ok(receiverUrlSeen.includes('#s='));

    // Signaling cost: cast command + ack + one offer + one answer.
    const castPosts = relay.posts.length - postsBefore;
    assert.ok(castPosts <= 4, 'relay messages used: ' + castPosts);
    const cmd = tv.received('cast').slice(-1)[0];
    assert.equal(cmd.args.action, 'start');
    assert.match(cmd.args.session, /^[a-z0-9]{16}$/);
    // Nothing on the relay is readable: SDP and candidates are inside the encrypted envelopes.
    for (const p of relay.posts) if (p.text) assert.ok(p.text.startsWith('otv1.') && !/candidate|sdp/i.test(p.text));

    // Stop sharing: the receiver learns it over the data channel (no relay message) and closes itself.
    const before = relay.posts.length;
    await sender.click('#castStop');
    await sender.waitForFunction(() => /Stopped/.test(document.getElementById('castState').textContent), null, { timeout: 5000 });
    await until(() => receiver.evaluate(() => window.__closed === 1 && window.__otvCast.state === 'ended'), 10000, 'receiver closed');
    assert.equal(relay.posts.length, before, 'stop used no relay messages');
    assert.ok(await sender.isHidden('#castStop'));
    console.log('# display source: ' + await sender.evaluate(() => window.__displaySource));

    // The browser's own "Stop sharing" (track ended) also stops.
    let receiver2 = null;
    tv.oncast = session => {
        newPage(() => { window.OfficeTvCast = { close() { window.__closed = 1; } }; }).then(async p => {
            await p.goto(receiverUrl({ session, code: CODE }, web.url + '/tv/receive.html'));
            receiver2 = p;
        });
    };
    await sender.click('#castBtn');
    await sender.waitForFunction(() => /Sharing/.test(document.getElementById('castState').textContent), null, { timeout: 30000 });
    await until(() => receiver2, 10000, 'second receiver');
    await sender.evaluate(() => window.__otvCastSender.stream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
    await sender.waitForFunction(() => /Stopped/.test(document.getElementById('castState').textContent), null, { timeout: 5000 });
    await until(() => receiver2.evaluate(() => window.__closed === 1), 10000, 'second receiver closed');

    assert.deepEqual(sender.errors, []);
    assert.deepEqual(receiver.errors, []);
    tv.oncast = null;
    await receiver.ctx.close();
    await receiver2.ctx.close();
    await sender.ctx.close();
});

test('unsupported browsers get a clear explanation', async () => {
    const page = await newPage(() => {
        if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = undefined;
    });
    await page.goto(web.url + '/tv/#pair=' + CODE + '&name=' + encodeURIComponent('Board Room'));
    await page.waitForFunction(() => /Board Room is connected/.test(document.getElementById('toastText').textContent), null, { timeout: 10000 });
    const starts = tv.received('cast').length;
    await page.click('#castBtn');
    const text = await page.textContent('#castText');
    assert.match(text, /cannot share its screen/);
    assert.match(text, /Phones and tablets/);
    assert.equal(await page.textContent('#castState'), 'Error.');
    assert.equal(tv.received('cast').length, starts, 'no cast command sent');
    await page.ctx.close();
});

test('receiver page without parameters explains itself', async () => {
    const page = await newPage();
    await page.goto(web.url + '/tv/receive.html');
    assert.match(await page.textContent('#statusText'), /shows a laptop screen/);
    await page.ctx.close();
});
