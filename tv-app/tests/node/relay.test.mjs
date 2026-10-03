// tv/relay.js: the transports of one topic. 4-digit codes: every MQTT broker at once plus the ntfy event stream,
// publishing over the brokers and over ntfy only without one (PROTOCOL.md section 6); 10-symbol codes: ntfy only.
// Real WebSockets to the fake broker (fake-mqtt.mjs), an in-memory ntfy (fake-ntfy.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BROKERS, MQTT_GRACE_MS, MQTT_PREFIX, Relay } from '../../../tv/relay.js';
import * as otv from '../../../tv/otv.js';
import { startFakeMqtt } from './fake-mqtt.mjs';
import { makeNtfy } from './fake-ntfy.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NTFY = 'https://ntfy.test';
const FAST = { backoffS: [0.05] };

async function until(fn, ms = 3000, what = 'condition') {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error('timed out waiting for ' + what);
        await sleep(5);
    }
}

async function rig({ brokers = 2, code = '0427' } = {}) {
    const bs = [];
    for (let i = 0; i < brokers; i++) bs.push(await startFakeMqtt());
    const ntfy = makeNtfy();
    const topic = await otv.deriveTopic(code);
    const make = (opts = {}) => new Relay(Object.assign({
        topic, code, ntfy: NTFY, brokers: bs.map(b => b.url), EventSource: ntfy.EventSource, fetch: ntfy.fetch, mqtt: FAST,
    }, opts));
    const close = async () => { for (const b of bs) await b.close(); };
    return { bs, ntfy, topic, code, make, close, mtopic: MQTT_PREFIX + topic };
}

