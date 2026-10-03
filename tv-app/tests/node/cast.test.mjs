// Share my screen signaling (tv/cast.js): payload encoding, message format, encryption and the relay channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as otv from '../../../tv/otv.js';
import {
    CastChannel, CastReceiver, CastSender, CONTENT_HINT, DEGRADATION, MAX_BITRATE, MAX_FPS, MAX_SIGNAL_PARTS, SIGNAL_CHUNK, SignalAssembler, captureScreen, decodeSignal,
    displayMediaOptions, encodeSignal, parseReceiverFragment, preferCodec, preferH264, receiverUrl, senderSupport, signalMessages,
    tuneSender, validSession, receiverCodecOrder, preferReceiveCodecs, lowLatencyReceiver, iceGathered, ICE_WAIT_MS, fitScale, FPS_STEPS,
} from '../../../tv/cast.js';

const CODE = '7K3M9QX2TD';
const RELAY = 'https://relay.test';
const SESSION = 'abcdefghij0123456';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Realistic-size SDP: video + audio + data channel with several candidates (about 5 KB). */
function fakeSdp(type) {
    const lines = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2',
        'a=extmap-allow-mixed', 'a=msid-semantic: WMS stream'];
    for (const [i, kind] of [[0, 'video'], [1, 'audio'], [2, 'application']].map(x => x)) {
        lines.push('m=' + kind + ' 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 102', 'c=IN IP4 0.0.0.0', 'a=mid:' + i,
            'a=ice-ufrag:Ab3d', 'a=ice-pwd:K2mJ8sQ0zX1vB4nL7pR9tY3w', 'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'),
            'a=setup:' + (type === 'offer' ? 'actpass' : 'active'));
        for (let c = 0; c < 4; c++) lines.push('a=candidate:' + (1000 + c) + ' 1 udp 2122260223 192.168.1.' + (20 + c) + ' 5' + c + '123 typ host generation 0 network-id ' + c);
        for (let r = 96; r < 103; r++) lines.push('a=rtpmap:' + r + ' VP8/90000', 'a=rtcp-fb:' + r + ' nack pli', 'a=fmtp:' + r + ' level-asymmetry-allowed=1;packetization-mode=1');
    }
    return lines.join('\r\n') + '\r\n';
}

function makeRelay() {
    const relay = {
        subs: new Map(), posts: [], cache: [], skew: 0,
        now() { return Math.floor(Date.now() / 1000) + this.skew; },
        publish(topic, message) {
            const ev = { id: otv.newId(), time: this.now(), event: 'message', topic, message };
            this.cache.push(ev);
            for (const fn of Array.from(this.subs.get(topic) || [])) fn(ev);
            return ev;
        },
    };
    class FakeES {
        constructor(url) {
            const u = new URL(url);
            this.url = url;
            this.readyState = 0;
            this.topic = u.pathname.split('/')[1];
            this.since = u.searchParams.get('since');
            setTimeout(() => {
                this.readyState = 1;
                const fn = ev => this.onmessage && this.onmessage({ data: JSON.stringify(ev) });
                if (!relay.subs.has(this.topic)) relay.subs.set(this.topic, new Set());
                relay.subs.get(this.topic).add(fn);
                this.unsub = () => relay.subs.get(this.topic).delete(fn);
                if (this.onopen) this.onopen();
                if (this.since) for (const ev of relay.cache.filter(e => e.topic === this.topic)) fn(ev);
            }, 5);
        }
        addEventListener() {}
        close() { this.readyState = 2; if (this.unsub) this.unsub(); }
    }
    const fetch = async (url, opts) => {
        const topic = new URL(url).pathname.split('/')[1];
        relay.posts.push({ url, body: opts.body });
        const ev = relay.publish(topic, opts.body);
        return { ok: true, status: 200, json: async () => ev };
    };
    return { relay, FakeES, fetch };
}

test('offer/answer encode and decode round trip, compressed and plain', async () => {
    for (const type of ['offer', 'answer']) {
        const desc = { type, sdp: fakeSdp(type) };
        const z = await encodeSignal(desc);
        assert.equal(z[0], 'z', 'compressed when CompressionStream exists');
        assert.ok(z.length < desc.sdp.length / 2, 'compression shrinks SDP (' + z.length + ' vs ' + desc.sdp.length + ')');
        assert.deepEqual(await decodeSignal(z), desc);
        const j = await encodeSignal(desc, { compress: false });
        assert.equal(j[0], 'j');
        assert.deepEqual(await decodeSignal(j), desc);
    }
    assert.equal(await decodeSignal('zNOT-DEFLATE'), null);
    assert.equal(await decodeSignal('j{"type":"pranswer","sdp":"x"}'), null);
    assert.equal(await decodeSignal('x'), null);
    assert.equal(await decodeSignal(null), null);
});

