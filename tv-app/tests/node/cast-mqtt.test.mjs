// Screen sharing signaling with a 4-digit code (PROTOCOL.md section 8): MQTT keeps no history and the TV page
// subscribes after the laptop sent its offer, so the receiver says 'ready', the laptop sends the SAME offer again
// (on 'ready' and every 2 s until the answer) and the receiver answers only the first copy. Real WebSockets to
// the fake brokers (fake-mqtt.mjs), an in-memory ntfy (fake-ntfy.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as otv from '../../../tv/otv.js';
import { CastChannel, CastReceiver, OFFER_EVERY_MS, OFFER_MAX, READY_MAX, decodeSignal, encodeSignal } from '../../../tv/cast.js';
import { startFakeMqtt } from './fake-mqtt.mjs';
import { makeNtfy } from './fake-ntfy.mjs';

const CODE = '0427';
const NTFY = 'https://ntfy.test';
const SESSION = 'abcdefghij0123456';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OFFER = 'j' + JSON.stringify({ type: 'offer', sdp: 'v=0\r\no=laptop 1\r\n' });
const ANSWER = 'j' + JSON.stringify({ type: 'answer', sdp: 'v=0\r\no=tv 1\r\n' });

async function until(fn, ms = 3000, what = 'condition') {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error('timed out waiting for ' + what);
        await sleep(5);
    }
}

async function rig({ brokers = 2 } = {}) {
    const bs = [];
    for (let i = 0; i < brokers; i++) bs.push(await startFakeMqtt());
    const ntfy = makeNtfy();
    const topic = await otv.deriveTopic(CODE);
    const mtopic = 'officetv/' + topic;
    const urls = bs.map(b => b.url);
    const link = new otv.TvLink({ code: CODE, relay: NTFY, fetch: ntfy.fetch, EventSource: ntfy.EventSource, brokers: urls });
    const opened = [];
    /** The TV page's channel (its own relay connections), created when the test says the page has loaded. */
    const receiver = (opts = {}) => {
        const ch = new CastChannel(Object.assign({
            code: CODE, relay: NTFY, session: SESSION, out: 'r2c', since: '5m', announce: true,
            fetch: ntfy.fetch, EventSource: ntfy.EventSource, brokers: urls,
        }, opts));
        opened.push(ch);
        return ch;
    };
    const close = async () => {
        for (const ch of opened) ch.close();
        link.close();
        for (const b of bs) await b.close();
    };
    /** Plaintext of every message published over a broker / ntfy with this cast. */
    const key = await otv.deriveKey(CODE);
    const onWire = async (list, cast) => {
        const out = [];
        for (const text of list) {
            const m = await otv.open(key, topic, text);
            if (m && m.cast === cast) out.push(m);
        }
        return out;
    };
    return { bs, ntfy, topic, mtopic, link, receiver, close, onWire, urls };
}