test('the broker list: three public brokers over wss, MQTT topic officetv/<topic>', () => {
    assert.deepEqual(BROKERS, ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://mqtt.eclipseprojects.io:443/mqtt']);
    assert.equal(MQTT_PREFIX, 'officetv/');
});

test('10-symbol codes (older TVs) never open a WebSocket: ntfy only, exactly as before', async () => {
    const ntfy = makeNtfy();
    let sockets = 0;
    class NoWS { constructor() { sockets++; throw new Error('no MQTT for v1 codes'); } }
    const topic = await otv.deriveTopic('7K3M9QX2TD');
    const r = new Relay({ topic, code: '7K3M9QX2TD', ntfy: NTFY, brokers: ['ws://127.0.0.1:1/mqtt'], WebSocket: NoWS, EventSource: ntfy.EventSource, fetch: ntfy.fetch });
    assert.deepEqual(r.brokers, []);
    assert.equal(await r.ready(1000), true);
    assert.equal(r.mqttCount, 0);
    const res = await r.publish('otv1.aaaa.bbbb');
    assert.equal(res.via, 'ntfy');
    assert.equal(res.ok, true);
    assert.equal(ntfy.posts.length, 1);
    assert.equal(ntfy.posts[0].url, NTFY + '/' + topic + '?firebase=no');
    assert.equal((await r.publish('otv1.cccc.dddd', { via: 'mqtt' })).via, 'ntfy');
    assert.equal(ntfy.log[0], 'es:/' + topic + '/sse');
    assert.equal(sockets, 0);
    r.close();
});

test('4-digit codes: every broker and ntfy at once; publish goes to every connected broker and not to ntfy', async () => {
    const { bs, ntfy, topic, mtopic, make, close } = await rig({ brokers: 3 });
    const r = make();
    const changes = [];
    r.onchange = () => changes.push(r.mqttCount + '/' + r.ntfyConnected);
    try {
        assert.equal(await r.ready(3000), true);
        await until(() => r.mqttCount === 3, 3000, 'three brokers');
        assert.equal(r.connected, true);
        assert.equal(ntfy.open(topic), 1, 'ntfy subscription stays open too');
        for (const b of bs) assert.equal(b.subscriberCount(mtopic), 1);
        const res = await r.publish('otv1.env.one');
        assert.deepEqual([res.via, res.ok, res.count], ['mqtt', true, 3]);
        await until(() => bs.every(b => b.published.length === 1), 3000, 'published everywhere');
        for (const b of bs) assert.deepEqual(b.published.map(p => [p.topic, p.text]), [[mtopic, 'otv1.env.one']]);
        assert.equal(ntfy.posts.length, 0, 'no ntfy message (no daily quota used)');
        assert.ok(changes.length >= 2 && changes[changes.length - 1] === '3/true', changes.join(' '));
        // via 'ntfy' forces ntfy; 'mqtt-only' never uses it.
        assert.equal((await r.publish('otv1.env.two', { via: 'ntfy' })).via, 'ntfy');
        assert.equal(ntfy.posts.length, 1);
        assert.equal((await r.publish('otv1.env.three', { via: 'mqtt-only' })).count, 3);
        assert.equal(ntfy.posts.length, 1);
    } finally {
        r.close();
        await close();
    }
});

test('each envelope is delivered once although it arrives over every broker and ntfy; via and time are reported', async () => {
    const { bs, ntfy, topic, mtopic, make, close } = await rig({ brokers: 2 });
    const r = make();
    const got = [];
    r.onmessage = (env, meta) => got.push([env, meta.via, meta.time]);
    try {
        await r.ready(3000);
        await until(() => r.mqttCount === 2, 3000, 'brokers');
        const env = await otv.seal(await otv.deriveKey('0427'), topic, { v: 1, dir: 't2c', id: otv.newId() });
        for (const b of bs) b.publish(mtopic, env);
        await until(() => got.length === 1, 2000, 'MQTT copy');
        ntfy.publish(topic, env);
        await sleep(100);
        assert.equal(got.length, 1);
        assert.equal(got[0][0], env);
        assert.equal(got[0][1], 'mqtt');
        assert.ok(Math.abs(got[0][2] - Date.now() / 1000) < 5, 'MQTT has no server time: now');
        // ntfy first, then the brokers.
        const env2 = await otv.seal(await otv.deriveKey('0427'), topic, { v: 1, dir: 't2c', id: otv.newId() });
        const ev = ntfy.publish(topic, env2);
        for (const b of bs) b.publish(mtopic, env2);
        await sleep(100);
        assert.equal(got.length, 2);
        assert.deepEqual(got[1], [env2, 'ntfy', ev.time]);
        // Only otv1 envelopes count; ntfy's other events do not.
        ntfy.publish(topic, 'hello world');
        bs[0].publish(mtopic, 'not an envelope');
        await sleep(50);
        assert.equal(got.length, 2);
    } finally {
        r.close();
        await close();
    }
});

test('no broker reachable: ready() once every broker failed, publish over ntfy, MQTT again once a broker is back', async () => {
    const { bs, ntfy, make, close } = await rig({ brokers: 2 });
    for (const b of bs) b.down = true;
    const r = make();
    try {
        const t0 = Date.now();
        assert.equal(await r.ready(3000), true);
        assert.ok(Date.now() - t0 < MQTT_GRACE_MS + 500);
        assert.equal(r.mqttCount, 0);
        const res = await r.publish('otv1.via.ntfy');
        assert.deepEqual([res.via, res.ok], ['ntfy', true]);
        assert.equal(ntfy.posts.length, 1);
        const only = await r.publish('otv1.never.ntfy', { via: 'mqtt-only' });
        assert.deepEqual([only.via, only.ok], ['mqtt', false]);
        assert.equal(ntfy.posts.length, 1, 'mqtt-only never falls back');
        bs[1].down = false;
        await until(() => r.mqttCount === 1, 3000, 'broker back');
        const again = await r.publish('otv1.via.mqtt');
        assert.deepEqual([again.via, again.count], ['mqtt', 1]);
        assert.equal(ntfy.posts.length, 1);
        await until(() => bs[1].published.length === 1, 2000, 'reached the broker');
    } finally {
        r.close();
        await close();
    }
});

test('ready() waits a moment for a broker while only ntfy is up (every ntfy message costs daily quota)', async () => {
    const { bs, make, close } = await rig({ brokers: 1 });
    bs[0].silent = true; // accepts the socket, never answers CONNECT
    const r = make();
    try {
        const t0 = Date.now();
        assert.equal(await r.ready(5000), true);
        const took = Date.now() - t0;
        assert.ok(took >= MQTT_GRACE_MS - 100 && took < MQTT_GRACE_MS + 800, 'grace ' + took + ' ms');
        assert.equal(r.mqttCount, 0);
        assert.equal((await r.publish('otv1.a.b')).via, 'ntfy');
    } finally {
        r.close();
        await close();
    }
    // A broker that connects within the grace ends the wait at once.
    const q = await rig({ brokers: 1 });
    const r2 = q.make();
    try {
        const t0 = Date.now();
        assert.equal(await r2.ready(5000), true);
        assert.ok(Date.now() - t0 < MQTT_GRACE_MS, 'no grace wait with a broker');
        assert.equal(r2.mqttCount, 1);
    } finally {
        r2.close();
        await q.close();
    }
});

test('ntfy disabled (CI --transport mqtt): brokers only; brokers [] (--transport ntfy): ntfy only', async () => {
    const { bs, ntfy, make, close } = await rig({ brokers: 1 });
    const m = make({ ntfy: false });
    const n = make({ brokers: [] });
    try {
        assert.equal(await m.ready(3000), true);
        assert.equal(m.mqttCount, 1);
        assert.equal(ntfy.sources.length <= 1, true);
        bs[0].down = true;
        bs[0].drop();
        await until(() => m.mqttCount === 0, 3000, 'broker gone');
        const res = await m.publish('otv1.x.y');
        assert.equal(res.ok, false, 'nowhere to publish');
        assert.equal(ntfy.posts.length, 0);
        assert.equal(await n.ready(3000), true);
        assert.equal((await n.publish('otv1.x.y')).via, 'ntfy');
        assert.equal(n.mqttCount, 0);
    } finally {
        m.close();
        n.close();
        await close();
    }
});

test('ntfy: open and keepalive events give the server clock; since= for the first subscription, the last id after a drop', async () => {
    const { ntfy, topic, make, close } = await rig({ brokers: 0 });
    ntfy.skew = 3600;
    const old = ntfy.publish(topic, 'otv1.old.one');
    const r = make({ since: '5m', brokers: [] });
    const got = [];
    const times = [];
    r.onmessage = env => got.push(env);
    r.ontime = s => times.push(s);
    try {
        await r.ready(2000);
        await until(() => got.length === 1, 2000, 'replayed');
        assert.equal(got[0], old.message);
        assert.equal(ntfy.log[0], 'es:/' + topic + '/sse?since=5m');
        assert.ok(Math.abs(r.serverOffsetMs - 3600000) < 2000, String(r.serverOffsetMs));
        assert.ok(times.length >= 1);
        const last = ntfy.publish(topic, 'otv1.new.two');
        await until(() => got.length === 2, 2000, 'live');
        ntfy.sources[0].drop(true);
        assert.equal(r.connected, false);
        await until(() => ntfy.sources.length === 2 && r.connected, 3000, 'reconnected');
        assert.equal(ntfy.log.filter(l => l.startsWith('es:'))[1], 'es:/' + topic + '/sse?since=' + last.id);
        assert.equal(got.length, 2, 'nothing twice');
    } finally {
        r.close();
        await close();
    }
});

test('ntfy errors come back with their HTTP status (429 with the body); close() ends every connection', async () => {
    const { bs, ntfy, make, close } = await rig({ brokers: 1 });
    const r = make({ brokers: [] });
    try {
        await r.ready(2000);
        ntfy.mode = 'daily';
        const lim = await r.publish('otv1.a.b');
        assert.deepEqual([lim.ok, lim.status], [false, 429]);
        assert.match(lim.body, /42908/);
        ntfy.mode = 'network';
        assert.deepEqual([(await r.publish('otv1.a.b')).status], [0]);
        ntfy.mode = 500;
        assert.equal((await r.publish('otv1.a.b')).status, 500);
    } finally {
        r.close();
    }
    const all = make();
    await all.ready(3000);
    await until(() => all.mqttCount === 1, 3000, 'broker');
    all.close();
    await until(() => bs[0].clients.size === 0, 3000, 'broker connection closed');
    assert.equal(ntfy.sources[ntfy.sources.length - 1].readyState, 2);
    assert.equal(await all.ready(100), false);
    assert.equal((await all.publish('otv1.a.b')).ok, false);
    await close();
});

test('globalThis.__otvRelayConfig replaces the default brokers and ntfy (browser tests)', async () => {
    const { bs, ntfy, topic, close } = await rig({ brokers: 1 });
    globalThis.__otvRelayConfig = { brokers: [bs[0].url], ntfy: 'https://other.test/' };
    try {
        const r = new Relay({ topic, code: '0427', EventSource: ntfy.EventSource, fetch: ntfy.fetch, mqtt: FAST });
        assert.deepEqual(r.brokers, [bs[0].url]);
        assert.equal(r.ntfy, 'https://other.test');
        const own = new Relay({ topic, code: '0427', ntfy: 'https://mine.test', brokers: [], EventSource: ntfy.EventSource, fetch: ntfy.fetch });
        assert.deepEqual(own.brokers, [], 'explicit options win');
        assert.equal(own.ntfy, 'https://mine.test');
        r.start();
        await until(() => r.mqttCount === 1, 3000, 'test broker');
        r.close();
    } finally {
        delete globalThis.__otvRelayConfig;
        await close();
    }
});
