// tv/mqtt.js: MQTT 3.1.1 packets and framing, the client against an in-memory WebSocket (exact bytes, keep-alive,
// back-off, edge cases) and against the fake broker over a real WebSocket (tests/node/fake-mqtt.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BACKOFF_S, MAX_PACKET, MqttClient, PacketReader, connectPacket, decodeLength, encodeLength, newClientId, parsePublish,
    publishPacket, subscribePacket,
} from '../../../tv/mqtt.js';
import { publishBytes, startFakeMqtt } from './fake-mqtt.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const bytes = s => Array.from(new TextEncoder().encode(s));
const TOPIC = 'officetv/otv2abc';

async function until(fn, ms = 3000, what = 'condition') {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error('timed out waiting for ' + what);
        await sleep(5);
    }
}

/** In-memory WebSocket: records what the client sends; the test delivers bytes and events. */
class FakeWS {
    constructor(url, proto) {
        this.url = url;
        this.proto = proto;
        this.readyState = 0;
        this.sent = [];
        this.closed = false;
        FakeWS.all.push(this);
    }
    send(b) {
        if (this.readyState !== 1) throw new Error('not open');
        this.sent.push(Array.from(b));
    }
    close() { this.readyState = 3; this.closed = true; }
    open() { this.readyState = 1; this.onopen && this.onopen({}); }
    recv(...frames) { for (const f of frames) this.onmessage && this.onmessage({ data: Uint8Array.from(f).buffer }); }
    fail() { this.onerror && this.onerror({}); }
    lastType() { const p = this.sent[this.sent.length - 1]; return p ? p[0] >> 4 : 0; }
}
FakeWS.all = [];

function freshClient(opts = {}) {
    FakeWS.all = [];
    const got = [], states = [], errors = [];
    const c = new MqttClient(Object.assign({
        url: 'wss://broker.test/mqtt', topic: TOPIC, WebSocket: FakeWS, clientId: 'otvabcdefghij012345',
        onmessage: t => got.push(t), onstate: s => states.push(s), onerror: e => errors.push(e),
    }, opts));
    return { c, got, states, errors };
}

/** Starts the client and brings it to "connected" (CONNACK accepted). */
function connected(opts) {
    const r = freshClient(opts);
    r.c.start();
    r.ws = FakeWS.all[0];
    r.ws.open();
    r.ws.recv([0x20, 2, 0, 0]);
    return r;
}

// ---------- packets ----------

test('remaining length: 1 to 4 bytes at every boundary, round trip, malformed and incomplete input', () => {
    const cases = [[0, [0]], [127, [127]], [128, [128, 1]], [16383, [255, 127]], [16384, [128, 128, 1]],
        [2097151, [255, 255, 127]], [2097152, [128, 128, 128, 1]], [268435455, [255, 255, 255, 127]]];
    for (const [n, enc] of cases) {
        assert.deepEqual(encodeLength(n), enc, 'encode ' + n);
        assert.deepEqual(decodeLength(Uint8Array.from([9].concat(enc)), 1), { value: n, bytes: enc.length }, 'decode ' + n);
    }
    assert.throws(() => encodeLength(268435456));
    assert.throws(() => encodeLength(-1));
    assert.throws(() => encodeLength(1.5));
    assert.equal(decodeLength(Uint8Array.of(128, 128)), null, 'needs more bytes');
    assert.equal(decodeLength(Uint8Array.of()), null);
    assert.throws(() => decodeLength(Uint8Array.of(128, 128, 128, 128, 1)), /malformed/);
});

test('CONNECT, SUBSCRIBE and PUBLISH bytes are exactly MQTT 3.1.1 (level 4, clean session, keep-alive 30 s, QoS 0)', () => {
    const id = 'otvabcdefghij012345';
    assert.deepEqual(Array.from(connectPacket(id)),
        [0x10, 10 + 2 + id.length, 0, 4].concat(bytes('MQTT'), [4, 0x02, 0, 30, 0, id.length], bytes(id)));
    assert.deepEqual(Array.from(subscribePacket(1, TOPIC)), [0x82, 2 + 2 + TOPIC.length + 1, 0, 1, 0, TOPIC.length].concat(bytes(TOPIC), [0]));
    assert.deepEqual(Array.from(publishPacket(TOPIC, 'otv1.a.b')), [0x30, 2 + TOPIC.length + 8, 0, TOPIC.length].concat(bytes(TOPIC), bytes('otv1.a.b')));
    // A real envelope (up to 3,900 bytes) needs a 2-byte length.
    const big = publishPacket(TOPIC, 'x'.repeat(3900));
    assert.deepEqual(Array.from(big.subarray(0, 3)), [0x30].concat(encodeLength(2 + TOPIC.length + 3900)));
    assert.equal(big.length, 3 + 2 + TOPIC.length + 3900);
    // UTF-8 payloads keep their bytes.
    const u = parsePublish(0, publishPacket(TOPIC, 'é€').subarray(2));
    assert.equal(new TextDecoder().decode(u.payload), 'é€');
    for (let i = 0; i < 20; i++) assert.match(newClientId(), /^otv[a-z0-9]{16}$/);
    assert.notEqual(newClientId(), newClientId());
});

