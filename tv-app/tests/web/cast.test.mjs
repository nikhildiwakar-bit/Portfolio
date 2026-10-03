// End-to-end "Share screen": the website (sender) and tv/receive.html (the page the TV app shows) run in two
// Chromium pages. They signal over a local MQTT broker (standing in for the public ones) and the local mock relay
// (standing in for https://ntfy.sh) with real encryption, and WebRTC media flows between the pages. The fake TV
// acks 'cast' and "opens" the receiver like CastActivity does. Run: node --test tv-app/tests/web/
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
    CODE_C, CODE_OLD, HAS_TLS, NTFY_ONLY, RECORD_DISPLAY, SHOTS, STILL_DISPLAY, acquire, assertLayout, lanIp, mqttTo, open, postedTo,
    receiverFor, receiverPlaying, release, reset, sentTo, sleep, text, timeouts, until,
} from './harness.mjs';
import * as otv from '../../../tv/otv.js';
import { sameNetworkAddress, withLanCandidates } from '../../../tv/cast.js';

let E;
before(async () => { E = await acquire(); });
after(release);
beforeEach(reset);

const skip = !HAS_TLS && 'openssl missing';
const label = page => page.$eval('#liveTitle', el => el.textContent);
/** ntfy messages posted to one TV's topic (other tests' stragglers go to other topics); sentTo() adds MQTT. */
const postsTo = tv => E.relay.posts.filter(p => p.topic === tv.topic).length;
const sharing = (page, ms = 30000) => page.waitForFunction(() => /^Sharing to /.test(document.getElementById('liveLabel').textContent)
    && document.getElementById('liveChip').textContent === 'Live', null, { timeout: ms });
const receiverClosed = p => until(() => p.evaluate(() => window.__closed >= 1 && window.__otvCast.state === 'ended').catch(() => false), 10000, 'receiver closed');
const SOUND_TEXTS = [
    'Sound plays on the TV only.',
    'Sound plays on the TV. Lower the laptop volume if you hear the sound twice.',
    'No sound is shared. To play sound on the TV, stop and share a Chrome tab with “Also share tab audio” on.',
];

/** Opens the site and shares to `code` (typed, then Enter or the button). */
async function shareTo(page, code, { enter = false } = {}) {
    await page.goto(E.web.url + '/tv/');
    await page.fill('#code', code);
    if (enter) await page.press('#code', 'Enter');
    else await page.click('#shareBtn');
}

/** Frames per second over `ms`: framesSent of the outgoing video (sender) or framesDecoded (receiver). */
const measureFps = (page, side, ms = 3000) => page.evaluate(async ([side, ms]) => {
    const pc = side === 'tx' ? window.__otvCastSender.pc : window.__otvCast.pc;
    const count = async () => {
        let n = 0;
        (await pc.getStats()).forEach(r => {
            if (side === 'tx' && r.type === 'outbound-rtp' && r.kind === 'video') n += r.framesSent || 0;
            if (side === 'rx' && r.type === 'inbound-rtp' && r.kind === 'video') n += r.framesDecoded || 0;
        });
        return n;
    };
    const a = await count();
    const t = performance.now();
    await new Promise(r => setTimeout(r, ms));
    return (await count() - a) / ((performance.now() - t) / 1000);
}, [side, ms]);

