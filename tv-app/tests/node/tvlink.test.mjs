// TvLink behaviour against an in-memory relay (fake EventSource + fetch) and the fake TV.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as otv from '../../../tv/otv.js';
import { createFakeTv } from './fake-tv.mjs';

const CODE = '7K3M9QX2TD';
const RELAY = 'https://relay.test';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** In-memory stand-in for ntfy: topics, SSE subscribers, publish. */
function makeRelay({ clockSkewS = 0, openDelayMs = 5 } = {}) {
    const relay = {
        subs: new Map(), posts: [], mode: 'ok', sources: [], log: [],
        now: () => Math.floor(Date.now() / 1000) + clockSkewS,
        sub(topic, fn) {
            if (!this.subs.has(topic)) this.subs.set(topic, new Set());
            this.subs.get(topic).add(fn);
            return () => this.subs.get(topic).delete(fn);
        },
        publish(topic, message, extra) {
            const ev = Object.assign({ id: otv.newId(), time: this.now(), event: 'message', topic, message }, extra);
            for (const fn of Array.from(this.subs.get(topic) || [])) fn(ev);
            return ev;
        },
    };
    class FakeES {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.listeners = {};
            this.topic = new URL(url).pathname.split('/')[1];
            relay.sources.push(this);
            relay.log.push('es:' + url);
            this._t = setTimeout(() => this._open(), openDelayMs);
        }
        _open() {
            if (this.readyState === 2) return;
            this.readyState = 1;
            this.unsub = relay.sub(this.topic, ev => this.onmessage && this.onmessage({ data: JSON.stringify(ev) }));
            relay.log.push('open');
            if (this.onopen) this.onopen({});
            const data = JSON.stringify({ id: 'o1', time: relay.now(), event: 'open', topic: this.topic });
            for (const f of this.listeners.open || []) f({ data });
        }
        addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
        close() {
            this.readyState = 2;
            clearTimeout(this._t);
            if (this.unsub) this.unsub();
        }
        /** Simulate a dropped stream; permanent=true is what a browser does after e.g. HTTP 502. */
        drop(permanent) {
            if (this.unsub) this.unsub();
            this.unsub = null;
            this.readyState = permanent ? 2 : 0;
            if (this.onerror) this.onerror({});
            if (!permanent) this._t = setTimeout(() => this._open(), 20); // browser auto-retry
        }
    }
    relay.EventSource = FakeES;
    relay.fetch = async (url, opts) => {
        const u = new URL(url);
        relay.log.push('post:' + u.search);
        if (relay.mode === 'network') throw new TypeError('Failed to fetch');
        if (relay.mode === 429) return new Response('{"code":42901,"http":429,"error":"limit reached"}', { status: 429 });
        if (relay.mode === 'daily') return new Response('{"code":42908,"http":429,"error":"limit reached: daily message quota reached"}', { status: 429 });
        if (relay.mode === 500) return new Response('oops', { status: 500 });
        const topic = u.pathname.slice(1);
        relay.posts.push({ url, opts });
        return new Response(JSON.stringify(relay.publish(topic, opts.body)), { status: 200 });
    };
    return relay;
}

async function setup(opts = {}, tvOpts = {}) {
    const relay = makeRelay(opts);
    const tv = await createFakeTv(Object.assign({
        code: CODE, name: 'Conference Dahua',
        publish: (topic, env) => relay.publish(topic, env),
    }, tvOpts));
    relay.sub(tv.topic, ev => tv.handle(ev));
    const link = new otv.TvLink({ code: CODE, name: 'Conf', relay: RELAY, fetch: relay.fetch, EventSource: relay.EventSource });
    await link.init();
    return { relay, tv, link };
}

test('send(): encrypted POST to <relay>/<topic>?firebase=no, ack resolves, echo ignored', async () => {
    const { relay, tv, link } = await setup();
    assert.equal(link.topic, await otv.deriveTopic(CODE));
    const changes = [];
    link.onchange = l => changes.push(l.state);
    const ack = await link.send('cast', { action: 'start', session: 'abcdefghij012345' });
    assert.deepEqual(ack, { ok: true, msg: 'The TV is ready to show your screen.', data: {} });
    assert.equal(relay.posts.length, 1);
    const { url, opts } = relay.posts[0];
    assert.equal(url, RELAY + '/' + link.topic + '?firebase=no');
    assert.equal(opts.method, 'POST');
    assert.equal(typeof opts.body, 'string');
    assert.equal(opts.headers, undefined, 'no custom headers (CORS simple request)');
    assert.ok(opts.body.length < otv.MAX_ENVELOPE_BYTES);
    const m = tv.commands[0];
    assert.equal(m.v, 1);
    assert.equal(m.dir, 'c2t');
    assert.match(m.id, /^[0-9a-z]{10,}$/);
    assert.ok(Math.abs(m.ts - Date.now()) < 5000);
    assert.equal(m.cmd, 'cast');
    assert.deepEqual(m.args, { action: 'start', session: 'abcdefghij012345' });
    assert.equal(link.state, 'online');
    assert.ok(changes.includes('online'));
    assert.deepEqual(tv.errors, []);
    link.close();
});