test('packet reader: a packet split over many frames, several packets in one frame, oversize and malformed input', () => {
    const a = publishPacket(TOPIC, 'first');
    const b = publishPacket(TOPIC, 'y'.repeat(300)); // 2-byte length
    const c = Uint8Array.of(0xd0, 0);                 // PINGRESP (empty body)
    const all = Uint8Array.from([...a, ...b, ...c]);
    // Byte by byte.
    let r = new PacketReader();
    const out = [];
    for (const x of all) out.push(...r.push(Uint8Array.of(x)));
    assert.deepEqual(out.map(p => p.type), [3, 3, 13]);
    assert.equal(new TextDecoder().decode(parsePublish(out[1].flags, out[1].body).payload), 'y'.repeat(300));
    assert.equal(out[2].body.length, 0);
    // All at once, then an unfinished tail kept for the next frame.
    r = new PacketReader();
    assert.equal(r.push(all).length, 3);
    assert.equal(r.push(b.subarray(0, 2)).length, 0);
    const done = r.push(b.subarray(2));
    assert.equal(done.length, 1);
    // Oversize and malformed lengths throw (the client then drops the connection).
    r = new PacketReader();
    assert.throws(() => r.push(Uint8Array.from([0x30].concat(encodeLength(MAX_PACKET + 1)))), /too large/);
    r = new PacketReader();
    assert.throws(() => r.push(Uint8Array.of(0x30, 255, 255, 255, 255, 1)), /malformed/);
    assert.throws(() => parsePublish(6, Uint8Array.of(0, 1, 65)), /malformed/, 'QoS 3');
    assert.throws(() => parsePublish(0, Uint8Array.of(0, 9, 65)), /malformed/, 'topic longer than the packet');
});

// ---------- client (in-memory WebSocket) ----------

test('client: CONNECT on open, SUBSCRIBE after CONNACK (even when CONNACK is split), then connected', () => {
    const { c, states } = freshClient();
    c.start();
    const ws = FakeWS.all[0];
    assert.equal(ws.url, 'wss://broker.test/mqtt');
    assert.equal(ws.proto, 'mqtt');
    assert.equal(ws.binaryType, 'arraybuffer');
    assert.equal(c.publish('x'), false, 'not connected yet');
    ws.open();
    assert.deepEqual(ws.sent, [Array.from(connectPacket('otvabcdefghij012345'))]);
    ws.recv([0x20], [2, 0]);
    assert.equal(c.connected, false, 'half a CONNACK');
    ws.recv([0]);
    assert.equal(c.connected, true);
    assert.deepEqual(ws.sent[1], Array.from(subscribePacket(1, TOPIC)));
    assert.deepEqual(states, [true]);
    assert.equal(c.publish('otv1.x.y'), true);
    assert.deepEqual(ws.sent[2], Array.from(publishPacket(TOPIC, 'otv1.x.y')));
    assert.equal(c.publish(42), false, 'text only');
    c.close();
});

test('client: messages in one frame, across frames, other topics, QoS 1/2 acknowledged but ignored, text frames, Blobs', async () => {
    const { c, ws, got } = connected();
    const p1 = publishPacket(TOPIC, 'one'), p2 = publishPacket(TOPIC, 'two'), p3 = publishPacket(TOPIC, 'z'.repeat(1000));
    ws.recv([...p1, ...p2]);
    ws.recv(p3.subarray(0, 1), p3.subarray(1, 2), p3.subarray(2, 500), p3.subarray(500));
    ws.recv(publishPacket('officetv/other', 'not ours'));
    assert.deepEqual(got, ['one', 'two', 'z'.repeat(1000)]);
    // QoS 1: PUBACK with the packet id, payload not delivered (we subscribe at QoS 0 only).
    ws.recv(publishBytes(TOPIC, 'q1', { qos: 1, id: 0x1234 }));
    assert.deepEqual(ws.sent[ws.sent.length - 1], [0x40, 2, 0x12, 0x34]);
    // QoS 2: PUBREC, and PUBCOMP for the broker's PUBREL.
    ws.recv(publishBytes(TOPIC, 'q2', { qos: 2, id: 7 }));
    assert.deepEqual(ws.sent[ws.sent.length - 1], [0x50, 2, 0, 7]);
    ws.recv([0x62, 2, 0, 7]);
    assert.deepEqual(ws.sent[ws.sent.length - 1], [0x70, 2, 0, 7]);
    assert.deepEqual(got.length, 3);
    // Text frames are not MQTT; a Blob (binaryType not honoured) is read in order.
    ws.onmessage({ data: 'hello' });
    ws.onmessage({ data: new Blob([publishPacket(TOPIC, 'blob')]) });
    await until(() => got.length === 4);
    assert.equal(got[3], 'blob');
    assert.equal(c.connected, true);
    c.close();
});

