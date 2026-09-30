// End-to-end "Share my screen": the website (sender) and tv/receive.html (the page the TV app shows) run
// in two Chromium pages. They signal over the local mock relay (standing in for https://ntfy.sh) with real
// encryption, and WebRTC media flows between the pages. The fake TV acks 'cast' and "opens" the receiver
// like CastActivity does. Run: node --test tv-app/tests/web/
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
    CODE_C, HAS_TLS, RECORD_DISPLAY, SHOTS, acquire, assertLayout, open, receiverFor, receiverPlaying, release, reset, savedTvs,
    sleep, text, until,
} from './harness.mjs';

let E;
before(async () => { E = await acquire(); });
after(release);
beforeEach(reset);

const skip = !HAS_TLS && 'openssl missing';
const BOARD = { name: 'Board Room', code: CODE_C, relay: 'https://ntfy.sh' };
const label = page => page.$eval('#liveTitle', el => el.textContent);
/** Relay messages posted to one TV's topic (other tests' stragglers go to other topics). */
const postsTo = tv => E.relay.posts.filter(p => p.topic === tv.topic).length;
const sharing = (page, ms = 30000) => page.waitForFunction(() => /^Sharing to /.test(document.getElementById('liveLabel').textContent)
    && document.getElementById('liveChip').textContent === 'Live', null, { timeout: ms });
const receiverClosed = p => until(() => p.evaluate(() => window.__closed >= 1 && window.__otvCast.state === 'ended').catch(() => false), 10000, 'receiver closed');

