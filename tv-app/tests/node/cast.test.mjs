// Share my screen signaling (tv/cast.js): payload encoding, message format, encryption and the relay channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as otv from '../../../tv/otv.js';
import {
    CastChannel, MAX_SIGNAL_PARTS, SIGNAL_CHUNK, SignalAssembler, decodeSignal, encodeSignal, parseReceiverFragment,
    receiverUrl, signalMessages, validSession,
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
    assert.deepEqual(parseReceiverFragment(new URL(u).hash), { session: SESSION, code: CODE, relay: 'https://ntfy.sh' });
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
    await sleep(30);
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