test('client: keep-alive PINGREQ every 25 s; no PINGRESP within 10 s breaks the connection and reconnects', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { c, ws, states, errors } = connected();
    t.mock.timers.tick(24999);
    assert.notEqual(ws.lastType(), 12);
    t.mock.timers.tick(1);
    assert.deepEqual(ws.sent[ws.sent.length - 1], [0xc0, 0], 'PINGREQ');
    ws.recv([0xd0, 0]);
    t.mock.timers.tick(25000);
    assert.equal(ws.sent.filter(p => p[0] === 0xc0).length, 2);
    t.mock.timers.tick(9999);
    assert.equal(c.connected, true);
    t.mock.timers.tick(1);
    assert.equal(c.connected, false, 'no PINGRESP');
    assert.ok(ws.closed);
    assert.deepEqual(states, [true, false]);
    assert.deepEqual(errors, ['no PINGRESP']);
    assert.equal(FakeWS.all.length, 1);
    t.mock.timers.tick(1000);
    assert.equal(FakeWS.all.length, 2, 'reconnects after 1 s');
    c.close();
});

test('client: back-off 1, 2, 4, 8, 15, 30, 30 s between failures, reset after a CONNACK', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    assert.deepEqual(BACKOFF_S, [1, 2, 4, 8, 15, 30]);
    const { c } = freshClient();
    c.start();
    const waits = [];
    for (const s of [1, 2, 4, 8, 15, 30, 30]) {
        const n = FakeWS.all.length;
        FakeWS.all[n - 1].fail();
        t.mock.timers.tick(s * 1000 - 1);
        assert.equal(FakeWS.all.length, n, 'still waiting before ' + s + ' s');
        t.mock.timers.tick(1);
        assert.equal(FakeWS.all.length, n + 1);
        waits.push(s);
    }
    assert.equal(c.failures, 7);
    const ws = FakeWS.all[FakeWS.all.length - 1];
    ws.open();
    ws.recv([0x20, 2, 0, 0]);
    assert.equal(c.failures, 0);
    ws.fail();
    t.mock.timers.tick(1000);
    assert.equal(FakeWS.all.length, 9, 'back to 1 s after a successful connection');
    c.close();
});

test('client: refused CONNECT, refused SUBSCRIBE, oversized or malformed packets and connect timeout count as broken', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const cases = [
        ['connect refused (5)', ws => { ws.open(); ws.recv([0x20, 2, 0, 5]); }],
        ['subscribe refused', ws => { ws.open(); ws.recv([0x20, 2, 0, 0], [0x90, 3, 0, 1, 0x80]); }],
        ['packet too large', ws => { ws.open(); ws.recv([0x20, 2, 0, 0], [0x30].concat(encodeLength(70000))); }],
        ['malformed remaining length', ws => { ws.open(); ws.recv([0x20, 2, 0, 0], [0x30, 255, 255, 255, 255, 1]); }],
        ['bad packet: malformed publish', ws => { ws.open(); ws.recv([0x20, 2, 0, 0], [0x30, 3, 0, 9, 65]); }],
        ['connect timeout', () => { t.mock.timers.tick(10000); }],
        ['socket closed', ws => { ws.open(); ws.onclose({}); }],
    ];
    for (const [why, act] of cases) {
        const { c, errors } = freshClient();
        c.start();
        const ws = FakeWS.all[0];
        act(ws);
        assert.equal(c.connected, false, why);
        assert.equal(errors[0], why);
        assert.ok(ws.closed, why + ': socket closed');
        t.mock.timers.tick(1000);
        assert.equal(FakeWS.all.length, 2, why + ': reconnects');
        c.close();
    }
});