test('the TV page subscribes after the offer went out over MQTT: its "ready" brings the same offer again', async () => {
    const { bs, ntfy, mtopic, link, receiver, close, onWire } = await rig();
    try {
        assert.equal(OFFER_EVERY_MS, 2000);
        assert.equal(OFFER_MAX, 15);
        assert.equal(READY_MAX, 15);
        const tx = new CastChannel({ link, session: SESSION, out: 'c2r' });
        const txGot = [];
        const readies = [];
        tx.onsignal = (c, d, meta) => txGot.push([c, d, meta.via]);
        tx.onready = meta => readies.push(meta.via);
        await tx.init();
        assert.equal(await tx.waitOpen(3000), true);
        await until(() => link.transport.mqttCount === 2, 3000, 'laptop brokers');
        assert.equal(await tx.offer(OFFER), 1);
        await sleep(150); // nobody listens yet: this copy is lost (MQTT has no history)
        const rx = receiver();
        const rxGot = [];
        rx.onsignal = (c, d, meta) => rxGot.push([c, d, meta.via]);
        const t0 = Date.now();
        await rx.init();
        await until(() => rxGot.length >= 1, 3000, 'offer at the TV');
        assert.ok(Date.now() - t0 < 1500, 'right after "ready", not after the 2 s repeat');
        assert.deepEqual(rxGot, [['offer', OFFER, 'mqtt']]);
        assert.ok(readies.length >= 1 && readies[0] === 'mqtt');
        assert.ok(tx.readyCount >= 1);
        assert.ok(rx.readySent >= 1);
        // Every copy of the offer is the SAME envelope, so every receiver sees it once.
        const copies = bs[0].published.of(mtopic).map(p => p.text);
        const offerCopies = await onWire(copies, 'offer');
        assert.ok(offerCopies.length >= 2);
        assert.equal(new Set(offerCopies.map(m => m.id)).size, 1, 'same message id');
        const texts = [];
        for (const t of copies) if ((await onWire([t], 'offer')).length) texts.push(t);
        assert.equal(new Set(texts).size, 1, 'the same envelope text each time');
        await rx.send('answer', ANSWER);
        await until(() => txGot.length === 1, 3000, 'answer at the laptop');
        assert.deepEqual(txGot, [['answer', ANSWER, 'mqtt']]);
        const sent = tx.offersSent;
        const readySent = rx.readySent;
        await sleep(OFFER_EVERY_MS + 400);
        assert.equal(tx.offersSent, sent, 'no repeats after the answer');
        assert.equal(rx.readySent, readySent, 'no "ready" after the offer');
        assert.equal(rxGot.length, 1, 'the TV saw the offer once');
        assert.equal(ntfy.posts.length, 0, 'nothing over ntfy (no daily quota used)');
    } finally {
        await close();
    }
});

test('without "ready" the offer repeats every 2 s, at most 15 times, over MQTT only', async () => {
    const { bs, ntfy, mtopic, link, close, onWire } = await rig({ brokers: 1 });
    try {
        const tx = new CastChannel({ link, session: SESSION, out: 'c2r', repeatMs: 30 });
        await tx.init();
        await tx.waitOpen(3000);
        await until(() => link.transport.mqttCount === 1, 3000, 'broker');
        await tx.offer(OFFER);
        await sleep(30 * (OFFER_MAX + 6));
        await until(() => tx.offersSent === 1 + OFFER_MAX, 2000, 'all repeats');
        await sleep(200);
        assert.equal(tx.offersSent, 1 + OFFER_MAX);
        const offers = await onWire(bs[0].published.of(mtopic).map(p => p.text), 'offer');
        assert.equal(offers.length, 1 + OFFER_MAX);
        assert.equal(ntfy.posts.length, 0);
        // stopOffer() ends them early.
        const tx2 = new CastChannel({ link, session: 'zyxwvutsrq0123456', out: 'c2r', repeatMs: 30 });
        await tx2.init();
        await tx2.offer(OFFER);
        tx2.stopOffer();
        const n = tx2.offersSent;
        await sleep(150);
        assert.equal(tx2.offersSent, n);
        tx.close();
        tx2.close();
    } finally {
        await close();
    }
});

