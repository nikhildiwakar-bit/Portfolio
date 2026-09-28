// "Connection info" (tv/stats.js): getStats parsing on both sides, the TV's data channel message, and the
// plain-English verdict shown on the laptop.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FRAME_MS, capabilityHardware, codecName, connectionPath, connectionRows, connectionVerdict, delayBreakdown, formatBitrate,
    hardwareFromImpl, hardwareProbe, isPrivateAddress, parseReceiverStats, parseSenderStats, readReceiverMessage,
    receiverStatsMessage, selectedPair,
} from '../../../tv/stats.js';

/** A Chrome-like sender report (shapes taken from a real Chromium 141 getStats()). */
function senderReport({ t = 10000, bytes = 1000000, frames = 300, encode = 2.4, packets = 1000, pacer = 1.5, codec = 'video/H264',
    impl = 'ExternalEncoder', pe = true, limit = 'none', rtt = 0.004, local = 'host', remote = 'host', w = 2560, h = 1440, fps = 30,
    srcW = 2560, srcH = 1440, protocol = 'udp', remoteAddress = '' } = {}) {
    const list = [
        { id: 'COT01_102', type: 'codec', mimeType: codec, clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
        { id: 'CP1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'succeeded', nominated: true, currentRoundTripTime: rtt, availableOutgoingBitrate: 14000000 },
        { id: 'CP2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R1', state: 'failed', currentRoundTripTime: 0.5 },
        { id: 'L1', type: 'local-candidate', candidateType: local, protocol, address: '' },
        { id: 'L2', type: 'local-candidate', candidateType: 'relay', protocol: 'udp' },
        { id: 'R1', type: 'remote-candidate', candidateType: remote, protocol, address: remoteAddress },
        { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP1' },
        { id: 'SV1', type: 'media-source', kind: 'video', width: srcW, height: srcH, framesPerSecond: 30 },
        { id: 'RIV1', type: 'remote-inbound-rtp', kind: 'video', localId: 'OT1', roundTripTime: 0.009, fractionLost: 0 },
        {
            id: 'OT1', type: 'outbound-rtp', kind: 'video', timestamp: t, ssrc: 11, codecId: 'COT01_102', mediaSourceId: 'SV1', remoteId: 'RIV1',
            bytesSent: bytes, framesSent: frames, framesEncoded: frames, totalEncodeTime: encode, packetsSent: packets, totalPacketSendDelay: pacer,
            frameWidth: w, frameHeight: h, framesPerSecond: fps, encoderImplementation: impl, powerEfficientEncoder: pe, qualityLimitationReason: limit,
        },
        { id: 'OT2', type: 'outbound-rtp', kind: 'audio', timestamp: t, ssrc: 12, bytesSent: 9e9 },
    ];
    if (impl === null) delete list[9].encoderImplementation;
    if (pe === null) delete list[9].powerEfficientEncoder;
    return new Map(list.map(s => [s.id, s]));
}

function receiverReport({ t = 10000, decoded = 300, dropped = 0, jb = 3.6, jbCount = 300, decodeTime = 2.4, lost = 0, received = 3000,
    codec = 'video/H264', impl, pe, rtt = 0.004, fps = 30, w = 2560, h = 1440 } = {}) {
    const inbound = {
        id: 'IT1', type: 'inbound-rtp', kind: 'video', timestamp: t, ssrc: 11, codecId: 'CIT1', frameWidth: w, frameHeight: h, framesPerSecond: fps,
        framesDecoded: decoded, framesDropped: dropped, jitterBufferDelay: jb, jitterBufferEmittedCount: jbCount, totalDecodeTime: decodeTime,
        packetsLost: lost, packetsReceived: received, freezeCount: 0, bytesReceived: 5e6,
    };
    if (impl !== undefined) inbound.decoderImplementation = impl;
    if (pe !== undefined) inbound.powerEfficientDecoder = pe;
    return [
        { id: 'CIT1', type: 'codec', mimeType: codec, sdpFmtpLine: codec === 'video/H264' ? 'packetization-mode=1;profile-level-id=42e01f' : '' },
        { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP9' },
        { id: 'CP9', type: 'candidate-pair', localCandidateId: 'a', remoteCandidateId: 'b', currentRoundTripTime: rtt },
        { id: 'a', type: 'local-candidate', candidateType: 'host' },
        { id: 'b', type: 'remote-candidate', candidateType: 'host' },
        inbound,
        { id: 'IT2', type: 'inbound-rtp', kind: 'audio', ssrc: 12, bytesReceived: 9e9 },
    ];
}

test('sender stats: codec, resolution, fps, bitrate between samples, hardware encoder, round trip, direct path', () => {
    const a = parseSenderStats(senderReport());
    assert.equal(a.codec, 'video/H264');
    assert.equal(a.width, 2560);
    assert.equal(a.height, 1440);
    assert.equal(a.fps, 30);
    assert.equal(a.bitrate, null, 'no rate from a single sample');
    assert.equal(a.encoder, 'ExternalEncoder');
    assert.equal(a.powerEfficient, true);
    assert.equal(a.hardware, true);
    assert.equal(a.hardwareFrom, 'stats');
    assert.equal(a.limit, 'none');
    assert.equal(a.rttMs, 4, 'the selected pair (not the failed one) and not remote-inbound-rtp');
    assert.equal(a.path, 'direct');
    assert.equal(a.local + '/' + a.remote, 'host/host');
    assert.equal(a.availableBitrate, 14000000);
    assert.equal(a.srcWidth, 2560);
    assert.equal(a.encodeMs, 8, 'all-time average first');
    // 2 s later: 3 MB more (12 Mbps), 60 more frames with 0.36 s of encoding (6 ms each), 400 packets with 0.8 s queueing.
    const b = parseSenderStats(senderReport({ t: 12000, bytes: 4000000, frames: 360, encode: 2.76, packets: 1400, pacer: 2.3 }), a);
    assert.equal(b.bitrate, 12000000);
    assert.equal(Math.round(b.encodeMs), 6);
    assert.equal(Math.round(b.pacerMs), 2);
    // Without framesPerSecond the rate comes from the frame counter.
    const r = senderReport({ t: 14000, frames: 400, bytes: 5000000 });
    r.get('OT1').framesPerSecond = undefined;
    assert.equal(parseSenderStats(r, b).fps, 20);
    // A software encoder, the remote-inbound round trip when no pair is reported.
    const sw = senderReport({ impl: 'OpenH264', pe: null });
    sw.delete('T01');
    sw.get('CP1').nominated = false;
    const c = parseSenderStats(sw);
    assert.equal(c.hardware, false);
    assert.equal(c.rttMs, 9);
    assert.equal(c.path, '');
    assert.equal(parseSenderStats(new Map()).codec, '', 'empty report');
    assert.equal(parseSenderStats(null).width, 0);
});

test('selected pair: transport id, then Firefox "selected", then nominated + succeeded', () => {
    const base = [
        { id: 'p', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: 0.02, selected: true },
        { id: 'l', type: 'local-candidate', candidateType: 'srflx', protocol: 'UDP' },
        { id: 'r', type: 'remote-candidate', candidateType: 'host' },
    ];
    const p = selectedPair(base);
    assert.equal(p.rttMs, 20);
    assert.equal(p.protocol, 'udp');
    assert.equal(connectionPath(p), 'router');
    assert.equal(selectedPair([{ id: 'x', type: 'candidate-pair', nominated: true, state: 'in-progress' }]), null);
    assert.equal(selectedPair([]), null);
});

test('connection path: host = direct; srflx = through the router; relay; prflx by address', () => {
    assert.equal(connectionPath({ local: 'host', remote: 'host' }), 'direct');
    assert.equal(connectionPath({ local: 'host', remote: 'prflx', remoteAddress: '192.168.1.40' }), 'direct', 'the TV hid its address (mDNS)');
    assert.equal(connectionPath({ local: 'host', remote: 'prflx', remoteAddress: '' }), 'direct', 'address hidden by the browser');
    assert.equal(connectionPath({ local: 'prflx', remote: 'host', localAddress: '203.0.113.5' }), 'router');
    assert.equal(connectionPath({ local: 'srflx', remote: 'host' }), 'router');
    assert.equal(connectionPath({ local: 'host', remote: 'relay' }), 'relay');
    assert.equal(connectionPath({ local: '', remote: 'host' }), '');
    assert.equal(connectionPath(null), '');
    for (const a of ['10.0.0.2', '172.20.1.1', '192.168.0.9', '169.254.3.3', 'fd00::1', 'fe80::1', 'abc.local']) assert.ok(isPrivateAddress(a), a);
    for (const a of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '']) assert.ok(!isPrivateAddress(a), a);
});

test('hardware or software: powerEfficient first, then the implementation name', () => {
    assert.equal(hardwareFromImpl('libvpx', true), true);
    assert.equal(hardwareFromImpl('ExternalDecoder', false), false);
    assert.equal(hardwareFromImpl('ExternalDecoder'), true);
    assert.equal(hardwareFromImpl('MediaCodecVideoDecoder'), true);
    assert.equal(hardwareFromImpl('VaapiVideoEncodeAccelerator'), true);
    assert.equal(hardwareFromImpl('libvpx'), false);
    assert.equal(hardwareFromImpl('OpenH264'), false);
    assert.equal(hardwareFromImpl('FFmpeg'), false);
    assert.equal(hardwareFromImpl('libvpx (fallback from: ExternalDecoder)'), false);
    assert.equal(hardwareFromImpl('SimulcastEncoderAdapter'), null);
    assert.equal(hardwareFromImpl(''), null);
    assert.equal(hardwareFromImpl(undefined, undefined), null);
    assert.equal(codecName('video/H264'), 'H.264');
    assert.equal(codecName('video/VP8'), 'VP8');
    assert.equal(codecName('video/AV1'), 'AV1');
    assert.equal(formatBitrate(15000000), '15 Mbps');
    assert.equal(formatBitrate(4830000), '4.8 Mbps');
    assert.equal(formatBitrate(640000), '640 kbps');
    assert.equal(formatBitrate(null), '');
});

test('hardware from mediaCapabilities when getStats hides the decoder; asked once per codec and size', async () => {
    const calls = [];
    const mc = { decodingInfo: async c => { calls.push(c); return { supported: true, smooth: true, powerEfficient: /H264/.test(c.video.contentType) }; } };
    const s = { codec: 'video/H264', fmtp: 'packetization-mode=1', width: 1920, height: 1080, fps: 30, bitrate: 8e6, hardware: null, hardwareFrom: '' };
    assert.equal(await capabilityHardware(mc, 'decoding', s), true);
    assert.deepEqual(calls[0], { type: 'webrtc', video: { contentType: 'video/H264;packetization-mode=1', width: 1920, height: 1080, bitrate: 8000000, framerate: 30 } });
    const probe = hardwareProbe(mc, 'decoding');
    calls.length = 0;
    const a = await probe(Object.assign({}, s));
    const b = await probe(Object.assign({}, s));
    assert.equal(a.hardware, true);
    assert.equal(a.hardwareFrom, 'capabilities');
    assert.equal(b.hardware, true);
    assert.equal(calls.length, 1, 'cached');
    const vp8 = await probe(Object.assign({}, s, { codec: 'video/VP8', fmtp: '' }));
    assert.equal(vp8.hardware, false);
    assert.equal(calls.length, 2);
    const known = await probe(Object.assign({}, s, { hardware: false, hardwareFrom: 'stats' }));
    assert.equal(known.hardwareFrom, 'stats', 'getStats wins');
    assert.equal(calls.length, 2);
    assert.equal(await capabilityHardware({ decodingInfo: async () => ({ supported: false }) }, 'decoding', s), null);
    assert.equal(await capabilityHardware({ decodingInfo: async () => { throw new TypeError('x'); } }, 'decoding', s), null);
    assert.equal(await capabilityHardware(undefined, 'decoding', s), null);
    assert.equal(await capabilityHardware(mc, 'decoding', Object.assign({}, s, { width: 0 })), null);
});

test('receiver stats: per-interval fps, drops, jitter buffer and decode averages, loss, round trip', () => {
    const a = parseReceiverStats(receiverReport());
    assert.equal(a.codec, 'video/H264');
    assert.equal(a.width, 2560);
    assert.equal(a.fps, 30);
    assert.equal(a.jitterMs, 12, 'jitterBufferDelay / jitterBufferEmittedCount');
    assert.equal(a.decodeMs, 8);
    assert.equal(a.dropPct, 0);
    assert.equal(a.rttMs, 4);
    assert.equal(a.hardware, null, 'Chrome hides the decoder on pages that are not capturing');
    // 2 s later: 50 frames decoded + 10 dropped, 0.5 s more jitter buffer over 50 frames, 1 s decoding, 30 of 1030 packets lost.
    const b = parseReceiverStats(receiverReport({ t: 12000, decoded: 350, dropped: 10, jb: 4.1, jbCount: 350, decodeTime: 3.4, lost: 30, received: 4000, fps: null }), a);
    assert.equal(b.fps, 25);
    assert.equal(Math.round(b.dropPct * 10) / 10, 16.7);
    assert.equal(Math.round(b.jitterMs), 10);
    assert.equal(Math.round(b.decodeMs), 20);
    assert.equal(Math.round(b.lossPct * 10) / 10, 2.9);
    const hw = parseReceiverStats(receiverReport({ impl: 'ExternalDecoder', pe: true }));
    assert.equal(hw.hardware, true);
    assert.equal(hw.hardwareFrom, 'stats');
    assert.equal(parseReceiverStats(receiverReport({ impl: 'libvpx', codec: 'video/VP8' })).hardware, false);
});

test('the TV\'s stats message: compact JSON, estimated or measured TV delay, checked again on the laptop', () => {
    const rx = parseReceiverStats(receiverReport({ impl: 'ExternalDecoder', pe: true }));
    const est = receiverStatsMessage(rx, { screen: '3840x2160' });
    assert.equal(est.type, 'stats');
    assert.equal(est.tvMsFrom, 'estimated');
    assert.equal(est.tvMs, 12 + 8 + FRAME_MS, 'jitter buffer + decode + one frame');
    assert.equal(est.delayMs, est.tvMs + 2, 'plus half the round trip');
    assert.equal(est.screen, '3840x2160');
    const m = receiverStatsMessage(rx, { tvMs: 41.6, screen: '1920x1080' });
    assert.equal(m.tvMs, 42);
    assert.equal(m.tvMsFrom, 'measured');
    const text = JSON.stringify(m);
    assert.ok(text.length < 600, 'small: ' + text.length + ' bytes');
    const back = readReceiverMessage(text);
    assert.equal(back.fps, 30);
    assert.equal(back.framesDropped, 0);
    assert.equal(back.decoder, 'ExternalDecoder');
    assert.equal(back.powerEfficient, true);
    assert.equal(back.hardware, true);
    assert.equal(back.jitterMs, 12);
    assert.equal(back.tvMs, 42);
    assert.equal(back.delayMs, 44);
    assert.equal(back.screen, '1920x1080');
    assert.equal(back.codec, 'video/H264');
    // Anything else on the channel is not stats; odd values are dropped.
    for (const bad of ['bye', '', '{', '{"type":"other"}', null, 42, '{"type":"stats"' + ' '.repeat(5000) + '}']) assert.equal(readReceiverMessage(bad), null, String(bad).slice(0, 20));
    const odd = readReceiverMessage(JSON.stringify({ type: 'stats', fps: -1, decoder: 'x'.repeat(500), hardware: 'yes', screen: '<b>', codec: 'text/html', jitterMs: 'NaN', tvMsFrom: 'x' }));
    assert.equal(odd.fps, null);
    assert.equal(odd.decoder.length, 80);
    assert.equal(odd.hardware, null);
    assert.equal(odd.screen, '');
    assert.equal(odd.codec, '');
    assert.equal(odd.jitterMs, null);
    assert.equal(odd.tvMsFrom, 'estimated');
});

/** tx/rx as the laptop sees them, with overrides. */
const TX = o => Object.assign(parseSenderStats(senderReport()), { encodeMs: 8, pacerMs: 5, rttMs: 4, fps: 30 }, o || {});
const RX = o => Object.assign(readReceiverMessage(JSON.stringify(receiverStatsMessage(parseReceiverStats(receiverReport({ impl: 'ExternalDecoder', pe: true })), { tvMs: 148, screen: '3840x2160' }))), o || {});

test('verdict: direct, H.264 in hardware, estimated delay', () => {
    const v = connectionVerdict(TX(), RX());
    // laptop 17 + 8 + 5, network 4 / 2, TV 148 (measured) = 180 ms
    assert.equal(v.text, 'Direct connection · H.264 hardware · ~180 ms delay');
    assert.equal(v.level, 'good');
    assert.deepEqual(v.hints, []);
    assert.deepEqual(delayBreakdown(TX(), RX()), { total: 180, laptop: 30, network: 2, tv: 148, tvFrom: 'measured' });
});

test('verdict: the TV decoding VP8 in software', () => {
    const v = connectionVerdict(TX({ codec: 'video/VP8', hardware: false, encoder: 'libvpx' }), RX({ codec: 'video/VP8', hardware: false, hardwareFrom: 'capabilities', decoder: '' }));
    assert.match(v.text, /^Direct connection · VP8 software on the TV · ~\d+ ms delay$/);
    assert.equal(v.hints[0], 'The TV is decoding in software (VP8) — slow on this TV');
    assert.ok(v.hints.includes('The laptop is encoding in software (libvpx) — this can cost sharpness and add delay'));
    assert.equal(v.level, 'bad');
    // VP8 without a word from the TV about its decoder.
    const u = connectionVerdict(TX({ codec: 'video/VP8' }), RX({ hardware: null }));
    assert.ok(u.hints.includes('Using VP8 instead of H.264 — TVs usually decode only H.264 in hardware'));
    assert.equal(u.text, 'Direct connection · VP8 hardware · ~180 ms delay', 'the laptop encoder is still hardware');
});

test('verdict: weak Wi-Fi, not direct, relay, TCP', () => {
    let v = connectionVerdict(TX({ rttMs: 120 }), RX());
    assert.ok(v.hints.includes('Weak Wi-Fi (high round-trip: 120 ms)'));
    assert.equal(v.level, 'warn');
    assert.equal(connectionVerdict(TX({ rttMs: 220 }), RX()).level, 'bad');
    v = connectionVerdict(TX({ lossPct: 4 }), RX());
    assert.ok(v.hints.includes('Weak Wi-Fi (4% of the packets are lost)'));
    v = connectionVerdict(TX({ path: 'router', local: 'srflx', remote: 'srflx' }), RX());
    assert.match(v.text, /^Through the router · /);
    assert.ok(v.hints.some(h => /not connected directly/.test(h)));
    v = connectionVerdict(TX({ path: 'relay' }), RX());
    assert.match(v.text, /^Through a relay server · /);
    v = connectionVerdict(TX({ protocol: 'tcp' }), RX());
    assert.ok(v.hints.includes('Connected over TCP because UDP is blocked, which adds delay'));
});

test('verdict: laptop limits, the TV falling behind, a small Android screen, where the delay is', () => {
    let v = connectionVerdict(TX({ limit: 'cpu' }), RX());
    assert.ok(v.hints.includes('The laptop\'s processor is the limit, so it sends fewer frames per second'));
    v = connectionVerdict(TX({ limit: 'bandwidth', availableBitrate: 3200000 }), RX());
    assert.ok(v.hints.includes('Not enough network bandwidth for the full picture (3.2 Mbps available)'));
    v = connectionVerdict(TX({ width: 1280, height: 720 }), RX());
    assert.ok(v.hints.includes('Sending 1280 x 720, less than the captured 2560 x 1440'));
    v = connectionVerdict(TX(), RX({ dropPct: 20, fps: 12, decodeMs: 45, jitterMs: 120 }));
    assert.ok(v.hints.includes('The TV is dropping frames (20%) — it cannot keep up'));
    assert.ok(v.hints.includes('The TV shows 12 of the 30 frames per second the laptop sends'));
    assert.ok(v.hints.includes('The TV takes 45 ms to decode each frame — its decoder is slow'));
    assert.ok(v.hints.includes('The TV waits 120 ms for late packets (uneven Wi-Fi)'));
    assert.equal(v.level, 'bad');
    v = connectionVerdict(TX(), RX({ screen: '1920x1080' }));
    assert.ok(v.hints.includes('The TV\'s Android screen is only 1920 x 1080, so the 2560 x 1440 picture is scaled down to that'));
    v = connectionVerdict(TX(), RX({ tvMs: 900 }));
    assert.equal(v.text, 'Direct connection · H.264 hardware · ~930 ms delay');
    assert.ok(v.hints.includes('Most of the delay is on the TV (900 ms)'));
});

test('verdict before the TV reports, and before any stats', () => {
    const v = connectionVerdict(TX(), null);
    assert.equal(v.text, 'Direct connection · H.264 hardware');
    assert.deepEqual(v.hints, ['Waiting for the numbers from the TV…']);
    assert.equal(v.level, 'wait');
    assert.equal(v.delay, null);
    assert.deepEqual(connectionVerdict(null, null), { text: 'Measuring…', level: 'wait', hints: [], delay: null });
});

test('detail rows: codec, resolution, fps, bitrate, encoder, limit, round trip, path, the TV\'s numbers, delay', () => {
    const rows = connectionRows(TX({ bitrate: 12000000, srcWidth: 3840, srcHeight: 2160 }), RX());
    const val = Object.fromEntries(rows.map(r => [r.k, r.value]));
    const lab = Object.fromEntries(rows.map(r => [r.k, r.label]));
    assert.equal(val.codec, 'H.264 (video/H264)');
    assert.equal(val.res, '2560 x 1440 (captured 3840 x 2160)');
    assert.equal(val.fps, '30 fps');
    assert.equal(val.bitrate, '12 Mbps (network allows 14 Mbps)');
    assert.equal(val.encoder, 'ExternalEncoder · hardware');
    assert.equal(val.limit, 'Nothing');
    assert.equal(val.rtt, '4 ms');
    assert.equal(val.path, 'Direct, same network (host / host, UDP)');
    assert.equal(val.tvfps, '30 fps decoded');
    assert.equal(val.tvdrop, '0 (0%)');
    assert.equal(val.tvdecoder, 'ExternalDecoder · hardware');
    assert.equal(val.tvjitter, '12 ms per frame');
    assert.equal(val.tvdecode, '8 ms per frame');
    assert.equal(val.tvscreen, '3840 x 2160 pixels');
    assert.equal(val.delay, '~180 ms (laptop 30 + network 2 + TV 148 ms, TV part measured)');
    assert.equal(lab.tvjitter, 'TV jitter buffer');
    const guess = Object.fromEntries(connectionRows(TX(), RX({ decoder: '', hardware: false, hardwareFrom: 'capabilities' })).map(r => [r.k, r.value]));
    assert.equal(guess.tvdecoder, 'software (reported by the web engine)');
    const early = Object.fromEntries(connectionRows(TX({ bitrate: null }), null).map(r => [r.k, r.value]));
    assert.equal(early.bitrate, '…');
    assert.equal(early.tvfps, 'Waiting for the TV…');
    assert.equal(early.delay, 'Waiting for the TV…');
});