test('client: close() sends DISCONNECT, reports disconnected once and never reconnects; kick() skips the back-off', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { c, ws, states } = connected();
    c.close();
    assert.deepEqual(ws.sent[ws.sent.length - 1], [0xe0, 0]);
    assert.ok(ws.closed);
    assert.deepEqual(states, [true, false]);
    t.mock.timers.tick(60000);
    assert.equal(FakeWS.all.length, 1);
    assert.equal(c.publish('x'), false);
    const r = freshClient();
    r.c.start();
    FakeWS.all[0].fail();
    r.c.kick();
    assert.equal(FakeWS.all.length, 2, 'kick() connects at once');
    r.c.close();
    // A missing WebSocket (very old browser) is a failure, not an exception.
    const n = new MqttClient({ url: 'wss://x/mqtt', topic: TOPIC, WebSocket: 'nope' });
    n.start();
    assert.match(n.lastError, /WebSocket/);
    n.close();
});

// ---------- client against the fake broker (real WebSocket) ----------

test('broker: two clients exchange messages, every packet framing, drop and reconnect with a new subscription', async () => {
    const b = await startFakeMqtt();
    const got = { a: [], c: [] };
    const opts = { url: b.url, topic: TOPIC, backoffS: [0.05] };
    const a = new MqttClient(Object.assign({ onmessage: x => got.a.push(x) }, opts));
    const c = new MqttClient(Object.assign({ onmessage: x => got.c.push(x) }, opts));
    try {
        a.start();
        c.start();
        await until(() => a.connected && c.connected && b.subscriberCount(TOPIC) === 2, 3000, 'both connected');
        assert.equal(b.connectPackets.length, 2);
        for (const p of b.connectPackets) {
            assert.deepEqual([p.protocol, p.level, p.flags, p.keepAlive, p.rest], ['MQTT', 4, 2, 30, 0]);
            assert.match(p.clientId, /^otv[a-z0-9]{16}$/);
        }
        const env = 'otv1.' + 'e'.repeat(3890);
        assert.equal(a.publish(env), true);
        await until(() => got.c.length === 1 && got.a.length === 1, 3000, 'fan-out');
        assert.equal(got.c[0], env);
        assert.equal(got.a[0], env, 'MQTT 3.1.1 also delivers to the publisher');
        // Several packets per WebSocket message, then every packet in 7-byte messages.
        b.coalesce = true;
        b.publish(TOPIC, 'p1');
        b.publish(TOPIC, 'p2');
        b.publish(TOPIC, 'p3');
        await until(() => got.c.length === 4, 3000, 'coalesced');
        b.coalesce = false;
        b.splitAt = 7;
        b.publish(TOPIC, 's'.repeat(500));
        await until(() => got.c.length === 5, 3000, 'split');
        assert.deepEqual(got.c.slice(1), ['p1', 'p2', 'p3', 's'.repeat(500)]);
        b.splitAt = 0;
        // The broker cuts every socket: both reconnect and subscribe again.
        const before = b.connects;
        b.drop();
        await until(() => !a.connected || !c.connected, 3000, 'noticed the drop');
        await until(() => b.connects >= before + 2 && a.connected && c.connected && b.subscriberCount(TOPIC) === 2, 5000, 'reconnected');
        assert.equal(c.publish('after'), true);
        await until(() => got.a.indexOf('after') >= 0, 3000, 'after reconnect');
        assert.deepEqual(b.errors, []);
    } finally {
        a.close();
        c.close();
        await b.close();
    }
});

test('broker: no PINGRESP reconnects; a refused CONNECT and a broker that is down retry with back-off', async () => {
    const b = await startFakeMqtt();
    try {
        b.noPong = true;
        const a = new MqttClient({ url: b.url, topic: TOPIC, pingMs: 60, pongTimeoutMs: 60, backoffS: [0.05] });
        a.start();
        await until(() => a.connected, 3000, 'connected');
        await until(() => a.lastError === 'no PINGRESP', 3000, 'pong timeout');
        b.noPong = false;
        await until(() => a.connected && b.connects >= 2, 3000, 'reconnected');
        assert.ok(b.pings >= 1);
        a.close();
        b.refuse = 5;
        const r = new MqttClient({ url: b.url, topic: TOPIC, backoffS: [0.05] });
        r.start();
        await until(() => r.failures >= 2, 3000, 'refused twice');
        assert.match(r.lastError, /connect refused \(5\)|socket closed/);
        b.refuse = 0;
        await until(() => r.connected, 3000, 'accepted later');
        r.close();
        b.down = true;
        const d = new MqttClient({ url: b.url, topic: TOPIC, backoffS: [0.05] });
        d.start();
        await until(() => d.failures >= 2, 3000, 'down');
        b.down = false;
        await until(() => d.connected, 3000, 'up again');
        d.close();
        assert.deepEqual(b.errors, []);
    } finally {
        await b.close();
    }
});