test('a 4-digit code: one click shares with TV-only sound; the TV plays a steady picture; Stop, then Share again', { skip, timeout: 120000 }, async () => {
    const sender = await open({ viewport: { width: 1440, height: 900 }, init: [RECORD_DISPLAY] });
    const rx = receiverFor(E.tvC);
    const t0 = Date.now();
    await shareTo(sender, CODE_C);

    // The picker opened straight from that click, with the quality options and the sound on the TV only.
    const gdm = await sender.evaluate(() => window.__gdm.calls);
    assert.ok(gdm.length >= 1);
    assert.equal(gdm[0].active, true, 'still inside the user gesture');
    assert.deepEqual(gdm[0].options.video, { width: { ideal: 2560, max: 3840 }, height: { ideal: 1440, max: 2160 }, frameRate: { ideal: 30, max: 30 } });
    assert.deepEqual(gdm[0].options.audio, { suppressLocalAudioPlayback: true }, 'a shared tab is silent on the laptop');
    assert.equal(gdm[0].options.selfBrowserSurface, 'exclude');
    assert.equal(gdm[0].options.surfaceSwitching, 'include');
    assert.equal(gdm[0].options.systemAudio, 'include');

    await sharing(sender);
    const connectMs = Date.now() - t0;
    console.log('# page load + click to sharing: ' + connectMs + ' ms (the TV page opens 300 ms after the cast command)');
    assert.ok(connectMs < 10000, 'connected in ' + connectMs + ' ms');
    const receiver = await rx.wait(1);
    const info = await receiverPlaying(receiver);
    assert.equal(info.tracks, 1);
    assert.ok(info.width > 0 && info.height > 0);
    assert.equal(info.fit, 'contain');
    assert.deepEqual(info.render, { imageRendering: 'auto', transform: 'none', filter: 'none', position: 'fixed' }, 'drawn at full quality');
    assert.deepEqual(info.box, { left: 0, top: 0, width: 1280, height: 720 }, 'full screen');
    assert.equal(info.hash, '', 'the TV code is removed from the receiver address bar');
    assert.ok(info.overlay, 'no overlay while playing');
    await sleep(700);
    assert.ok(await receiver.evaluate(() => document.getElementById('video').currentTime) > info.time, 'video keeps playing');

    // Status panel: TV name (from the TV's ack), running clock, live mini preview, where the sound plays.
    const clock = async () => {
        const m = /^Sharing to Board Room · (\d\d):(\d\d):(\d\d)$/.exec(await label(sender));
        assert.ok(m, 'status line: ' + await label(sender));
        return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    };
    const c1 = await until(async () => /Board Room/.test(await label(sender)) && clock(), 5000, 'the TV name');
    await sleep(2100);
    assert.ok(await clock() > c1, 'the clock runs');
    assert.equal(await text(sender, '#stopBtn'), 'Stop sharing');
    assert.ok(await sender.isHidden('#homeCard'), 'the panel takes the page');
    const pv = await until(() => sender.evaluate(() => {
        const v = document.getElementById('preview');
        const live = !!v.srcObject && v.srcObject.getVideoTracks()[0].readyState === 'live';
        return live && v.videoWidth > 0 ? { muted: v.muted } : null;
    }), 5000, 'mini preview');
    assert.equal(pv.muted, true);
    assert.equal(await sender.title(), 'Sharing to Board Room · Office TV');
    assert.ok(await sender.isVisible('#soundNote'));
    const sound = await text(sender, '#soundText');
    assert.ok(SOUND_TEXTS.includes(sound), 'sound status: ' + sound);
    assert.equal(await sender.$$eval('#soundToggle, [data-sound]', l => l.length), 0, 'no sound toggle');

    // Quality settings reached the encoder, through the steady track (at least 30 frames per second).
    const q = await sender.evaluate(async () => {
        const s = window.__otvCastSender;
        const p = s.videoSender.getParameters();
        const sent = s.videoSender.track;
        return {
            hint: s.stream.getVideoTracks()[0].contentHint, sentHint: sent.contentHint, steady: !!s.steady,
            wrapped: sent !== s.stream.getVideoTracks()[0], sentLive: sent.readyState,
            tick: performance.getEntriesByType('resource').some(e => /\/tv\/tick\.js/.test(e.name)),
            enc: p.encodings[0], degradation: p.degradationPreference, stats: await s.videoStats(),
        };
    });
    assert.equal(q.hint, 'detail');
    assert.equal(q.steady, true, 'steady frame rate on (MediaStreamTrackProcessor + Generator)');
    assert.equal(q.wrapped, true, 'the encoder gets the steady track');
    assert.equal(q.sentHint, 'detail', 'same content hint on the steady track');
    assert.equal(q.sentLive, 'live');
    assert.equal(q.tick, true, 'the tick worker runs (tv/tick.js)');
    assert.equal(q.enc.maxBitrate, 15000000);
    assert.equal(q.enc.maxFramerate, 30);
    assert.ok(q.enc.scaleResolutionDownBy === 1 || q.enc.scaleResolutionDownBy === 2, 'scale ' + q.enc.scaleResolutionDownBy);
    assert.equal(q.degradation, 'maintain-resolution');
    await until(() => sender.evaluate(() => window.__otvCastSender.videoSender.getParameters().encodings[0].scaleResolutionDownBy === 2),
        10000, 'picture scaled to the TV screen (2560 x 1440 -> 1280 x 720)');
    console.log('# video: ' + JSON.stringify(q.stats) + ', display source: ' + await sender.evaluate(() => window.__gdm.source) + ', sound: ' + sound);

    // Relay: only ciphertext, and all of it over MQTT (no daily quota): the command, the offer (before the ack,
    // again for the TV page's 'ready'), the page's 'ready' and its answer. Not one ntfy message.
    assert.equal(postsTo(E.tvC), 0, 'no ntfy message while a broker is connected');
    const n = mqttTo(E.tvC).length;
    assert.ok(n >= 4 && n <= 20, 'MQTT messages: ' + n);
    assert.equal(E.tvC.received('cast').length, 1);
    assert.deepEqual(E.tvC.vias, ['mqtt'], 'the TV got the command over MQTT');
    assert.equal(E.tvC.received('ping').length, 0, 'no ping');
    const cmd = E.tvC.received('cast')[0];
    assert.equal(cmd.args.action, 'start');
    assert.match(cmd.args.session, /^[a-z0-9]{16}$/);
    for (const p of mqttTo(E.tvC)) assert.ok(/^otv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(p.text) && !/a=candidate:|v=0/.test(p.text), 'only ciphertext on the relay');
    const msgs = await postedTo(E.tvC);
    const kinds = msgs.map(m => m.dir + ':' + (m.cmd || m.cast));
    for (const k of ['c2t:cast', 'c2r:offer', 'r2c:ready', 'r2c:answer']) assert.ok(kinds.includes(k), k + ' in ' + kinds.join(' '));
    assert.equal(kinds.filter(k => k === 'r2c:answer').length, 1, 'one answer');
    console.log('# relay messages (MQTT): ' + kinds.join(' '));
    await assertLayout(sender, '1440 sharing');
    await sender.screenshot({ path: join(SHOTS, 'sharing-1440-light.png') });
    await receiver.screenshot({ path: join(SHOTS, 'receiver-tv.png') });

    // Stop: the TV hears it over the data channel (no relay message) and closes the receiver.
    const before = sentTo(E.tvC);
    await sender.click('#stopBtn');
    await sender.waitForSelector('#homeCard', { state: 'visible', timeout: 5000 });
    assert.equal(await text(sender, '#noticeTitle'), 'Sharing stopped.');
    assert.equal(await text(sender, '#shareLabel'), 'Share again');
    assert.equal(await sender.inputValue('#code'), CODE_C, 'the code is still typed in');
    assert.equal(await sender.evaluate(() => document.activeElement.id), 'shareBtn');
    await receiverClosed(receiver);
    assert.equal(sentTo(E.tvC), before, 'stopping used no relay messages');
    const ended = await sender.evaluate(() => ({
        capture: window.__gdm.stream.getTracks().every(t => t.readyState === 'ended'),
        steady: window.__otvCastSender.steady.track.readyState === 'ended',
    }));
    assert.deepEqual(ended, { capture: true, steady: true }, 'capture and steady track released');
    assert.equal(await sender.title(), 'Office TV · Share your laptop screen');
    assert.deepEqual(await sender.evaluate(() => Object.keys(localStorage).filter(k => k !== 'officetv.info')), [], 'no TV is saved');
    await until(() => E.relay.sseCount(E.tvC.topic) === 0, 5000, 'relay streams closed');
    await receiver.done();

    // Share again: one click, same code.
    await sender.click('#shareBtn');
    await sharing(sender);
    const second = await rx.wait(2);
    await receiverPlaying(second);
    assert.equal(E.tvC.received('cast').length, 2);
    await sender.click('#stopBtn');
    await receiverClosed(second);
    await second.done();
    await sender.done();
});

