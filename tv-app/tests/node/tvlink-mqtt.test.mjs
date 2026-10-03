// TvLink with a 4-digit code (Office TV 3.6+): commands over every MQTT broker, the ntfy copy after 2.5 s without
// an ack, acks on the transport the command came over, one delivery per message id (PROTOCOL.md section 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as otv from '../../../tv/otv.js';
import { createFakeTv } from './fake-tv.mjs';
import { startFakeMqtt } from './fake-mqtt.mjs';
import { makeNtfy } from './fake-ntfy.mjs';

const CODE = '0427';
const NTFY = 'https://ntfy.test';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 3000, what = 'condition') {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error('timed out waiting for ' + what);
        await sleep(5);
    }
}

/**
 * Two fake brokers, an in-memory ntfy and a fake TV that hears commands over the brokers (tvMqtt) and ntfy
 * (tvNtfy) and acks on the transport each command came over, like the Office TV app.
 */
async function rig({ tvMqtt = true, tvNtfy = true, brokers = 2, tv: tvOpts = {}, link: linkOpts = {} } = {}) {
    const bs = [];
    for (let i = 0; i < brokers; i++) bs.push(await startFakeMqtt());
    const ntfy = makeNtfy();
    const topic = await otv.deriveTopic(CODE);
    const mtopic = 'officetv/' + topic;
    const acks = { mqtt: 0, ntfy: 0 };
    const tv = await createFakeTv(Object.assign({
        code: CODE, name: 'Room 12',
        publish: (t, env, via) => {
            acks[via]++;
            if (via === 'mqtt') for (const b of bs) b.publish(mtopic, env);
            else ntfy.publish(t, env, { cache: false });
        },
    }, tvOpts));
    if (tvMqtt) bs.forEach((b, i) => b.subscribe(mtopic, text => tv.handle({ event: 'message', message: text }, 'mqtt', 'broker' + i)));
    if (tvNtfy) ntfy.subscribe(topic, ev => tv.handle(ev, 'ntfy'));
    const link = new otv.TvLink(Object.assign({
        code: CODE, relay: NTFY, fetch: ntfy.fetch, EventSource: ntfy.EventSource, brokers: bs.map(b => b.url),
    }, linkOpts));
    await link.init();
    const close = async () => {
        link.close();
        for (const b of bs) await b.close();
    };
    return { bs, ntfy, tv, link, topic, mtopic, acks, close };
}

test('ping over MQTT: every broker, no ntfy message, the ack comes back over MQTT (lastAckVia)', async () => {
    const { bs, ntfy, tv, link, mtopic, acks, close } = await rig();
    try {
        assert.equal(link.short, true);
        assert.equal(await link.ready(3000), true);
        await until(() => link.transport.mqttCount === 2, 3000, 'brokers');
        const ack = await link.ping();
        assert.equal(ack.ok, true);
        assert.equal(ack.data.name, 'Room 12');
        assert.equal(link.lastAckVia, 'mqtt');
        assert.equal(link.state, 'online');
        assert.equal(ntfy.posts.length, 0, 'no ntfy message');
        for (const b of bs) assert.equal(b.published.of(mtopic).filter(p => p.clientId.startsWith('otv')).length, 1, 'one copy per broker');
        assert.deepEqual(tv.vias, ['mqtt']);
        assert.equal(tv.duplicates, 1, 'the second broker brought the same command');
        assert.equal(acks.mqtt, 1);
        await sleep(otv.NTFY_FALLBACK_MS + 200);
        assert.equal(ntfy.posts.length, 0, 'answered in time: no ntfy copy');
        assert.deepEqual(tv.errors, []);
    } finally {
        await close();
    }
});

test('a TV that misses the MQTT copy gets the same envelope over ntfy after 2.5 s and answers there', async () => {
    const { bs, ntfy, tv, link, mtopic, close } = await rig({ tvMqtt: false });
    try {
        assert.equal(otv.NTFY_FALLBACK_MS, 2500);
        await link.ready(3000);
        await until(() => link.transport.mqttCount === 2, 3000, 'brokers');
        const t0 = Date.now();
        const ack = await link.ping({ timeoutMs: 8000 });
        const took = Date.now() - t0;
        assert.ok(took >= 2400 && took < 4500, 'answered after the ntfy copy: ' + took + ' ms');
        assert.equal(ack.ok, true);
        assert.equal(link.lastAckVia, 'ntfy');
        assert.equal(ntfy.posts.length, 1);
        assert.equal(ntfy.posts[0].body, bs[0].published.of(mtopic)[0].text, 'the SAME envelope');
        assert.deepEqual(tv.vias, ['ntfy']);
        assert.deepEqual(tv.errors, []);
    } finally {
        await close();
    }
});

test('the same ack over every broker and ntfy resolves once; the MQTT and ntfy copies of a command are one command', async () => {
    const { ntfy, tv, link, topic, close } = await rig({ link: { ntfyFallbackMs: 100 } });
    try {
        await link.ready(3000);
        await until(() => link.transport.mqttCount === 2, 3000, 'brokers');
        tv.silent = true;
        const p = link.ping({ timeoutMs: 3000 });
        await until(() => ntfy.posts.length === 1, 3000, 'ntfy copy');
        await until(() => tv.duplicates === 2, 3000, 'three copies');
        assert.equal(tv.commands.length, 1);
        const re = tv.commands[0].id;
        const ack = await otv.seal(tv.key, topic, { v: 1, dir: 't2c', id: otv.newId(), re, ts: Date.now(), ok: true, msg: 'The TV is online.', data: { name: 'Room 12' }, part: 0, parts: 1 });
        const changes = [];
        link.onchange = () => changes.push(link.state);
        ntfy.publish(topic, ack);
        const other = await otv.seal(tv.key, topic, { v: 1, dir: 't2c', id: otv.newId(), re, ts: Date.now(), ok: false, msg: 'second', part: 0, parts: 1 });
        ntfy.publish(topic, other);
        const got = await p;
        assert.equal(got.ok, true, 'the first ack per re wins');
        assert.equal(got.msg, 'The TV is online.');
        assert.deepEqual(tv.errors, []);
    } finally {
        await close();
    }
});