test('signal messages: format, chunking and envelope size', async () => {
    const topic = await otv.deriveTopic(CODE);
    const key = await otv.deriveKey(CODE);
    const data = 'j' + 'x'.repeat(SIGNAL_CHUNK * 2 + 10);
    const msgs = signalMessages({ dir: 'c2r', session: SESSION, cast: 'offer', data });
    assert.equal(msgs.length, 3);
    for (const [i, m] of msgs.entries()) {
        assert.equal(m.v, 1);
        assert.equal(m.dir, 'c2r');
        assert.equal(m.session, SESSION);
        assert.equal(m.cast, 'offer');
        assert.equal(m.part, i);
        assert.equal(m.parts, 3);
        assert.ok(m.id.length >= 10 && typeof m.ts === 'number');
        const env = await otv.seal(key, topic, m);
        assert.ok(env.startsWith('otv1.'));
        assert.ok(env.length < otv.MAX_ENVELOPE_BYTES, 'envelope ' + env.length + ' under limit');
        assert.deepEqual(await otv.open(key, topic, env), m, 'decrypts with the pairing key');
        const wrong = await otv.deriveKey('Q4W8Z2M6N0');
        assert.equal(await otv.open(wrong, topic, env), null, 'other TV codes cannot read it');
    }
    // Reassembly in any order; duplicates harmless.
    const asm = new SignalAssembler();
    assert.equal(asm.add(msgs[2]), null);
    assert.equal(asm.add(msgs[0]), null);
    assert.equal(asm.add(msgs[0]), null);
    assert.equal(asm.add(msgs[1]), data);
    assert.equal(asm.add({ session: SESSION, cast: 'offer', part: 5, parts: 2, data: 'x' }), null, 'part out of range');
    assert.throws(() => signalMessages({ dir: 'c2r', session: SESSION, cast: 'offer', data: 'x'.repeat(SIGNAL_CHUNK * MAX_SIGNAL_PARTS + 1) }));
    const bye = signalMessages({ dir: 'r2c', session: SESSION, cast: 'bye' });
    assert.equal(bye.length, 1);
    assert.equal(bye[0].data, '');
});

test('a realistic offer with all ICE candidates fits in one relay message', async () => {
    const z = await encodeSignal({ type: 'offer', sdp: fakeSdp('offer') });
    assert.equal(signalMessages({ dir: 'c2r', session: SESSION, cast: 'offer', data: z }).length, 1);
});

test('receiver URL keeps the pairing code in the fragment only', () => {
    const u = receiverUrl({ session: SESSION, code: CODE, relay: 'https://ntfy.sh' });
    assert.equal(u, 'https://nikhildiwakar-bit.github.io/Portfolio/tv/receive.html#s=' + SESSION + '&code=' + CODE);
    assert.equal(new URL(u).search, '');
    assert.deepEqual(parseReceiverFragment(new URL(u).hash), { session: SESSION, code: CODE, relay: 'https://ntfy.sh', ip: '' });
    // The TV's LAN address (Office TV 3.6+), for its answer's candidates and the same-network check.
    const withIp = receiverUrl({ session: SESSION, code: '0427', ip: '192.168.1.40' });
    assert.equal(withIp, 'https://nikhildiwakar-bit.github.io/Portfolio/tv/receive.html#s=' + SESSION + '&code=0427&ip=192.168.1.40');
    assert.deepEqual(parseReceiverFragment(new URL(withIp).hash), { session: SESSION, code: '0427', relay: 'https://ntfy.sh', ip: '192.168.1.40' });
    assert.equal(parseReceiverFragment('#s=' + SESSION + '&code=0427&ip=999.1.1.1').ip, '', 'not an IPv4 address');
    assert.equal(parseReceiverFragment('#s=' + SESSION + '&code=0427&ip=fe80::1').ip, '');
    assert.equal(receiverUrl({ session: SESSION, code: '0427', ip: 'evil.example' }).indexOf('ip='), -1);
    const r = receiverUrl({ session: SESSION, code: CODE, relay: 'https://relay.example.com/' });
    assert.equal(parseReceiverFragment(new URL(r).hash).relay, 'https://relay.example.com');
    assert.equal(parseReceiverFragment('#s=short&code=' + CODE), null);
    assert.equal(parseReceiverFragment('#s=' + SESSION + '&code=bad'), null);
    assert.ok(validSession(otv.newId(16)));
    assert.ok(!validSession('ABC'));
});

test('two channels exchange offer and answer; others are ignored', async () => {
    const { relay, FakeES, fetch } = makeRelay();
    const tx = new CastChannel({ code: CODE, relay: RELAY, session: SESSION, out: 'c2r', fetch, EventSource: FakeES });
    const got = { tx: [], rx: [], other: [] };
    tx.onsignal = (c, d) => got.tx.push([c, d]);
    await tx.init();
    assert.ok(await tx.waitOpen(1000));
    const offer = await encodeSignal({ type: 'offer', sdp: fakeSdp('offer') });
    // The offer goes out before the receiver subscribes; since= replays it (the TV page loads later).
    assert.equal(await tx.send('offer', offer), 1);
    const rx = new CastChannel({ code: CODE, relay: RELAY, session: SESSION, out: 'r2c', since: '5m', fetch, EventSource: FakeES });
    rx.onsignal = (c, d) => got.rx.push([c, d]);
    const other = new CastChannel({ code: CODE, relay: RELAY, session: 'zzzzzzzzzzzzzzzz', out: 'r2c', since: '5m', fetch, EventSource: FakeES });
    other.onsignal = (c, d) => got.other.push([c, d]);
    await rx.init();
    await other.init();
    await sleep(50);
    assert.deepEqual(got.rx, [['offer', offer]]);
    assert.deepEqual(got.other, [], 'other sessions ignore it');
    assert.deepEqual(got.tx, [], 'own direction is ignored');
    const answer = await encodeSignal({ type: 'answer', sdp: fakeSdp('answer') });
    await rx.send('answer', answer);
    for (let i = 0; i < 100 && !got.tx.length; i++) await sleep(10);
    assert.deepEqual(got.tx, [['answer', answer]]);
    assert.equal(got.rx.length, 1);

    // Replay of an old envelope (same id) is dropped; so is a stale timestamp.
    const topic = await otv.deriveTopic(CODE);
    relay.publish(topic, relay.posts[1].body);
    const key = await otv.deriveKey(CODE);
    const stale = signalMessages({ dir: 'r2c', session: SESSION, cast: 'bye', ts: Date.now() - 400 * 1000 })[0];
    relay.publish(topic, await otv.seal(key, topic, stale));
    await sleep(30);
    assert.equal(got.tx.length, 1);
    // Every envelope on the wire is ciphertext; the SDP never appears in clear.
    for (const p of relay.posts) {
        assert.ok(p.body.startsWith('otv1.'));
        assert.ok(!p.body.includes('candidate'));
    }
    // A c2r/r2c message is not a command: the TV app and TvLink ignore anything but c2t / t2c.
    const plain = await otv.open(key, topic, relay.posts[0].body);
    assert.equal(plain.dir, 'c2r');
    assert.equal(plain.cmd, undefined);
    tx.close();
    rx.close();
    other.close();
});