test('steady frame rate: a still slide still reaches the TV at 20+ frames per second', { skip, timeout: 120000 }, async () => {
    const run = async steady => {
        const init = [STILL_DISPLAY, RECORD_DISPLAY];
        if (!steady) init.push(() => { window.MediaStreamTrackGenerator = undefined; }); // like Safari / Firefox
        const sender = await open({ init });
        const rx = receiverFor(E.tvC);
        await shareTo(sender, CODE_C, { enter: true });
        await sharing(sender);
        const receiver = await rx.wait(1);
        await sender.evaluate(() => window.__gdmPoke()); // the next slide, once: the TV has a picture to show
        await until(() => receiver.evaluate(() => window.__otvCast.state === 'playing' && document.getElementById('video').videoWidth > 0),
            20000, 'the slide on the TV');
        await sleep(1500); // past the start-up burst; the slide stays still from here on
        const [tx, tvFps] = await Promise.all([measureFps(sender, 'tx'), measureFps(receiver, 'rx')]);
        const s = await sender.evaluate(() => ({ source: window.__gdm.source, steady: window.__otvCastSender.steady && window.__otvCastSender.steady.stats }));
        await sender.click('#stopBtn');
        await receiverClosed(receiver);
        await receiver.done();
        await sender.done();
        return { tx, tvFps, s };
    };
    const on = await run(true);
    console.log('# still slide, steady: sent ' + on.tx.toFixed(1) + ' fps, TV decoded ' + on.tvFps.toFixed(1) + ' fps, ' + JSON.stringify(on.s));
    assert.equal(on.s.source, 'still canvas');
    assert.ok(on.s.steady && on.s.steady.frames <= 10, 'the still slide itself produced almost no frames: ' + JSON.stringify(on.s.steady));
    assert.ok(on.s.steady.repeats > 60, 'the last frame is sent again: ' + JSON.stringify(on.s.steady));
    assert.ok(on.tx >= 20, 'frame rate sent ' + on.tx.toFixed(1) + ' fps');
    assert.ok(on.tvFps >= 20, 'TV frame rate ' + on.tvFps.toFixed(1) + ' fps');
    const off = await run(false);
    console.log('# still slide, without the steady track: sent ' + off.tx.toFixed(1) + ' fps, TV decoded ' + off.tvFps.toFixed(1) + ' fps');
    assert.equal(off.s.steady, null, 'no wrapper without MediaStreamTrackGenerator: the original track is sent');
    assert.ok(off.tx < on.tx, 'the steady track sends more frames than the bare capture');
});