test('first visit: one click connects and shares; the TV plays it; Stop sharing ends it', { skip, timeout: 90000 }, async () => {
    const sender = await open({ viewport: { width: 1440, height: 900 }, init: [RECORD_DISPLAY] });
    const rx = receiverFor(E.tvC);
    await sender.goto(E.web.url + '/tv/');
    await sender.fill('#code', 'h7p2k 9r4t1');
    await sender.fill('#tvName', 'Board Room');
    const posts0 = postsTo(E.tvC);
    await sender.click('#connectBtn');

    // The picker opened straight from that click, with the quality options.
    const gdm = await sender.evaluate(() => window.__gdm.calls);
    assert.equal(gdm.length, 1);
    assert.equal(gdm[0].active, true, 'still inside the user gesture');
    assert.deepEqual(gdm[0].options.video, { width: { ideal: 2560, max: 3840 }, height: { ideal: 1440, max: 2160 }, frameRate: { ideal: 30, max: 30 } });
    assert.equal(gdm[0].options.audio, true);
    assert.equal(gdm[0].options.selfBrowserSurface, 'exclude');
    assert.equal(gdm[0].options.surfaceSwitching, 'include');
    assert.equal(gdm[0].options.systemAudio, 'include');

    await sharing(sender);
    const receiver = await rx.wait(1);
    const info = await receiverPlaying(receiver);
    assert.equal(info.tracks, 1);
    assert.ok(info.width > 0 && info.height > 0);
    assert.equal(info.fit, 'contain');
    assert.deepEqual(info.render, { imageRendering: 'auto', transform: 'none', filter: 'none', position: 'fixed' }, 'drawn at full quality');
    assert.deepEqual(info.box, { left: 0, top: 0, width: 1280, height: 720 }, 'full screen');
    assert.equal(info.hash, '', 'pairing code removed from the receiver address bar');
    assert.ok(info.overlay, 'no overlay while playing');
    await sleep(700);
    assert.ok(await receiver.evaluate(() => document.getElementById('video').currentTime) > info.time, 'video keeps playing');

    // Status panel: TV name, running clock, live mini preview.
    const clock = async () => {
        const m = /^Sharing to Board Room · (\d\d):(\d\d):(\d\d)$/.exec(await label(sender));
        assert.ok(m, 'status line: ' + await label(sender));
        return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    };
    const c1 = await clock();
    await sleep(2100);
    assert.ok(await clock() > c1, 'the clock runs');
    assert.equal(await text(sender, '#stopBtn'), 'Stop sharing');
    assert.ok(await sender.isHidden('#hero'), 'the panel takes the page');
    const pv = await until(() => sender.evaluate(() => {
        const v = document.getElementById('preview');
        const live = !!v.srcObject && v.srcObject.getVideoTracks()[0].readyState === 'live';
        return live && v.videoWidth > 0 ? { muted: v.muted } : null;
    }), 5000, 'mini preview');
    assert.equal(pv.muted, true);
    assert.equal(await sender.title(), 'Sharing to Board Room · Office TV');

    // The TV answered, so it is saved.
    assert.deepEqual(await sender.evaluate(() => JSON.parse(localStorage.getItem('officetv.tvs'))), [BOARD]);

    // Quality settings reached the encoder.
    const q = await sender.evaluate(async () => {
        const s = window.__otvCastSender;
        const p = s.videoSender.getParameters();
        return { hint: s.stream.getVideoTracks()[0].contentHint, enc: p.encodings[0], degradation: p.degradationPreference, stats: await s.videoStats() };
    });
    assert.equal(q.hint, 'detail');
    assert.equal(q.enc.maxBitrate, 15000000);
    assert.equal(q.enc.maxFramerate, 30);
    // Full size until the TV reports its screen, then exactly the TV's size (the test TV window is 1280 x 720).
    assert.ok(q.enc.scaleResolutionDownBy === 1 || q.enc.scaleResolutionDownBy === 2, 'scale ' + q.enc.scaleResolutionDownBy);
    assert.equal(q.degradation, 'maintain-resolution');
    await until(() => sender.evaluate(() => window.__otvCastSender.videoSender.getParameters().encodings[0].scaleResolutionDownBy === 2),
        10000, 'picture scaled to the TV screen (2560 x 1440 -> 1280 x 720)');
    console.log('# video: ' + JSON.stringify(q.stats) + ', display source: ' + await sender.evaluate(() => window.__gdm.source));

    // Relay cost: the cast command, the offer and the answer (+ the TV's ack, which the fake TV publishes directly).
    { const n = postsTo(E.tvC) - posts0; assert.ok(n >= 3 && n <= 4, 'relay messages posted (the plain offer may take 2 parts): ' + n); }
    assert.equal(E.tvC.received('cast').length, 1);
    assert.equal(E.tvC.received('ping').length, 0, 'the first visit needs no ping');
    const cmd = E.tvC.received('cast')[0];
    assert.equal(cmd.args.action, 'start');
    assert.match(cmd.args.session, /^[a-z0-9]{16}$/);
    // Envelopes are base64url, so plaintext SDP markers (which contain '=' and ':') can never appear by chance.
    for (const p of E.relay.posts) if (p.text) assert.ok(/^otv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(p.text) && !/a=candidate:|v=0/.test(p.text), 'only ciphertext on the relay');
    await assertLayout(sender, '1440 sharing');
    await sender.screenshot({ path: join(SHOTS, 'sharing-1440-light.png') });
    await receiver.screenshot({ path: join(SHOTS, 'receiver-tv.png') });

    // Stop: the TV hears it over the data channel (no relay message) and closes the receiver.
    const before = postsTo(E.tvC);
    await sender.click('#stopBtn');
    await sender.waitForSelector('#homeCard', { state: 'visible', timeout: 5000 });
    assert.equal(await text(sender, '#noticeTitle'), 'Sharing stopped.');
    assert.equal(await text(sender, '#shareLabel'), 'Share again');
    await receiverClosed(receiver);
    assert.equal(postsTo(E.tvC), before, 'stopping used no relay messages');
    assert.equal(await sender.evaluate(() => window.__gdm.stream.getTracks().every(t => t.readyState === 'ended')), true, 'capture released');
    assert.equal(await sender.title(), 'Office TV · Share your laptop screen');
    await until(() => E.relay.sseCount(E.tvC.topic) === 0, 5000, 'relay streams closed');
    await receiver.done();
    await sender.done();
});