test('channel reports relay limits', async () => {
    const { FakeES } = makeRelay();
    const fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const ch = new CastChannel({ code: CODE, relay: RELAY, session: SESSION, out: 'c2r', fetch, EventSource: FakeES });
    await ch.init();
    await assert.rejects(ch.send('offer', 'jx'), e => e.code === 'rate_limit');
    ch.close();
});

// ---------- capture options, codecs, bitrate ----------

test('getDisplayMedia options: native resolution (ideal 1440p, up to 4K) at 60 fps, audio on the TV only, own tab excluded, tab switching allowed', async () => {
    const o = displayMediaOptions();
    assert.deepEqual(o.video, { width: { ideal: 2560, max: 3840 }, height: { ideal: 1440, max: 2160 }, frameRate: { ideal: 60, max: 60 } });
    assert.deepEqual(o.audio, { suppressLocalAudioPlayback: true }, 'a shared tab is silent on the laptop and plays on the TV');
    assert.equal(o.selfBrowserSurface, 'exclude');
    assert.equal(o.surfaceSwitching, 'include');
    assert.equal(o.systemAudio, 'include');
    assert.notEqual(displayMediaOptions(), o, 'a fresh object each time');
    const calls = [];
    const stream = { id: 's' };
    const md = { getDisplayMedia: async c => { calls.push(c); return stream; } };
    assert.equal(await captureScreen(md), stream);
    assert.deepEqual(calls, [displayMediaOptions()]);
    // A browser that rejects an option (TypeError) is asked again with the defaults.
    const calls2 = [];
    const old = {
        getDisplayMedia(c) {
            calls2.push(c);
            if (calls2.length === 1) throw new TypeError('unknown member');
            return Promise.resolve(stream);
        },
    };
    assert.equal(await captureScreen(old), stream);
    assert.deepEqual(calls2[1], { video: true, audio: true });
    // The user closing the picker is passed through untouched.
    const denied = { getDisplayMedia: async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; } };
    await assert.rejects(captureScreen(denied), e => e.name === 'NotAllowedError');
    await assert.rejects(captureScreen({}), e => e.code === 'unsupported');
    await assert.rejects(captureScreen(undefined), e => e.code === 'unsupported');
    assert.equal(senderSupport({ navigator: {} }), 'display');
    assert.equal(senderSupport({ navigator: { mediaDevices: md } }), 'webrtc');
    assert.equal(senderSupport({ navigator: { mediaDevices: md }, RTCPeerConnection: function () {} }), null);
});