test('connection info: codec, resolution and ~30 fps from getStats; the TV\'s numbers arrive over the data channel', { skip, timeout: 90000 }, async () => {
    const sender = await open({ viewport: { width: 1366, height: 768 }, init: [RECORD_DISPLAY] });
    const rx = receiverFor(E.tvC);
    await shareTo(sender, CODE_C);
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    const posts = sentTo(E.tvC);

    // One quiet line while sharing, details folded away.
    assert.ok(await sender.isVisible('#connInfo'));
    assert.equal(await text(sender, '#connToggle'), 'Connection info');
    assert.equal(await sender.getAttribute('#connToggle', 'aria-expanded'), 'false');
    assert.ok(await sender.isHidden('#connDetails'));

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
    // ~30 fps (the software encoder on a slow test machine may manage a little less at 2560 x 1440).
    const fps = await until(async () => { const m = /^(\d+) fps$/.exec(await row('fps')); return m && +m[1] >= 15 && +m[1]; }, 10000, 'frame rate sent ~30 fps');
    assert.ok(fps <= 31, 'frame rate sent ' + fps);
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
    const hints = await sender.$$eval('#connHints li', l => l.map(x => x.textContent));
    assert.ok(!hints.some(h => /still screen at only/.test(h)), 'no low frame rate hint with the steady track');

    const tvSide = await receiver.evaluate(() => ({ sent: window.__otvCast.statsSent, last: window.__otvCast.lastStats }));
    assert.ok(tvSide.sent >= 2);
    const m = JSON.parse(tvSide.last);
    assert.equal(m.type, 'stats');
    for (const k of ['fps', 'framesDropped', 'jitterMs', 'decodeMs', 'tvMs', 'delayMs']) assert.equal(typeof m[k], 'number', k + ' in ' + tvSide.last);
    assert.ok(tvSide.last.length < 600, 'compact: ' + tvSide.last.length + ' bytes');
    assert.equal(sentTo(E.tvC), posts, 'stats never go over the relay');
    console.log('# connection info: ' + verdict + ' | fps sent ' + fps + ' | hints: ' + JSON.stringify(hints));
    console.log('# TV stats message: ' + tvSide.last);

    assert.equal(await sender.evaluate(() => localStorage.getItem('officetv.info')), '1', 'the open panel is remembered');
    await assertLayout(sender, '1366 sharing, connection info open');
    await sender.screenshot({ path: join(SHOTS, 'connection-info-1366.png'), fullPage: true });
    await sender.setViewportSize({ width: 390, height: 844 });
    await assertLayout(sender, '390 sharing, connection info open');
    await sender.screenshot({ path: join(SHOTS, 'connection-info-390.png'), fullPage: true });
    await sender.click('#connToggle');
    assert.ok(await sender.isHidden('#connDetails'));

    // The browser's own "Stop sharing" bar ends the capture track.
    await sender.evaluate(() => window.__otvCastSender.stream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
    await sender.waitForSelector('#homeCard', { state: 'visible', timeout: 5000 });
    assert.equal(await text(sender, '#noticeTitle'), 'Sharing stopped.');
    await receiverClosed(receiver);
    assert.ok(await sender.isHidden('#connInfo'), 'only while sharing');
    await receiver.done();
    await sender.done();
});

test('MQTT blocked on the network: a 4-digit code shares over ntfy alone, with few messages', { skip, timeout: 90000 }, async () => {
    const sender = await open({ init: [RECORD_DISPLAY], relay: NTFY_ONLY });
    const rx = receiverFor(E.tvC, { relay: NTFY_ONLY });
    await shareTo(sender, CODE_C);
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    assert.match(await label(sender), /^Sharing to Board Room/);
    assert.equal(mqttTo(E.tvC).length, 0);
    assert.deepEqual(E.tvC.vias, ['ntfy']);
    const kinds = (await postedTo(E.tvC)).map(m => m.dir + ':' + (m.cmd || m.cast));
    console.log('# relay messages (ntfy only): ' + kinds.join(' '));
    // Command, offer, the page's one ntfy 'ready' (and the offer once more for it), answer; offers may take 2 parts.
    assert.ok(kinds.length >= 3 && kinds.length <= 8, 'ntfy messages: ' + kinds.length);
    assert.equal(kinds.filter(k => k === 'r2c:answer').length, 1, 'one answer');
    await sender.click('#stopBtn');
    await receiverClosed(receiver);
    await receiver.done();
    await sender.done();
});

test('the offer goes out before the TV\'s ack: a TV page that opens without any ack still shows the screen', { skip, timeout: 90000 }, async () => {
    E.tvC.silent = true; // the TV app's ack never arrives (lost, or a slow relay)
    const sender = await open({ init: [RECORD_DISPLAY] });
    const rx = receiverFor(E.tvC, { delayMs: 1500 });
    await shareTo(sender, CODE_C);
    const cmd = await until(() => E.tvC.received('cast')[0], 10000, 'the cast command');
    // The offer is on the relay before the TV did anything.
    await until(async () => (await postedTo(E.tvC)).some(m => m.dir === 'c2r' && m.cast === 'offer' && m.session === cmd.args.session), 8000, 'the offer');
    assert.equal(E.tvC.acks.length, 0);
    rx.open(cmd.args.session);
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    assert.match(await label(sender), /^Sharing to the TV/, 'no ack yet: no TV name');
    const msgs = await postedTo(E.tvC);
    const offers = msgs.filter(m => m.dir === 'c2r' && m.cast === 'offer');
    const answers = msgs.filter(m => m.dir === 'r2c' && m.cast === 'answer');
    assert.equal(answers.length, 1, 'the TV page answered one offer only, however many copies came');
    console.log('# offers posted: ' + offers.length + ', r2c ready: ' + msgs.filter(m => m.cast === 'ready').length);

    // A late ack still names the TV.
    const ack = { v: 1, dir: 't2c', id: otv.newId(), re: cmd.id, ts: Date.now(), ok: true, msg: 'The TV is ready to show your screen.',
        data: { name: 'Board Room', appVersion: '3.6' }, part: 0, parts: 1 };
    E.relay.publish(E.tvC.topic, await otv.seal(E.tvC.key, E.tvC.topic, ack), undefined, { cache: false });
    await until(async () => /^Sharing to Board Room/.test(await label(sender)), 5000, 'the TV name from the late ack');
    await sender.click('#stopBtn');
    await receiverClosed(receiver);
    await receiver.done();
    await sender.done();
});

test('mDNS: the TV\'s answer lists its real address next to every hidden .local host candidate', { skip, timeout: 90000 }, async () => {
    // Unit checks of the SDP rewrite and the same-network rule.
    const sdp = [
        'v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96',
        'a=candidate:1 1 udp 2122260223 0b4f6c1e-1111-2222-3333-444455556666.local 54321 typ host generation 0 network-cost 999',
        'a=candidate:2 1 udp 1686052607 203.0.113.9 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0',
        'a=candidate:3 1 tcp 1518280447 0b4f6c1e-1111-2222-3333-444455556666.local 9 typ host tcptype active generation 0',
        'a=candidate:4 1 udp 41885439 x.local 3478 typ relay raddr 203.0.113.9 rport 54321',
        'a=end-of-candidates', '',
    ].join('\r\n');
    const out = withLanCandidates(sdp, '192.168.1.40').split('\r\n');
    assert.deepEqual(out.filter(l => /^a=candidate:/.test(l)), [
        'a=candidate:1 1 udp 2122260223 0b4f6c1e-1111-2222-3333-444455556666.local 54321 typ host generation 0 network-cost 999',
        'a=candidate:1 1 udp 2122260223 192.168.1.40 54321 typ host generation 0 network-cost 999',
        'a=candidate:2 1 udp 1686052607 203.0.113.9 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0',
        'a=candidate:3 1 tcp 1518280447 0b4f6c1e-1111-2222-3333-444455556666.local 9 typ host tcptype active generation 0',
        'a=candidate:3 1 tcp 1518280447 192.168.1.40 9 typ host tcptype active generation 0',
        'a=candidate:4 1 udp 41885439 x.local 3478 typ relay raddr 203.0.113.9 rport 54321',
    ]);
    assert.equal(withLanCandidates(sdp, ''), sdp, 'no ip: unchanged');
    assert.equal(withLanCandidates(sdp, 'not-an-ip'), sdp);
    assert.equal(withLanCandidates(sdp.replace(/\r\n/g, '\n'), '10.0.0.5').split('\n').filter(l => /10\.0\.0\.5/.test(l)).length, 2, 'plain \\n SDP');
    for (const [a, ok] of [['10.1.2.3', true], ['172.16.0.9', true], ['172.31.255.1', true], ['172.32.0.1', false], ['192.168.7.7', true],
        ['100.64.0.1', true], ['100.128.0.1', false], ['169.254.3.3', true], ['127.0.0.1', true], ['fd12::1', true], ['fe80::1', true],
        ['2001:db8::1', false], ['203.0.113.5', false], ['198.51.100.7', true], ['', true], ['abc.local', true]]) {
        assert.equal(sameNetworkAddress(a, '198.51.100.20'), ok, a);
    }

    // End to end: the laptop gets both lines for each hidden candidate of the TV page.
    const ip = lanIp();
    const sender = await open({ init: [RECORD_DISPLAY] });
    const rx = receiverFor(E.tvC, { ip });
    await shareTo(sender, CODE_C);
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    const lines = await sender.evaluate(() => window.__otvCastSender.pc.remoteDescription.sdp.split(/\r?\n/).filter(l => /^a=candidate:/.test(l)));
    const local = lines.filter(l => /\.local /.test(l) && / typ host/.test(l));
    console.log('# TV candidates seen by the laptop (ip=' + (ip || 'none') + '): ' + lines.length + ', hidden: ' + local.length);
    for (const l of local) {
        const f = l.split(' ');
        f[4] = ip;
        assert.ok(!ip || lines.includes(f.join(' ')), 'real address next to ' + l);
    }
    assert.equal(await receiver.evaluate(() => window.__otvCast.ip), ip);
    await sender.click('#stopBtn');
    await receiverClosed(receiver);
    await receiver.done();
    await sender.done();
});

test('same network only (4-digit codes): a laptop from another network is refused, with the reason on both screens', { skip, timeout: 90000 }, async () => {
    // The TV page sees the laptop at a public address that is not on its network.
    const elsewhere = () => {
        const get = RTCPeerConnection.prototype.getStats;
        RTCPeerConnection.prototype.getStats = async function (...a) {
            const r = await get.apply(this, a);
            const out = new Map();
            r.forEach((v, k) => {
                const c = Object.assign({}, v);
                if (c.type === 'remote-candidate') { c.address = '203.0.113.5'; c.ip = '203.0.113.5'; }
                out.set(k, c);
            });
            return out;
        };
    };
    const shown = () => {
        const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
        Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get() { return d.get.call(this); },
            set(v) { if (v) window.__shown = (window.__shown || 0) + 1; d.set.call(this, v); } });
    };
    const sender = await open({ viewport: { width: 1366, height: 768 }, init: [RECORD_DISPLAY] });
    const rx = receiverFor(E.tvC, { init: [elsewhere, shown], ip: '192.168.50.20' });
    await shareTo(sender, CODE_C);
    const receiver = await rx.wait(1);
    await sender.waitForSelector('#homeCard', { state: 'visible', timeout: 30000 });
    assert.equal(await text(sender, '#noticeTitle'), 'Screen sharing works only from a laptop on the same network as this TV.');
    assert.equal(await text(sender, '#noticeText'), 'Connect the laptop to the same Wi-Fi as the TV, then try again.');
    assert.equal(await sender.getAttribute('#notice', 'class'), 'notice bad');
    await until(() => receiver.evaluate(() => window.__otvCast.state === 'ended'), 10000, 'receiver ended');
    assert.equal(await text(receiver, '#statusText'), 'Screen sharing works only from a laptop on the same network as this TV.');
    assert.equal(await receiver.evaluate(() => window.__shown || 0), 0, 'the laptop\'s picture was never shown');
    assert.equal(await receiver.evaluate(() => window.__otvCast.remoteAddress), '203.0.113.5');
    await assertLayout(sender, '1366 refused network');
    await sender.screenshot({ path: join(SHOTS, 'refused-network-1366.png') });
    await receiver.screenshot({ path: join(SHOTS, 'receiver-refused-network.png') });
    await until(() => receiver.evaluate(() => window.__closed >= 1), 10000, 'the TV closes the receiver');
    await receiver.done();
    await sender.done();
});