test('waits for the event stream before posting', async () => {
    const { relay, link } = await setup({ openDelayMs: 120 });
    await link.send('ping', {});
    const i = relay.log.indexOf('open');
    const j = relay.log.findIndex(x => x.startsWith('post:'));
    assert.ok(i >= 0 && j > i, relay.log.join(' '));
    link.close();
});

test('ignores junk, foreign keys, other ids and wrong directions', async () => {
    const { relay, tv, link } = await setup();
    const other = await otv.deriveKey('0000000000');
    const origHandle = tv.handle;
    tv.handle = async ev => {
        const m = await otv.open(tv.key, tv.topic, ev.message);
        if (m && m.dir === 'c2t' && m.cmd) { // the injected fake c2t below has no cmd, so no loop
            relay.publish(tv.topic, 'hello world');
            relay.publish(tv.topic, 'otv1.garbage.garbage');
            relay.publish(tv.topic, await otv.seal(other, tv.topic, { v: 1, dir: 't2c', id: 'x1234567890', re: m.id, ok: false, msg: 'evil' }));
            relay.publish(tv.topic, await otv.seal(tv.key, tv.topic, { v: 1, dir: 't2c', id: 'y1234567890', re: 'someoneelse1', ok: false, msg: 'not yours' }));
            relay.publish(tv.topic, await otv.seal(tv.key, tv.topic, { v: 1, dir: 'c2t', id: 'z1234567890', re: m.id, ok: false, msg: 'wrong dir' }));
        }
        return origHandle(ev);
    };
    const ack = await link.send('ping', {});
    assert.equal(ack.ok, true);
    assert.equal(ack.msg, 'The TV is online.');
    assert.equal(ack.partial, undefined);
    link.close();
});

test('multi-part acks are merged in part order; duplicate parts are counted once', async () => {
    const { relay, tv, link } = await setup({}, { silent: true });
    const p = link.send('ping', {}, { timeoutMs: 2000 });
    while (!tv.commands.length) await sleep(5);
    const re = tv.commands[0].id;
    const part = (i, data) => otv.seal(tv.key, tv.topic, { v: 1, dir: 't2c', id: otv.newId(), re, ok: true, msg: i ? '' : 'The TV is online.', data, part: i, parts: 2 });
    relay.publish(tv.topic, await part(1, { model: 'B' }));
    relay.publish(tv.topic, await part(1, { model: 'B' }));
    relay.publish(tv.topic, await part(0, { name: 'Board Room', model: 'A' }));
    const ack = await p;
    assert.deepEqual(ack, { ok: true, msg: 'The TV is online.', data: { name: 'Board Room', model: 'B' } });
    link.close();
});

test('timeout rejects with code "timeout" and marks the TV offline; a late ack marks it online', async () => {
    const { relay, tv, link } = await setup({}, { silent: true });
    await assert.rejects(link.send('ping', {}, { timeoutMs: 300 }), e => e.code === 'timeout');
    assert.equal(link.state, 'offline');
    const re = tv.commands[0].id;
    relay.publish(tv.topic, await otv.seal(tv.key, tv.topic, { v: 1, dir: 't2c', id: otv.newId(), re, ok: true, msg: 'late', data: {} }));
    for (let i = 0; i < 100 && link.state !== 'online'; i++) await sleep(10);
    assert.equal(link.state, 'online');
    link.close();
});

test('partial multi-part ack resolves at timeout with partial=true', async () => {
    const { relay, tv, link } = await setup({}, { silent: true });
    const p = link.send('ping', {}, { timeoutMs: 400 });
    while (!tv.commands.length) await sleep(5);
    relay.publish(tv.topic, await otv.seal(tv.key, tv.topic, { v: 1, dir: 't2c', id: otv.newId(), re: tv.commands[0].id, ok: true, msg: 'x', data: { name: 'A' }, part: 0, parts: 3 }));
    const ack = await p;
    assert.equal(ack.partial, true);
    assert.equal(ack.data.name, 'A');
    link.close();
});

test('relay errors map to rate_limit / network / relay', async () => {
    const { relay, link } = await setup();
    relay.mode = 429;
    await assert.rejects(link.send('ping', {}), e => e.code === 'rate_limit' && e.status === 429 && e.limit === 'burst' && e.relayCode === 42901);
    relay.mode = 'daily';
    await assert.rejects(link.send('ping', {}), e => e.code === 'rate_limit' && e.limit === 'daily');
    relay.mode = 'network';
    await assert.rejects(link.send('ping', {}), e => e.code === 'network');
    relay.mode = 500;
    await assert.rejects(link.send('ping', {}), e => e.code === 'relay' && e.status === 500);
    relay.mode = 'ok';
    assert.equal((await link.send('ping', {})).ok, true);
    link.close();
});