const CODECS = [
    { mimeType: 'video/VP8', clockRate: 90000 },
    { mimeType: 'video/rtx', clockRate: 90000 },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
    { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/red', clockRate: 90000 },
];

test('preferCodec puts H.264 (packetization-mode=1 first) ahead and keeps the rest in order', () => {
    const out = preferCodec(CODECS);
    assert.deepEqual(out.map(c => c.mimeType + (c.sdpFmtpLine && c.mimeType === 'video/H264' ? /mode=1/.test(c.sdpFmtpLine) ? '/1' : '/0' : '')),
        ['video/H264/1', 'video/H264/0', 'video/VP8', 'video/rtx', 'video/VP9', 'video/red']);
    assert.equal(out.length, CODECS.length);
    assert.deepEqual(preferCodec(CODECS.filter(c => c.mimeType !== 'video/H264')).map(c => c.mimeType), ['video/VP8', 'video/rtx', 'video/VP9', 'video/red']);
    assert.deepEqual(preferCodec(null), []);
});

test('preferH264 only reorders when this browser can send H.264, and never throws', () => {
    const tr = { prefs: null, setCodecPreferences(c) { this.prefs = c; } };
    const caps = list => ({ getCapabilities: () => ({ codecs: list }) });
    assert.equal(preferH264(tr, { RTCRtpReceiver: caps(CODECS), RTCRtpSender: caps(CODECS) }), true);
    assert.equal(tr.prefs[0].mimeType, 'video/H264');
    // Decode-only H.264 (not in the sender list) is left out, so the offer never promises it.
    const noSend = CODECS.filter(c => c.mimeType !== 'video/H264');
    const tr2 = { prefs: null, setCodecPreferences(c) { this.prefs = c; } };
    assert.equal(preferH264(tr2, { RTCRtpReceiver: caps(CODECS), RTCRtpSender: caps(noSend) }), false);
    assert.equal(tr2.prefs, null);
    const boom = { setCodecPreferences() { throw new Error('InvalidModificationError'); } };
    assert.equal(preferH264(boom, { RTCRtpReceiver: caps(CODECS), RTCRtpSender: caps(CODECS) }), false);
    assert.equal(preferH264({}, {}), false);
});

test('tuneSender caps the encoder at 15 Mbps and 60 fps and keeps the resolution', async () => {
    let params = { transactionId: 't1', encodings: [{ active: true }] };
    const sender = { getParameters: () => JSON.parse(JSON.stringify(params)), setParameters: async p => { params = p; } };
    assert.equal(await tuneSender(sender), true);
    assert.equal(params.encodings[0].maxBitrate, MAX_BITRATE);
    assert.equal(params.encodings[0].maxFramerate, MAX_FPS);
    assert.equal(MAX_BITRATE, 15000000);
    assert.equal(MAX_FPS, 60);
    assert.equal(DEGRADATION, 'maintain-resolution');
    assert.equal(CONTENT_HINT, 'detail');
    assert.equal(params.degradationPreference, 'maintain-resolution');
    assert.equal(params.encodings[0].priority, 'high');
    assert.equal(params.encodings[0].networkPriority, 'high');
    // A browser that rejects only the priorities still keeps the resolution.
    let p1 = { encodings: [{}] };
    const noPrio = { getParameters: () => JSON.parse(JSON.stringify(p1)),
        setParameters: async p => { if (p.encodings[0].networkPriority) throw new Error('InvalidModificationError'); p1 = p; } };
    assert.equal(await tuneSender(noPrio), true);
    assert.equal(p1.degradationPreference, 'maintain-resolution');
    assert.equal(p1.encodings[0].maxBitrate, 15000000);
    assert.equal(p1.encodings[0].networkPriority, undefined);
    // A browser that rejects the newer fields still gets the caps.
    let p2 = { encodings: [{}] };
    const picky = { getParameters: () => JSON.parse(JSON.stringify(p2)),
        setParameters: async p => { if (p.degradationPreference || p.encodings[0].networkPriority) throw new Error('InvalidModificationError'); p2 = p; } };
    assert.equal(await tuneSender(picky), true);
    assert.equal(p2.encodings[0].maxBitrate, 15000000);
    assert.equal(p2.degradationPreference, undefined);
    assert.equal(await tuneSender({ getParameters: () => ({ encodings: [{}] }), setParameters: async () => { throw new Error('no'); } }), false);
    assert.equal(await tuneSender({ getParameters: () => ({ encodings: [] }), setParameters: async () => {} }), false);
    assert.equal(await tuneSender(null), false);
});

// ---------- CastSender state machine with a scripted peer connection ----------

class FakeTrack extends EventTarget {
    constructor(kind) { super(); this.kind = kind; this.contentHint = ''; this.readyState = 'live'; }
    stop() { this.readyState = 'ended'; }
}

class FakeStream {
    constructor() { this.tracks = [new FakeTrack('video'), new FakeTrack('audio')]; }
    getTracks() { return this.tracks.slice(); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
}

class FakeDC extends EventTarget {
    constructor() { super(); this.readyState = 'connecting'; this.sent = []; }
    send(d) { this.sent.push(d); }
    _open() { this.readyState = 'open'; this.dispatchEvent(new Event('open')); }
    _close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}

class FakePC extends EventTarget {
    constructor(cfg) {
        super();
        FakePC.last = this;
        this.cfg = cfg;
        this.connectionState = 'new';
        this.iceGatheringState = 'new';
        this.signalingState = 'stable';
        this.transceivers = [];
        this.offers = 0;
        this.closed = false;
    }
    addTransceiver(track, init) {
        let params = { encodings: JSON.parse(JSON.stringify(init.sendEncodings || [{}])) };
        const sender = { track, getParameters: () => JSON.parse(JSON.stringify(params)), setParameters: async p => { params = p; } };
        const tr = { sender, init, setCodecPreferences() {} };
        this.transceivers.push(tr);
        return tr;
    }
    createDataChannel() { this.dc = new FakeDC(); return this.dc; }
    async createOffer(o) { this.offers++; return { type: 'offer', sdp: 'v=0\r\no=fake ' + this.offers + (o && o.iceRestart ? ' restart' : '') + '\r\n' }; }
    async setLocalDescription(d) { this.localDescription = d; this.signalingState = 'have-local-offer'; this.iceGatheringState = 'complete'; }
    async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = 'stable'; }
    close() { this.closed = true; this.connectionState = 'closed'; }
    async getStats() { return new Map((this.stats || []).map(s => [s.id, s])); }
    _conn(s) { this.connectionState = s; this.dispatchEvent(new Event('connectionstatechange')); }
}

/** A TvLink, the fake TV and a scripted receiver that answers every offer over the relay. */
async function castRig({ tvReplies = true } = {}) {
    FakePC.last = null;
    const { relay, FakeES, fetch } = makeRelay();
    const topic = await otv.deriveTopic(CODE);
    const { createFakeTv } = await import('./fake-tv.mjs');
    const tv = await createFakeTv({ code: CODE, name: 'Board Room', publish: (t, env) => relay.publish(t, env), silent: !tvReplies });
    if (!relay.subs.has(topic)) relay.subs.set(topic, new Set());
    relay.subs.get(topic).add(ev => tv.handle(ev));
    const offers = [];
    tv.oncast = session => {
        const rx = new CastChannel({ code: CODE, relay: RELAY, session, out: 'r2c', since: '5m', fetch, EventSource: FakeES });
        rx.onsignal = async (cast, data) => {
            if (cast !== 'offer') return;
            const d = await decodeSignal(data);
            offers.push(d.sdp);
            await rx.send('answer', await encodeSignal({ type: 'answer', sdp: 'v=0\r\no=answer ' + offers.length + '\r\n' }));
        };
        rx.init();
        tv.rx = rx;
    };
    const link = new otv.TvLink({ code: CODE, relay: RELAY, fetch, EventSource: FakeES });
    const states = [];
    const sender = new CastSender({
        link, RTCPeerConnection: FakePC, window: {}, dropMs: 200, reconnectTimeoutMs: 600, ackTimeoutMs: 600,
        onstate: (s, d) => states.push(d && (d.reason || d.code) ? s + ':' + (d.reason || d.code) : s),
    });
    return { relay, tv, link, sender, states, offers, stream: new FakeStream() };
}

async function untilTrue(fn, ms = 2000) {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error('timed out');
        await sleep(5);
    }
}