test('no broker reachable: commands go over ntfy at once, once', async () => {
    const { bs, ntfy, tv, link, close } = await rig();
    for (const b of bs) b.down = true;
    try {
        assert.equal(await link.ready(3000), true);
        const ack = await link.ping();
        assert.equal(ack.ok, true);
        assert.equal(link.lastAckVia, 'ntfy');
        assert.equal(ntfy.posts.length, 1);
        await sleep(otv.NTFY_FALLBACK_MS + 100);
        assert.equal(ntfy.posts.length, 1, 'no second copy');
        assert.deepEqual(tv.vias, ['ntfy']);
    } finally {
        await close();
    }
});

test('listen(): a signal that arrives over every broker and ntfy reaches listeners once, with its transport', async () => {
    const { bs, ntfy, tv, link, topic, mtopic, close } = await rig();
    try {
        await link.ready(3000);
        await until(() => link.transport.mqttCount === 2, 3000, 'brokers');
        const got = [];
        const off = link.listen((m, meta) => got.push([m.dir, m.cast, meta.via, typeof meta.time]));
        const env = await otv.seal(tv.key, topic, { v: 1, dir: 'r2c', id: otv.newId(), ts: Date.now(), session: 'abcdefghij012345', cast: 'ready', part: 0, parts: 1, data: '' });
        for (const b of bs) b.publish(mtopic, env);
        await until(() => got.length === 1, 2000, 'signal');
        ntfy.publish(topic, env);
        // A second sealing of the same message (same id) is the same message too.
        const again = await otv.seal(tv.key, topic, await otv.open(tv.key, topic, env));
        ntfy.publish(topic, again);
        await sleep(100);
        assert.deepEqual(got, [['r2c', 'ready', 'mqtt', 'number']]);
        off();
    } finally {
        await close();
    }
});

test('transports "mqtt" (no ntfy at all) and "ntfy" (no brokers), for CI', async () => {
    const m = await rig({ link: { transports: 'mqtt' } });
    try {
        assert.equal(await m.link.ready(3000), true);
        assert.equal((await m.link.ping()).ok, true);
        assert.equal(m.link.lastAckVia, 'mqtt');
        assert.equal(m.ntfy.sources.length, 0, 'no ntfy subscription');
        assert.equal(m.ntfy.posts.length, 0);
    } finally {
        await m.close();
    }
    const n = await rig({ link: { transports: 'ntfy' } });
    try {
        assert.equal(await n.link.ready(3000), true);
        assert.equal((await n.link.ping()).ok, true);
        assert.equal(n.link.lastAckVia, 'ntfy');
        assert.equal(n.link.transport.mqttCount, 0);
        for (const b of n.bs) assert.equal(b.upgrades, 0, 'no broker connection');
    } finally {
        await n.close();
    }
});

test('a silent TV: the command times out; a rate-limited ntfy copy is reported with the timeout', async () => {
    const { ntfy, tv, link, close } = await rig({ link: { ntfyFallbackMs: 100 } });
    try {
        await link.ready(3000);
        await until(() => link.transport.mqttCount === 2, 3000, 'brokers');
        tv.silent = true;
        ntfy.mode = 'daily';
        await assert.rejects(link.ping({ timeoutMs: 600 }), e => e.code === 'timeout' && e.fallbackError && e.fallbackError.code === 'rate_limit');
        assert.equal(link.state, 'offline');
    } finally {
        await close();
    }
});

test('suspend() closes the brokers and ntfy; the next command opens them again', async () => {
    const { bs, link, close } = await rig();
    try {
        await link.ready(3000);
        await until(() => link.transport.mqttCount === 2, 3000, 'brokers');
        assert.equal(link.suspend(), true);
        await until(() => bs.every(b => b.clients.size === 0), 3000, 'broker connections closed');
        assert.equal(link.connected, false);
        assert.equal((await link.ping()).ok, true);
        assert.equal(link.connected, true);
    } finally {
        await close();
    }
});

test('heard(session): the TV receiver\'s "ready" shows the TV has "cast start", so no ntfy copy; fallbackMs per command', async () => {
    const { ntfy, tv, link, close } = await rig({ tv: { delayMs: 800 } });
    try {
        await link.ready(3000);
        await until(() => link.transport.mqttCount === 2, 3000, 'brokers');
        const p = link.send('cast', { action: 'start', session: 'abcdefghij012345' }, { fallbackMs: 300 });
        await until(() => tv.commands.length === 1, 2000, 'command');
        link.heard('someothersession');
        link.heard('abcdefghij012345');
        const ack = await p;
        assert.equal(ack.ok, true);
        assert.equal(ntfy.posts.length, 0, 'no ntfy copy although the ack took longer than fallbackMs');
        // Without heard(), the per-command fallbackMs applies.
        const q = link.send('cast', { action: 'start', session: 'zyxwvutsrq012345' }, { fallbackMs: 300 });
        assert.equal((await q).ok, true);
        assert.equal(ntfy.posts.length, 1, 'the ntfy copy after 300 ms');
        assert.deepEqual(tv.errors, []);
    } finally {
        await close();
    }
});