test('a TV page without a broker: one "ready" over ntfy, one ntfy copy of the offer, the answer over ntfy', async () => {
    const { ntfy, topic, link, receiver, close, onWire } = await rig();
    try {
        const tx = new CastChannel({ link, session: SESSION, out: 'c2r' });
        const txGot = [];
        tx.onsignal = (c, d, meta) => txGot.push([c, meta.via]);
        await tx.init();
        await tx.waitOpen(3000);
        await until(() => link.transport.mqttCount === 2, 3000, 'laptop brokers');
        await tx.offer(OFFER);
        const rx = receiver({ brokers: [], repeatMs: 60 });
        const rxGot = [];
        rx.onsignal = async (c, d, meta) => {
            rxGot.push([c, meta.via]);
            if (c === 'offer') await rx.send('answer', ANSWER);
        };
        await rx.init();
        await until(() => txGot.length === 1, 3000, 'answer');
        assert.deepEqual(rxGot, [['offer', 'ntfy']]);
        assert.deepEqual(txGot, [['answer', 'ntfy']], 'the reply went back the way the offer came');
        await sleep(300);
        const bodies = ntfy.postsTo(topic).map(p => p.body);
        assert.equal((await onWire(bodies, 'ready')).length, 1, 'one "ready" over ntfy only');
        assert.equal((await onWire(bodies, 'offer')).length, 1, 'one ntfy copy of the offer');
        assert.equal((await onWire(bodies, 'answer')).length, 1);
        assert.equal(bodies.length, 3);
    } finally {
        await close();
    }
});

test('a laptop without a broker: the offer over ntfy, the TV page replays it (since=5m) and answers over ntfy', async () => {
    const { bs, ntfy, topic, link, receiver, close, onWire } = await rig();
    for (const b of bs) b.down = true;
    try {
        const tx = new CastChannel({ link, session: SESSION, out: 'c2r' });
        const txGot = [];
        tx.onsignal = (c, d, meta) => txGot.push([c, meta.via]);
        await tx.init();
        assert.equal(await tx.waitOpen(3000), true);
        await tx.offer(OFFER);
        await sleep(100);
        for (const b of bs) b.down = false;
        const rx = receiver();
        rx.onsignal = async (c, d, meta) => { if (c === 'offer') await rx.send('answer', ANSWER); };
        await rx.init();
        await until(() => txGot.length === 1, 3000, 'answer');
        assert.deepEqual(txGot, [['answer', 'ntfy']]);
        await sleep(200);
        const bodies = ntfy.postsTo(topic).map(p => p.body);
        assert.equal((await onWire(bodies, 'offer')).length, 1);
        assert.equal((await onWire(bodies, 'ready')).length, 0, 'the replayed offer came first: no "ready" at all');
    } finally {
        await close();
    }
});

test('10-symbol codes (older TVs): no "ready", offer() is one ntfy message, no MQTT', async () => {
    const ntfy = makeNtfy();
    let sockets = 0;
    class NoWS { constructor() { sockets++; throw new Error('no MQTT'); } }
    const code = '7K3M9QX2TD';
    const link = new otv.TvLink({ code, relay: NTFY, fetch: ntfy.fetch, EventSource: ntfy.EventSource, WebSocket: NoWS, brokers: ['ws://127.0.0.1:1/mqtt'] });
    const tx = new CastChannel({ link, session: SESSION, out: 'c2r', repeatMs: 20 });
    const rx = new CastChannel({ code, relay: NTFY, session: SESSION, out: 'r2c', since: '5m', announce: true, repeatMs: 20, fetch: ntfy.fetch, EventSource: ntfy.EventSource, WebSocket: NoWS, brokers: ['ws://127.0.0.1:1/mqtt'] });
    try {
        await tx.init();
        await tx.waitOpen(2000);
        await tx.offer(OFFER);
        await rx.init();
        await sleep(200);
        assert.equal(ntfy.posts.length, 1, 'just the offer: no repeats, no "ready"');
        assert.equal(rx.readySent, 0);
        assert.equal(sockets, 0);
    } finally {
        tx.close();
        rx.close();
        link.close();
    }
});

// ---------- the receiver (tv/receive.js) ----------

class RxPC extends EventTarget {
    constructor() {
        super();
        RxPC.all.push(this);
        this.iceGatheringState = 'new';
        this.connectionState = 'new';
        this.remote = [];
    }
    async setRemoteDescription(d) { this.remote.push(d); }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\no=tv ' + this.remote.length + '\r\na=candidate:1 1 udp 2122260223 4f1d2c3a-1111-2222-3333-444455556666.local 50000 typ host\r\n' }; }
    async setLocalDescription(d) { this.localDescription = d; this.iceGatheringState = 'complete'; }
    getReceivers() { return []; }
    close() { this.connectionState = 'closed'; }
}
RxPC.all = [];