test('no direct connection: "Could not reach the TV. Connect the laptop to the same Wi-Fi as the TV."', { skip, timeout: 90000 }, async () => {
    // Neither side learns an address of the other one.
    const noCandidates = () => {
        const strip = sdp => sdp.split('\r\n').filter(l => !/^a=(candidate|end-of-candidates)/.test(l)).join('\r\n');
        const P = RTCPeerConnection.prototype;
        const srd = P.setRemoteDescription;
        P.setRemoteDescription = function (d) { return srd.call(this, d && d.sdp ? { type: d.type, sdp: strip(d.sdp) } : d); };
        const ld = Object.getOwnPropertyDescriptor(P, 'localDescription');
        Object.defineProperty(P, 'localDescription', { configurable: true, get() { const d = ld.get.call(this); return d && { type: d.type, sdp: strip(d.sdp) }; } });
    };
    const sender = await open({ init: [RECORD_DISPLAY, timeouts({ connectTimeoutMs: 3000 })] });
    const rx = receiverFor(E.tvC, { init: [noCandidates], ip: '' });
    await shareTo(sender, CODE_C);
    const receiver = await rx.wait(1);
    await sender.waitForSelector('#homeCard', { state: 'visible', timeout: 30000 });
    assert.equal(await text(sender, '#noticeTitle'), 'Could not reach the TV.');
    assert.equal(await text(sender, '#noticeText'), 'Connect the laptop to the same Wi-Fi as the TV.');
    await receiverClosed(receiver).catch(() => {}); // the TV app closes it after the stop command
    await receiver.done();
    await sender.done();
});