test('connection info: codec and resolution from getStats; the TV\'s numbers arrive over the data channel, not the relay', { skip, timeout: 90000 }, async () => {
    const sender = await open({ viewport: { width: 1366, height: 768 }, init: [RECORD_DISPLAY, savedTvs([BOARD], CODE_C)] });
    const rx = receiverFor(E.tvC);
    await sender.goto(E.web.url + '/tv/');
    await sender.click('#shareBtn');
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    const posts = postsTo(E.tvC);

    // One quiet line while sharing, details folded away.
    assert.ok(await sender.isVisible('#connInfo'));
    assert.equal(await text(sender, '#connToggle'), 'Connection info');
    assert.equal(await sender.getAttribute('#connToggle', 'aria-expanded'), 'false');
    assert.ok(await sender.isHidden('#connDetails'));

    // The TV sends its numbers every 2 s over the WebRTC data channel.
    await until(() => sender.evaluate(() => window.__otvCastSender.rxStatsCount >= 2), 15000, 'two stats messages from the TV');
    const verdict = await until(async () => { const t = await text(sender, '#connText'); return /delay$/.test(t) && t; }, 8000, 'verdict with the delay');
    assert.match(verdict, /^Direct connection · (VP8|H\.264)[\w .]* · ~\d+ ms delay$/);

    await sender.click('#connToggle');
    assert.equal(await sender.getAttribute('#connToggle', 'aria-expanded'), 'true');
    assert.ok(await sender.isVisible('#connDetails'));
    const row = k => text(sender, '#connRows [data-k="' + k + '"] dd');
    await until(async () => /bps/.test(await row('bitrate')) && /fps decoded/.test(await row('tvfps')), 8000, 'details filled in');
    assert.match(await row('codec'), /^(VP8 \(video\/VP8\)|H\.264 \(video\/H264\))$/);
    await until(async () => /^1280 x 720 \(captured 2560 x 1440\)$/.test(await row('res')), 8000,
        'sent at the TV screen size (1280 x 720 window), captured at full size');
    assert.match(await row('fps'), /^\d+ fps$/);
    assert.match(await row('bitrate'), /^[\d.]+ [Mk]bps/);
    assert.match(await row('encoder'), / · (hardware|software)$/, 'the capturing laptop names its encoder');
    assert.match(await row('limit'), /^(Nothing|The laptop's processor|Network bandwidth|Other)$/);
    assert.match(await row('rtt'), /^\d+ ms$/);
    assert.equal(await row('path'), 'Direct, same network (host / host, UDP)');
    assert.match(await row('tvfps'), /^\d+ fps decoded$/);
    assert.match(await row('tvdrop'), /^\d+ \([\d.]+%\)$/);
    assert.match(await row('tvdecoder'), /hardware|software/, 'from getStats or the web engine\'s media capabilities');
    assert.match(await row('tvjitter'), /^\d+ ms per frame$/);
    assert.match(await row('tvdecode'), /^\d+ ms per frame$/);
    assert.equal(await row('tvscreen'), '1280 x 720 pixels');
    assert.match(await row('delay'), /^~\d+ ms \(laptop \d+ \+ network \d+ \+ TV \d+ ms/);

    // What the TV sent; none of it used the relay.
    const tvSide = await receiver.evaluate(() => ({ sent: window.__otvCast.statsSent, last: window.__otvCast.lastStats }));
    assert.ok(tvSide.sent >= 2);
    const m = JSON.parse(tvSide.last);
    assert.equal(m.type, 'stats');
    for (const k of ['fps', 'framesDropped', 'jitterMs', 'decodeMs', 'tvMs', 'delayMs']) assert.equal(typeof m[k], 'number', k + ' in ' + tvSide.last);
    assert.ok(tvSide.last.length < 600, 'compact: ' + tvSide.last.length + ' bytes');
    assert.equal(postsTo(E.tvC), posts, 'stats never go over the relay');
    console.log('# connection info: ' + verdict + ' | hints: ' + JSON.stringify(await sender.$$eval('#connHints li', l => l.map(x => x.textContent))));
    console.log('# TV stats message: ' + tvSide.last);

    assert.equal(await sender.evaluate(() => localStorage.getItem('officetv.info')), '1', 'the open panel is remembered');
    await assertLayout(sender, '1366 sharing, connection info open');
    await sender.screenshot({ path: join(SHOTS, 'connection-info-1366.png'), fullPage: true });
    await sender.setViewportSize({ width: 390, height: 844 });
    await assertLayout(sender, '390 sharing, connection info open');
    await sender.screenshot({ path: join(SHOTS, 'connection-info-390.png'), fullPage: true });
    await sender.click('#connToggle');
    assert.ok(await sender.isHidden('#connDetails'));
    assert.equal(await sender.getAttribute('#connToggle', 'aria-expanded'), 'false');

    await sender.click('#stopBtn');
    await receiverClosed(receiver);
    assert.ok(await sender.isHidden('#connInfo'), 'only while sharing');
    await receiver.done();
    await sender.done();
});

test('returning visitor: one ping on load, one-click share on one relay stream; the browser\'s own Stop ends it', { skip, timeout: 90000 }, async () => {
    const sender = await open({ init: [RECORD_DISPLAY, savedTvs([BOARD], CODE_C)] });
    const rx = receiverFor(E.tvC);
    await sender.goto(E.web.url + '/tv/');
    await sender.waitForFunction(() => /Online/.test(document.querySelector('.tv .tv-status').textContent), null, { timeout: 10000 });
    assert.equal(await text(sender, '#shareBtn'), 'Share my screen');
    await until(() => E.relay.sseCount(E.tvC.topic) === 0, 3000, 'idle stream closed after the ping');
    assert.equal(E.tvC.received('ping').length, 1);

    await sender.click('#shareBtn');
    assert.equal(await sender.evaluate(() => window.__gdm.calls[0].active), true);
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    assert.equal(E.relay.sseCount(E.tvC.topic), 2, 'one stream for the laptop (acks and signals share it) + one for the TV page');

    // The browser's own "Stop sharing" bar ends the capture track.
    await sender.evaluate(() => window.__otvCastSender.stream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
    await sender.waitForSelector('#homeCard', { state: 'visible', timeout: 5000 });
    assert.equal(await text(sender, '#noticeTitle'), 'Sharing stopped.');
    await receiverClosed(receiver);
    assert.equal(E.tvC.received('ping').length, 1, 'no polling');
    await receiver.done();
    await sender.done();
});

test('the TV closes the receiver: "The TV stopped showing your screen." and Share again works', { skip, timeout: 90000 }, async () => {
    const sender = await open({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark', init: [RECORD_DISPLAY, savedTvs([BOARD], CODE_C)] });
    const rx = receiverFor(E.tvC);
    await sender.goto(E.web.url + '/tv/');
    await sender.click('#shareBtn');
    await sharing(sender);
    const first = await rx.wait(1);
    await receiverPlaying(first);
    await assertLayout(sender, '1366 dark sharing');
    await sender.screenshot({ path: join(SHOTS, 'sharing-1366-dark.png') });

    // Back on the TV remote: CastActivity tears the page down, which closes the peer connection.
    await first.goto('about:blank');
    await sender.waitForSelector('#homeCard', { state: 'visible', timeout: 10000 });
    assert.equal(await text(sender, '#noticeTitle'), 'The TV stopped showing your screen.');
    assert.equal(await sender.getAttribute('#notice', 'class'), 'notice bad');
    assert.equal(await text(sender, '#shareLabel'), 'Share again');
    assert.equal(await sender.evaluate(() => document.activeElement.id), 'shareBtn');
    await assertLayout(sender, '1366 dark ended');
    await sender.screenshot({ path: join(SHOTS, 'tv-stopped-1366-dark.png') });

    await sender.click('#shareBtn');
    await sharing(sender);
    const second = await rx.wait(2);
    await receiverPlaying(second);
    assert.equal(E.tvC.received('cast').length, 2);
    await sender.click('#stopBtn');
    await receiverClosed(second);
    await first.done();
    await second.done();
    await sender.done();
});

test('the TV vanishes without a goodbye (power cut): one reconnect attempt, then a clear message', { skip, timeout: 90000 }, async () => {
    const fast = () => { window.__otvTest = { dropMs: 500, reconnectTimeoutMs: 2500 }; };
    const sender = await open({ init: [RECORD_DISPLAY, fast, savedTvs([BOARD], CODE_C)] });
    const rx = receiverFor(E.tvC);
    await sender.goto(E.web.url + '/tv/');
    await sender.click('#shareBtn');
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    const before = postsTo(E.tvC);
    await receiver.ctx.close(); // the renderer is gone: no data channel close, only silence
    await sender.waitForFunction(() => document.getElementById('liveChip').textContent === 'Reconnecting', null, { timeout: 20000 });
    assert.match(await text(sender, '#liveLabel'), /^Reconnecting to Board Room/);
    await sender.waitForSelector('#homeCard', { state: 'visible', timeout: 20000 });
    assert.equal(await text(sender, '#noticeTitle'), 'The connection to the TV was lost.');
    assert.equal(await text(sender, '#noticeText'), 'Check the Wi-Fi, then share again.');
    assert.equal(await text(sender, '#shareLabel'), 'Share again');
    { const n = postsTo(E.tvC) - before; assert.ok(n >= 1 && n <= 2, 'one restart offer (1-2 parts), never answered: ' + n); }
    await sender.done();
});

test('reconnects once after a drop: ICE restart on the same session, two relay messages, the TV keeps playing', { skip, timeout: 90000 }, async () => {
    const sender = await open({ init: [RECORD_DISPLAY, savedTvs([BOARD], CODE_C)] });
    const rx = receiverFor(E.tvC);
    await sender.goto(E.web.url + '/tv/');
    await sender.click('#shareBtn');
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    const before = postsTo(E.tvC);
    const firstOffer = await receiver.evaluate(() => window.__otvCast._lastOffer);
    const states = sender.evaluate(() => new Promise(resolve => {
        const s = window.__otvCastSender;
        const seen = [];
        const prev = s.onstate;
        s.onstate = (st, d) => { seen.push(st); prev(st, d); if (st === 'sharing') resolve(seen); };
        s.reconnect();
    }));
    assert.deepEqual(await states, ['reconnecting', 'sharing']);
    assert.equal(await sender.evaluate(() => window.__otvCastSender.reconnects), 1);
    assert.notEqual(await receiver.evaluate(() => window.__otvCast._lastOffer), firstOffer, 'the TV got the restart offer');
    { const n = postsTo(E.tvC) - before; assert.ok(n >= 2 && n <= 3, 'offer (1-2 parts) + answer: ' + n); }
    const t = await receiver.evaluate(() => document.getElementById('video').currentTime);
    await sleep(600);
    assert.ok(await receiver.evaluate(() => document.getElementById('video').currentTime) > t, 'still playing');
    assert.equal(await sender.evaluate(() => window.__otvCastSender.reconnect()), false, 'only once per session');
    await sender.click('#stopBtn');
    await receiverClosed(receiver);
    await receiver.done();
    await sender.done();
});

test('receiver page without parameters explains itself', async () => {
    const page = await open();
    await page.goto(E.web.url + '/tv/receive.html');
    assert.equal(await text(page, '#statusText'), 'This page shows a laptop screen on an office TV.');
    assert.match(await text(page, '#statusSub'), /open nikhildiwakar-bit\.github\.io\/Portfolio\/tv on a laptop/);
    await page.done();
});

test('phone: the TV\'s QR opens the phone page; one tap, the phone allows capture, its screen plays on the TV (no app)', { skip, timeout: 90000 }, async () => {
    const phone = await open({ viewport: { width: 390, height: 800 }, mobile: true, init: [RECORD_DISPLAY] });
    const rx = receiverFor(E.tvC);
    const key = 'A'.repeat(43);
    await phone.goto(E.web.url + '/tv/phone.html#h=192.168.1.20&p=47300&k=' + key + '&n=Board%20Room&c=' + CODE_C);
    assert.ok(await phone.isVisible('#web'), 'browser sharing offered');
    assert.ok(await phone.isHidden('#open'), 'the app is not opened by itself');
    assert.equal(await phone.evaluate(() => location.hash), '', 'TV details removed from the address bar');
    assert.match(await text(phone, '#web h1'), /Board Room/);
    await phone.click('#webBtn');
    assert.equal((await phone.evaluate(() => window.__gdm.calls)).length, 1);
    await until(async () => /showing on Board Room/.test(await text(phone, '#webStatus')), 30000, 'phone says it is sharing');
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    assert.equal(await text(phone, '#webBtn'), 'Stop sharing');
    await assertLayout(phone, 'phone page 390');
    await phone.screenshot({ path: join(SHOTS, 'phone-web-sharing.png'), fullPage: true });
    await phone.click('#webBtn');
    await until(async () => /^Sharing stopped/.test(await text(phone, '#webStatus')), 10000, 'stopped');
    await receiverClosed(receiver);
});