test('receiver: applies only the first offer of the session although it arrives many times (repeats get the same answer); the answer carries the TV address', async () => {
    const { bs, link, close, urls } = await rig();
    RxPC.all = [];
    let rx = null;
    try {
        const tx = new CastChannel({ link, session: SESSION, out: 'c2r', repeatMs: 40 });
        const answers = [];
        tx.onsignal = (c, d) => { if (c === 'answer') answers.push(d); };
        await tx.init();
        await tx.waitOpen(3000);
        await until(() => link.transport.mqttCount === 2, 3000, 'brokers');
        const offer = await encodeSignal({ type: 'offer', sdp: 'v=0\r\no=laptop 7\r\n' });
        await tx.offer(offer);
        // The offer keeps repeating (the answer below stops it only once the laptop has it).
        rx = new CastReceiver({
            code: CODE, relay: NTFY, session: SESSION, ip: '192.168.1.40', RTCPeerConnection: RxPC, brokers: urls,
            fetch: tx.link._fetch, EventSource: tx.link._ES, window: {}, statsMs: 0,
        });
        await rx.start();
        await until(() => answers.length >= 1, 3000, 'answer');
        tx.stopOffer();
        // More copies of the same offer, and another sealing of it: still one answer.
        await tx.send('offer', offer);
        await sleep(300);
        assert.equal(RxPC.all.length, 1, 'one peer connection');
        assert.equal(RxPC.all[0].remote.length, 1, 'the offer was applied once');
        // A repeated offer means the laptop may not have the answer: the same answer goes again (at most every 1.5 s).
        assert.ok(answers.length >= 1 && answers.length <= 3, answers.length + ' answers');
        assert.ok(answers.every(a => a === answers[0]), 'always the same answer');
        assert.equal(rx.offerVia, 'mqtt');
        const desc = await decodeSignal(answers[0]);
        assert.match(desc.sdp, /\.local 50000 typ host/);
        assert.match(desc.sdp, / 192\.168\.1\.40 50000 typ host/, 'the real address next to the mDNS name');
        assert.ok(rx.channel.readySent >= 1);
        assert.equal(bs.length, 2);
    } finally {
        if (rx) rx.end('stopped');
        await close();
    }
});

// ---------- the laptop (CastSender) with a 4-digit code ----------

class TxTrack extends EventTarget {
    constructor(kind) { super(); this.kind = kind; this.contentHint = ''; this.readyState = 'live'; }
    stop() { this.readyState = 'ended'; }
}