test('sender: cast start, offer, answer, sharing; stop says bye on the data channel', async () => {
    const { relay, tv, link, sender, states, offers, stream } = await castRig();
    sender.start(stream);
    await untilTrue(() => FakePC.last && FakePC.last.remoteDescription);
    const pc = FakePC.last;
    assert.equal(stream.getVideoTracks()[0].contentHint, 'detail');
    const [vt, at] = pc.transceivers;
    assert.equal(vt.init.direction, 'sendonly');
    assert.deepEqual(vt.init.sendEncodings, [{ maxBitrate: 15000000, maxFramerate: 60, scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high' }]);
    assert.equal(at.init.sendEncodings, undefined);
    assert.equal(sender.state, 'connecting');
    pc.dc._open();
    pc._conn('connected');
    assert.equal(sender.state, 'sharing');
    assert.deepEqual(states, ['starting', 'waiting', 'connecting', 'sharing']);
    assert.equal(offers.length, 1);
    assert.equal(tv.received('cast')[0].args.action, 'start');
    const posts = relay.posts.length;
    assert.equal(posts, 3, 'posted: cast command, offer, answer (the fake TV publishes its ack directly)');
    assert.equal(tv.acks.length, 1);
    sender.stop('user');
    assert.deepEqual(pc.dc.sent, ['bye']);
    assert.equal(states.slice(-1)[0], 'stopped:user');
    assert.ok(stream.tracks.every(t => t.readyState === 'ended'), 'capture stopped');
    await sleep(350);
    assert.ok(pc.closed);
    assert.equal(relay.posts.length, posts, 'stop used no relay message');
    assert.equal(link.suspend(), true, 'the session let go of the link');
    link.close();
    tv.rx.close();
});

test('sender: a drop reconnects once (ICE restart over the relay); a second drop ends with "lost"', async () => {
    const { relay, tv, link, sender, states, offers, stream } = await castRig();
    sender.start(stream);
    await untilTrue(() => FakePC.last && FakePC.last.remoteDescription);
    const pc = FakePC.last;
    pc.dc._open();
    pc._conn('connected');
    const before = relay.posts.length;
    pc._conn('disconnected');
    await sleep(20);
    assert.equal(sender.state, 'sharing', 'a short hiccup is ignored');
    await untilTrue(() => sender.state === 'reconnecting');
    await untilTrue(() => offers.length === 2);
    assert.match(offers[1], /restart/);
    await untilTrue(() => pc.remoteDescription.sdp.includes('answer 2'));
    pc._conn('connected');
    assert.equal(sender.state, 'sharing');
    assert.equal(relay.posts.length - before, 2, 'reconnect = offer + answer');
    pc._conn('failed');
    await untilTrue(() => sender.state === 'error');
    assert.deepEqual(states, ['starting', 'waiting', 'connecting', 'sharing', 'reconnecting', 'sharing', 'error:lost']);
    assert.equal(sender.reconnects, 1);
    link.close();
    tv.rx.close();
});

test('sender: the TV closing the receiver ends with reason "tv"; a receiver bye before connecting is an error', async () => {
    let { tv, link, sender, states, stream } = await castRig();
    sender.start(stream);
    await untilTrue(() => FakePC.last && FakePC.last.remoteDescription);
    let pc = FakePC.last;
    pc.dc._open();
    pc._conn('connected');
    pc.dc._close();
    assert.equal(states.slice(-1)[0], 'stopped:tv');
    assert.deepEqual(pc.dc.sent, [], 'no bye back to a TV that left');
    link.close();
    tv.rx.close();

    ({ tv, link, sender, states, stream } = await castRig());
    tv.oncast = session => {
        const rx = new CastChannel({ code: CODE, relay: RELAY, session, out: 'r2c', since: '5m', fetch: link._fetch, EventSource: link._ES });
        rx.onsignal = cast => { if (cast === 'offer') rx.send('bye', 'error'); };
        rx.init();
        tv.rx = rx;
    };
    sender.start(stream);
    await untilTrue(() => sender.state === 'error');
    assert.equal(states.slice(-1)[0], 'error:tv_error');
    link.close();
    tv.rx.close();
});

test('sender: no connection after the answer ends with "ice" in good time', async () => {
    const { tv, link, states, stream } = await castRig();
    const sender = new CastSender({ link, RTCPeerConnection: FakePC, window: {}, connectTimeoutMs: 300, onstate: (s, d) => states.push(d && d.code ? s + ':' + d.code : s) });
    sender.start(stream);
    await untilTrue(() => sender.state === 'error', 3000);
    assert.deepEqual(states, ['starting', 'waiting', 'connecting', 'error:ice']);
    link.close();
    tv.rx.close();
});

test('sender: TV not answering times out; cancelling while the TV opens the receiver closes it again', async () => {
    let { relay, tv, link, sender, states, stream } = await castRig({ tvReplies: false });
    sender.start(stream);
    await untilTrue(() => sender.state === 'error', 3000);
    assert.equal(states.slice(-1)[0], 'error:timeout');
    assert.equal(tv.received('cast').length, 1);
    assert.equal(relay.posts.length, 1, 'no offer is published when the TV never answered');
    link.close();

    ({ relay, tv, link, sender, states, stream } = await castRig());
    tv.oncast = () => {};
    tv.delayMs = 50;
    sender.start(stream);
    await untilTrue(() => sender.state === 'waiting');
    sender.stop('user');
    assert.equal(states.slice(-1)[0], 'stopped:user');
    await untilTrue(() => tv.received('cast').length === 2);
    assert.deepEqual(tv.received('cast').map(c => c.args.action), ['start', 'stop']);
    link.close();
});

// ---------- connection info: the TV's numbers over the data channel ----------

const dcMessage = data => Object.assign(new Event('message'), { data });

test('sender: the TV\'s stats arrive over the data channel (no relay); connectionInfo() combines both sides', async () => {
    const { relay, tv, link, sender, stream } = await castRig();
    sender.start(stream);
    await untilTrue(() => FakePC.last && FakePC.last.remoteDescription);
    const pc = FakePC.last;
    pc.dc._open();
    pc._conn('connected');
    assert.equal(sender.state, 'sharing');
    pc.stats = [
        { id: 'c', type: 'codec', mimeType: 'video/H264' },
        { id: 'o', type: 'outbound-rtp', kind: 'video', timestamp: 1000, ssrc: 1, codecId: 'c', frameWidth: 2560, frameHeight: 1440, framesPerSecond: 30,
            bytesSent: 100, framesEncoded: 10, totalEncodeTime: 0.08, packetsSent: 10, totalPacketSendDelay: 0.05, encoderImplementation: 'ExternalEncoder', qualityLimitationReason: 'none' },
        { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
        { id: 'p', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: 0.004 },
        { id: 'l', type: 'local-candidate', candidateType: 'host' },
        { id: 'r', type: 'remote-candidate', candidateType: 'host' },
    ];
    let info = await sender.connectionInfo();
    assert.equal(info.rx, null);
    assert.equal(info.verdict.text, 'Direct connection · H.264 hardware');
    assert.equal(info.rows.find(r => r.k === 'res').value, '2560 x 1440');
    const posts = relay.posts.length;
    pc.dc.dispatchEvent(dcMessage(JSON.stringify({ type: 'stats', v: 1, codec: 'video/H264', fps: 30, framesDropped: 0, dropPct: 0, decoder: 'ExternalDecoder',
        powerEfficientDecoder: true, hardware: true, hardwareFrom: 'stats', jitterMs: 10, decodeMs: 6, rttMs: 4, tvMs: 60, tvMsFrom: 'measured', delayMs: 62, screen: '3840x2160' })));
    pc.dc.dispatchEvent(dcMessage('not json'));
    pc.dc.dispatchEvent(dcMessage('{"type":"hello"}'));
    assert.equal(sender.rxStatsCount, 1);
    assert.equal(sender.rxStats.decoder, 'ExternalDecoder');
    info = await sender.connectionInfo();
    // laptop 17 + 8 + 5, network 2, TV 60 = 92 ms
    assert.equal(info.verdict.text, 'Direct connection · H.264 hardware · ~90 ms delay');
    assert.equal(info.rows.find(r => r.k === 'tvdecoder').value, 'ExternalDecoder · hardware');
    assert.equal(relay.posts.length, posts, 'no relay messages for stats');
    // Stale numbers from the TV are not shown.
    sender.rxStatsAt -= 10000;
    assert.equal((await sender.connectionInfo()).rx, null);
    assert.equal(sender.state, 'sharing', 'stats never stop sharing');
    pc.dc.dispatchEvent(dcMessage('bye'));
    assert.equal(sender.state, 'stopped');
    assert.equal(await sender.connectionInfo(), null, 'nothing after stopping');
    link.close();
    tv.rx.close();
});

test('fitScale: the picture is sent at the TV screen size, never bigger; odd sizes keep the full picture', () => {
    assert.equal(fitScale(2560, 1440, '1920x1080'), 1.33);
    assert.equal(fitScale(2880, 1800, '1920x1080'), 1.67);
    assert.equal(fitScale(1920, 1080, '1920x1080'), 1);
    assert.equal(fitScale(1920, 1080, '3840x2160'), 1, 'a bigger TV never enlarges');
    assert.equal(fitScale(1980, 1100, '1920x1080'), 1, 'within 5 %: keep');
    assert.equal(fitScale(2560, 1440, '1080x1920'), 2.37, 'portrait panel: fits the width');
    assert.equal(fitScale(2560, 1440, '320x240'), 1);
    assert.equal(fitScale(2560, 1440, ''), 1);
    assert.equal(fitScale(2560, 1440, undefined), 1);
    assert.equal(fitScale(2560, 1440, '1920x1080; x'), 1);
    assert.equal(fitScale(0, 0, '1920x1080'), 1);
    assert.equal(fitScale(undefined, undefined, '1920x1080'), 1);
    assert.equal(fitScale(7680, 4320, '1280x720'), 4, 'at most 4x');
});

test('sender: the TV\'s screen size from its stats scales the picture to fit, once per change', async () => {
    const { tv, link, sender, stream } = await castRig();
    let size = { width: 2560, height: 1440 };
    stream.tracks[0].getSettings = () => size;
    sender.start(stream);
    await untilTrue(() => FakePC.last && FakePC.last.remoteDescription);
    const pc = FakePC.last;
    pc.dc._open();
    pc._conn('connected');
    const vs = sender.videoSender;
    let sets = 0;
    const origSet = vs.setParameters;
    vs.setParameters = async p => { sets++; return origSet(p); };
    const stats = screen => pc.dc.dispatchEvent(dcMessage(JSON.stringify({ type: 'stats', v: 1, fps: 30, screen })));
    stats('1920x1080');
    await untilTrue(() => sets === 1);
    await sleep(5);
    assert.equal(vs.getParameters().encodings[0].scaleResolutionDownBy, 1.33);
    assert.equal(vs.getParameters().encodings[0].maxBitrate, MAX_BITRATE, 'other encoder settings stay');
    stats('1920x1080');
    await sleep(20);
    assert.equal(sets, 1, 'same size: no new setParameters');
    size = { width: 1920, height: 1080 }; // the shared window got smaller
    stats('1920x1080');
    await untilTrue(() => sets === 2);
    await sleep(5);
    assert.equal(vs.getParameters().encodings[0].scaleResolutionDownBy, 1);
    // A browser that refuses the change keeps sharing at full size and is not asked again every 2 s.
    size = { width: 3840, height: 2160 };
    vs.setParameters = async () => { sets++; throw new Error('InvalidModificationError'); };
    stats('1920x1080');
    await untilTrue(() => sets === 3);
    await sleep(5);
    stats('1920x1080');
    await sleep(20);
    assert.equal(sets, 3);
    assert.equal(sender.state, 'sharing');
    sender.stop('user');
    link.close();
    tv.rx.close();
});

test('sender: a busy computer steps the frame rate down (60, 30, 20, 15) and a calm one may step back up', async () => {
    const { tv, link, sender, stream } = await castRig();
    sender.start(stream);
    await untilTrue(() => FakePC.last && FakePC.last.remoteDescription);
    const pc = FakePC.last;
    pc.dc._open();
    pc._conn('connected');
    assert.equal(sender.state, 'sharing');
    assert.deepEqual(FPS_STEPS, [60, 30, 20, 15]);
    assert.equal(sender.fpsLevel, 60);
    const calls = [];
    sender.steady = { setFps: n => calls.push(n), stop() {} };
    let n = 0;
    const stat = (limit, encMs) => {
        n++;
        pc.stats = [
            { id: 'c', type: 'codec', mimeType: 'video/H264' },
            { id: 'o', type: 'outbound-rtp', kind: 'video', timestamp: 1000 + n * 3000, ssrc: 1, codecId: 'c', frameWidth: 1366, frameHeight: 768,
                framesPerSecond: 40, bytesSent: n * 1e6, framesEncoded: n * 100, totalEncodeTime: n * 100 * encMs / 1000,
                packetsSent: n * 100, totalPacketSendDelay: 0, qualityLimitationReason: limit },
        ];
    };
    sender._stopAdaptTimerForTest = true;
    clearInterval(sender._adaptTimer);
    // Two busy readings in a row step down once; one is not enough.
    stat('cpu', 10); await sender._adapt();
    assert.equal(sender.fpsLevel, 60, 'one busy reading is not enough');
    stat('cpu', 10); await sender._adapt();
    assert.equal(sender.fpsLevel, 30);
    assert.deepEqual(calls, [30]);
    assert.equal(sender.videoSender.getParameters().encodings[0].maxFramerate, 30, 'the encoder is asked for 30 fps');
    // Encoding slower than 80 % of the frame budget counts as busy even without "cpu".
    stat('none', 30); await sender._adapt();
    stat('none', 30); await sender._adapt();
    assert.equal(sender.fpsLevel, 20);
    for (let i = 0; i < 4; i++) { stat('cpu', 10); await sender._adapt(); }
    assert.equal(sender.fpsLevel, 15);
    for (let i = 0; i < 6; i++) { stat('cpu', 10); await sender._adapt(); }
    assert.equal(sender.fpsLevel, 15, 'never below 15');
    // A long calm stretch with cheap frames steps up one level.
    for (let i = 0; i < 14; i++) { stat('none', 2); await sender._adapt(); }
    assert.equal(sender.fpsLevel, 20);
    assert.equal(calls[calls.length - 1], 20);
    assert.equal(sender.state, 'sharing');
    sender.stop('user');
    link.close();
    tv.rx.close();
});

test('receiver: sends a stats message over the data channel every statsMs while it is open', async () => {
    const rx = new CastReceiver({ code: CODE, relay: RELAY, session: SESSION, statsMs: 25, window: {},
        extraStats: () => ({ tvMs: 40, screen: '1920x1080' }) });
    let n = 0;
    rx.pc = { getStats: async () => { n++; return [
        { id: 'c', type: 'codec', mimeType: 'video/H264' },
        { id: 'i', type: 'inbound-rtp', kind: 'video', timestamp: 1000 + n * 25, ssrc: 1, codecId: 'c', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 30,
            framesDecoded: 30 * n, framesDropped: 0, jitterBufferDelay: 0.3 * n, jitterBufferEmittedCount: 30 * n, totalDecodeTime: 0.15 * n },
    ]; } };
    const dc = new FakeDC();
    rx._watchChannel(dc);
    await sleep(80);
    assert.equal(dc.sent.length, 0, 'nothing before the channel opens');
    dc._open();
    await untilTrue(() => dc.sent.length >= 2);
    const m = JSON.parse(dc.sent[dc.sent.length - 1]);
    assert.equal(m.type, 'stats');
    assert.equal(m.fps, 30);
    assert.equal(m.jitterMs, 10);
    assert.equal(m.decodeMs, 5);
    assert.equal(m.tvMs, 40);
    assert.equal(m.tvMsFrom, 'measured');
    assert.equal(m.screen, '1920x1080');
    assert.equal(m.hardware, null, 'no decoder name, no mediaCapabilities in this fake window');
    assert.equal(rx.statsSent, dc.sent.length);
    assert.ok(rx.lastStats.length < 600);
    // 'bye' ends the session and the timer.
    dc.dispatchEvent(dcMessage('bye'));
    assert.equal(rx.state, 'ended');
    const sent = dc.sent.length;
    await sleep(80);
    assert.equal(dc.sent.length, sent, 'no stats after the end');
});

// ---------- latency tuning ----------

test('receiverCodecOrder: H.264 pm=1 constrained baseline first, then other H.264, VP8, VP9, the rest', () => {
    const list = [
        { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=0' },
        { mimeType: 'video/AV1' },
        { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
        { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' },
        { mimeType: 'video/VP8' },
        { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
        { mimeType: 'video/rtx' },
    ];
    const out = receiverCodecOrder(list).map(c => c.mimeType + ' ' + (c.sdpFmtpLine || ''));
    assert.deepEqual(out, [
        'video/H264 ' + list[5].sdpFmtpLine, 'video/H264 ' + list[3].sdpFmtpLine, 'video/H264 ' + list[2].sdpFmtpLine,
        'video/VP8 ', 'video/VP9 profile-id=0', 'video/AV1 ', 'video/rtx ',
    ]);
    assert.deepEqual(receiverCodecOrder(null), []);
});

test('preferReceiveCodecs sets the order on video transceivers only, and never throws', () => {
    const mk = kind => ({ receiver: { track: { kind } }, prefs: null, setCodecPreferences(c) { this.prefs = c; } });
    const v = mk('video'), a = mk('audio');
    const pc = { getTransceivers: () => [a, v] };
    const w = { RTCRtpReceiver: { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1' }] }) } };
    assert.equal(preferReceiveCodecs(pc, w), true);
    assert.equal(v.prefs[0].mimeType, 'video/H264');
    assert.equal(a.prefs, null);
    assert.equal(preferReceiveCodecs({ getTransceivers: () => [{ receiver: { track: { kind: 'video' } }, setCodecPreferences() { throw new Error('x'); } }] }, w), false);
    assert.equal(preferReceiveCodecs(pc, {}), false);
    assert.equal(preferReceiveCodecs(null, w), false);
});

test('lowLatencyReceiver sets jitterBufferTarget / playoutDelayHint to 0 when supported', () => {
    const modern = { jitterBufferTarget: null, playoutDelayHint: null };
    assert.equal(lowLatencyReceiver(modern), 'jitterBufferTarget');
    assert.equal(modern.jitterBufferTarget, 0);
    assert.equal(modern.playoutDelayHint, 0);
    const legacy = { playoutDelayHint: null };
    assert.equal(lowLatencyReceiver(legacy), 'playoutDelayHint');
    assert.equal(legacy.playoutDelayHint, 0);
    assert.equal('jitterBufferTarget' in legacy, false);
    assert.equal(lowLatencyReceiver({}), '');
    assert.equal(lowLatencyReceiver(null), '');
    const ro = {};
    Object.defineProperty(ro, 'jitterBufferTarget', { get: () => null, set: () => { throw new Error('ro'); } });
    assert.equal(lowLatencyReceiver(ro), '');
});

test('iceGathered finishes early on host + srflx, or after ICE_WAIT_MS (1.5 s)', async () => {
    assert.equal(ICE_WAIT_MS, 1500);
    const pc = new EventTarget();
    pc.iceGatheringState = 'gathering';
    const t0 = Date.now();
    const p = iceGathered(pc);
    const cand = (type, line) => { const e = new Event('icecandidate'); e.candidate = { type, candidate: line || '' }; pc.dispatchEvent(e); };
    cand('host');
    cand(undefined, 'candidate:1 1 udp 1 1.2.3.4 5 typ srflx raddr 0.0.0.0 rport 0');
    assert.equal(await p, true);
    assert.ok(Date.now() - t0 < 200);
    const pc2 = new EventTarget();
    pc2.iceGatheringState = 'gathering';
    const t1 = Date.now();
    const p2 = iceGathered(pc2, 120);
    const e = new Event('icecandidate'); e.candidate = { type: 'host' }; pc2.dispatchEvent(e);
    assert.equal(await p2, false);
    assert.ok(Date.now() - t1 >= 100);
});