test('the TV closes the receiver: "The TV stopped showing your screen." and Share again works', { skip, timeout: 90000 }, async () => {
    const sender = await open({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark', init: [RECORD_DISPLAY] });
    const rx = receiverFor(E.tvC);
    await shareTo(sender, CODE_C);
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
    const sender = await open({ init: [RECORD_DISPLAY, timeouts({ dropMs: 500, reconnectTimeoutMs: 2500 })] });
    const rx = receiverFor(E.tvC);
    await shareTo(sender, CODE_C);
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    const before = sentTo(E.tvC);
    await receiver.ctx.close(); // the renderer is gone: no data channel close, only silence
    await sender.waitForFunction(() => document.getElementById('liveChip').textContent === 'Reconnecting', null, { timeout: 20000 });
    assert.match(await text(sender, '#liveLabel'), /^Reconnecting to Board Room/);
    await sender.waitForSelector('#homeCard', { state: 'visible', timeout: 20000 });
    assert.equal(await text(sender, '#noticeTitle'), 'The connection to the TV was lost.');
    assert.equal(await text(sender, '#noticeText'), 'Check the Wi-Fi, then share again.');
    assert.equal(await text(sender, '#shareLabel'), 'Share again');
    { const n = sentTo(E.tvC) - before; assert.ok(n >= 1 && n <= 2, 'one restart offer (1-2 parts), never answered: ' + n); }
    await sender.done();
});

test('reconnects once after a drop: ICE restart on the same session, two relay messages, the TV keeps playing', { skip, timeout: 90000 }, async () => {
    const sender = await open({ init: [RECORD_DISPLAY] });
    const rx = receiverFor(E.tvC);
    await shareTo(sender, CODE_C);
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    await sleep(1000);
    const before = sentTo(E.tvC);
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
    { const n = sentTo(E.tvC) - before; assert.ok(n >= 2 && n <= 3, 'offer (1-2 parts) + answer: ' + n); }
    const t = await receiver.evaluate(() => document.getElementById('video').currentTime);
    await sleep(600);
    assert.ok(await receiver.evaluate(() => document.getElementById('video').currentTime) > t, 'still playing');
    assert.equal(await sender.evaluate(() => window.__otvCastSender.reconnect()), false, 'only once per session');
    await sender.click('#stopBtn');
    await receiverClosed(receiver);
    await receiver.done();
    await sender.done();
});

test('an older TV (10-symbol code, Office TV 3.5): ntfy only, the offer after the TV\'s ack, as before', { skip, timeout: 90000 }, async () => {
    // A (closed) broker is configured: an old code must not even try it.
    const countWs = () => {
        const WS = window.WebSocket;
        window.__ws = [];
        window.WebSocket = function (url, p) { window.__ws.push(String(url)); return new WS(url, p); };
        window.WebSocket.prototype = WS.prototype;
        for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = WS[k];
    };
    const relay = { brokers: ['wss://127.0.0.1:9/mqtt'] };
    const sender = await open({ init: [RECORD_DISPLAY, countWs], relay });
    const rx = receiverFor(E.tvOld, { relay });
    const posts0 = postsTo(E.tvOld);
    await shareTo(sender, 'h7p2k-9r4t1');
    await sharing(sender);
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    assert.match(await label(sender), /^Sharing to Lobby/);
    assert.deepEqual(await sender.evaluate(() => window.__ws), [], 'no MQTT for an old TV');
    assert.equal(mqttTo(E.tvOld).length, 0);
    const msgs = await postedTo(E.tvOld);
    const offer = msgs.find(m => m.dir === 'c2r' && m.cast === 'offer');
    assert.ok(offer && E.tvOld.acks.length === 1 && offer.ts >= E.tvOld.acks[0].ts, 'the offer went out after the ack');
    assert.equal(msgs.filter(m => m.cast === 'ready').length, 0, 'no ready signal');
    const n = postsTo(E.tvOld) - posts0;
    assert.ok(n >= 3 && n <= 5, 'command, offer (1-2 parts), answer: ' + n);
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

test('phone: the TV\'s QR (4-digit code) opens the phone page; one tap shares with the steady track and TV-only sound', { skip, timeout: 90000 }, async () => {
    const phone = await open({ viewport: { width: 390, height: 800 }, mobile: true, init: [RECORD_DISPLAY] });
    const rx = receiverFor(E.tvC);
    const key = 'A'.repeat(43);
    await phone.goto(E.web.url + '/tv/phone.html#h=192.168.1.20&p=47300&k=' + key + '&n=Board%20Room&c=' + CODE_C);
    assert.ok(await phone.isVisible('#web'), 'browser sharing offered');
    assert.ok(await phone.isHidden('#open'), 'the app is not opened by itself');
    assert.equal(await phone.evaluate(() => location.hash), '', 'TV details removed from the address bar');
    assert.match(await text(phone, '#web h1'), /Board Room/);
    await phone.click('#webBtn');
    const gdm = await phone.evaluate(() => window.__gdm.calls);
    assert.ok(gdm.length >= 1);
    assert.deepEqual(gdm[0].options.audio, { suppressLocalAudioPlayback: true });
    await until(async () => /showing on Board Room/.test(await text(phone, '#webStatus')), 30000, 'phone says it is sharing');
    const receiver = await rx.wait(1);
    await receiverPlaying(receiver);
    assert.equal(await phone.evaluate(() => !!window.__otvCastSender.steady), true, 'steady frame rate on the phone too');
    assert.equal(await text(phone, '#webBtn'), 'Stop sharing');
    await assertLayout(phone, 'phone page 390');
    await phone.screenshot({ path: join(SHOTS, 'phone-web-sharing.png'), fullPage: true });
    await phone.click('#webBtn');
    await until(async () => /^Sharing stopped/.test(await text(phone, '#webStatus')), 10000, 'stopped');
    await receiverClosed(receiver);
    await receiver.done();
    await phone.done();
});