class TxStream {
    constructor() { this.tracks = [new TxTrack('video'), new TxTrack('audio')]; }
    getTracks() { return this.tracks.slice(); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
}

class TxDC extends EventTarget {
    constructor() { super(); this.readyState = 'connecting'; this.sent = []; }
    send(d) { this.sent.push(d); }
}

class TxPC extends EventTarget {
    constructor() {
        super();
        TxPC.last = this;
        this.connectionState = 'new';
        this.iceGatheringState = 'new';
    }
    addTransceiver(track) {
        const sender = { track, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} };
        return { sender, setCodecPreferences() {} };
    }
    createDataChannel() { this.dc = new TxDC(); return this.dc; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=laptop 1\r\n' }; }
    async setLocalDescription(d) { this.localDescription = d; this.iceGatheringState = 'complete'; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async getStats() { return new Map(); }
    close() { this.connectionState = 'closed'; }
    _conn(s) { this.connectionState = s; this.dispatchEvent(new Event('connectionstatechange')); }
}

async function senderRig({ tvDelayMs = 15, pageDelayMs = 150 } = {}) {
    const r = await rig();
    const { createFakeTv } = await import('./fake-tv.mjs');
    const topic = r.topic;
    const tv = await createFakeTv({
        code: CODE, name: 'Room 12', delayMs: tvDelayMs,
        publish: (t, env, via) => {
            if (via === 'mqtt') for (const b of r.bs) b.publish(r.mtopic, env);
            else r.ntfy.publish(t, env, { cache: false });
        },
    });
    r.bs.forEach((b, i) => b.subscribe(r.mtopic, text => tv.handle({ event: 'message', message: text }, 'mqtt', 'broker' + i)));
    r.ntfy.subscribe(topic, ev => tv.handle(ev, 'ntfy'));
    const pages = [];
    // Like CastActivity: 'cast start' opens the receiver page, which needs a moment to load.
    tv.oncast = session => setTimeout(() => {
        const ch = r.receiver({ session });
        pages.push(ch);
        ch.onsignal = async (c, d) => {
            if (c !== 'offer') return;
            ch.offers = (ch.offers || 0) + 1;
            await ch.send('answer', ANSWER);
        };
        ch.init();
    }, pageDelayMs);
    const states = [];
    TxPC.last = null;
    const { CastSender } = await import('../../../tv/cast.js');
    const sender = new CastSender({
        link: r.link, RTCPeerConnection: TxPC, window: {}, ackTimeoutMs: 8000, answerTimeoutMs: 5000,
        onstate: (s, d) => states.push(d && (d.reason || d.code) ? s + ':' + (d.reason || d.code) : s),
    });
    return Object.assign(r, { tv, pages, sender, states });
}

test('sender (4-digit code): the offer goes out before the TV acks; the TV page says "ready" and gets it; all over MQTT', async () => {
    // The TV acks 'cast start' only once its screen is open, here after 3.5 s: the page's 'ready' already showed
    // that the TV has the command, so no ntfy copy goes out after 2.5 s.
    const { ntfy, tv, pages, sender, states, close } = await senderRig({ tvDelayMs: 3500 });
    // Like the app: the ack of 'cast start' carries the status object.
    tv.castAck = a => {
        tv.oncast(a.session);
        return { ok: true, msg: 'The TV is ready to show your screen.', data: { name: 'Room 12' } };
    };
    try {
        sender.start(new TxStream());
        await until(() => TxPC.last && TxPC.last.remoteDescription, 5000, 'answer applied');
        assert.equal(tv.acks.length, 0, 'answered before the TV even acked "cast start"');
        assert.equal(pages.length, 1);
        assert.equal(pages[0].offers, 1, 'the TV page answered one offer');
        assert.ok(sender.channel.readyCount >= 1);
        TxPC.last._conn('connected');
        assert.equal(sender.state, 'sharing');
        await until(() => tv.acks.length === 1, 5000, 'the ack');
        await sleep(50);
        assert.equal(sender.tvData.name, 'Room 12', 'the late ack still fills in the TV name');
        assert.equal(sender.state, 'sharing');
        assert.ok(states.indexOf('sharing') > 0, states.join(' '));
        assert.equal(ntfy.posts.length, 0, 'command, ack, offer, ready and answer all over MQTT');
        sender.stop('user');
        assert.equal(states[states.length - 1], 'stopped:user');
        assert.deepEqual(tv.errors, []);
    } finally {
        await close();
    }
});

test('sender (4-digit code): a refusal in the TV\'s ack fails the share although the offer already went out', async () => {
    const { tv, sender, states, close } = await senderRig();
    tv.castAck = () => ({ ok: false, msg: 'The TV needs a one-time setup before it can show your screen.', data: {} });
    try {
        sender.start(new TxStream());
        await until(() => sender.state === 'error', 5000, 'error');
        assert.equal(states[states.length - 1], 'error:tv');
        assert.ok(sender.channel.offersSent >= 1, 'the offer had gone out');
    } finally {
        await close();
    }
});