test('survives EventSource drops: browser auto-retry and permanent close', async () => {
    const { relay, link } = await setup();
    await link.send('ping', {});
    const first = relay.sources[0];
    first.drop(false);                      // CONNECTING: browser retries, no new EventSource
    assert.equal(link.connected, false);
    assert.equal((await link.send('ping', {})).ok, true);
    assert.equal(relay.sources.length, 1);
    relay.sources[0].drop(true);            // CLOSED: TvLink reconnects itself (1 s back-off)
    await sleep(1150);
    assert.equal(relay.sources.length, 2);
    assert.equal(link.connected, true);
    assert.equal((await link.send('ping', {})).ok, true);
    relay.sources[1].drop(true);            // a send while closed reconnects immediately
    assert.equal((await link.send('ping', {})).ok, true);
    assert.equal(relay.sources.length, 3);
    link.close();
    assert.equal(relay.sources[2].readyState, 2);
});

test('corrects a wrong laptop clock using the relay time', async () => {
    const { tv, link } = await setup({ clockSkewS: 3600 }); // relay (and TV) think it is an hour later
    await link.send('ping', {});
    assert.ok(Math.abs(link.clockOffsetMs - 3600000) < 2000, String(link.clockOffsetMs));
    assert.deepEqual(tv.errors, []);
    assert.equal(tv.commands.length, 1);
    link.close();
});

test('ping stores the status object', async () => {
    const { link } = await setup();
    const ack = await link.ping();
    assert.equal(ack.data.name, 'Conference Dahua');
    assert.equal(link.status.name, 'Conference Dahua');
    assert.ok(link.lastPingAt > 0);
    const r = await link.send('cast', { action: 'stop', session: 'abcdefghij012345' });
    assert.equal(r.ok, true);
    assert.equal(link.status.name, 'Conference Dahua', 'only ping replaces the status');
    link.close();
});

test('listen(): screen sharing signals and own echoes reach listeners with the relay event; acks do not', async () => {
    const { relay, tv, link } = await setup();
    const got = [];
    const off = link.listen((m, ev) => got.push([m.dir, m.cast || m.cmd, ev && typeof ev.time]));
    await link.ping();
    relay.publish(tv.topic, await otv.seal(tv.key, tv.topic, { v: 1, dir: 'r2c', id: otv.newId(), ts: Date.now(), session: 'abcdefghij012345', cast: 'answer', part: 0, parts: 1, data: 'jx' }));
    for (let i = 0; i < 100 && got.length < 2; i++) await sleep(10);
    assert.deepEqual(got, [['c2t', 'ping', 'number'], ['r2c', 'answer', 'number']]);
    off();
    relay.publish(tv.topic, await otv.seal(tv.key, tv.topic, { v: 1, dir: 'r2c', id: otv.newId(), ts: Date.now(), session: 'x', cast: 'bye' }));
    await sleep(20);
    assert.equal(got.length, 2, 'unsubscribed');
    link.close();
});

test('suspend() closes the idle stream; the next command or ready() opens it again', async () => {
    const { relay, tv, link } = await setup();
    await link.ping();
    assert.equal(link.connected, true);
    assert.equal(link.suspend(), true);
    assert.equal(link.connected, false);
    assert.equal(relay.sources[0].readyState, 2, 'stream closed');
    await sleep(1200);
    assert.equal(relay.sources.length, 1, 'no automatic reconnect while suspended');
    assert.equal((await link.ping()).ok, true, 'a command reopens the stream');
    assert.equal(relay.sources.length, 2);
    // Busy links stay open: a command waiting for its ack, or a listener (a sharing session).
    tv.silent = true;
    const p = link.send('ping', {}, { timeoutMs: 300 });
    await sleep(30);
    assert.equal(link.suspend(), false);
    await assert.rejects(p, e => e.code === 'timeout');
    const off = link.listen(() => {});
    assert.equal(link.suspend(), false);
    off();
    assert.equal(link.suspend(), true);
    assert.equal(await link.ready(1000), true, 'ready() reopens');
    assert.equal(relay.sources.length, 3);
    link.close();
    assert.equal(await link.ready(50), false, 'closed links never reopen');
});

test('close() rejects pending commands and stops the stream', async () => {
    const { relay, link } = await setup({}, { silent: true });
    const p = link.send('ping', {}, { timeoutMs: 5000 });
    await sleep(40);
    link.close();
    await assert.rejects(p, e => e.code === 'closed');
    assert.equal(relay.sources[0].readyState, 2);
});

test('constructor validates the code and relay', () => {
    assert.throws(() => new otv.TvLink({ code: 'nope' }));
    const l = new otv.TvLink({ code: '7k3m9-qx2td', relay: 'https://ntfy.sh/' });
    assert.equal(l.code, CODE);
    assert.equal(l.relay, 'https://ntfy.sh');
    assert.equal(new otv.TvLink({ code: CODE, relay: 'javascript:alert(1)' }).relay, otv.DEFAULT_RELAY);
    assert.equal(typeof l.sendFile, 'undefined', 'file sending is gone');
});
