// TvLink behaviour against an in-memory relay (fake EventSource + fetch) and the fake TV.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as otv from '../../../tv/otv.js';
import { createFakeTv } from './fake-tv.mjs';

const CODE = '7K3M9QX2TD';
const RELAY = 'https://relay.test';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** In-memory stand-in for ntfy: topics, SSE subscribers, publish, attachments. */
function makeRelay({ clockSkewS = 0, openDelayMs = 5 } = {}) {
    const relay = {
        subs: new Map(), posts: [], files: new Map(), mode: 'ok', sources: [], log: [],
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
        if (relay.mode === 413) return new Response('{"code":41301,"http":413,"error":"attachment too large"}', { status: 413 });
        if (relay.mode === 500) return new Response('oops', { status: 500 });
        const topic = u.pathname.slice(1);
        relay.posts.push({ url, opts });
        if (u.searchParams.get('filename')) {
            const id = otv.newId();
            relay.files.set(id, new Uint8Array(opts.body));
            const ev = relay.publish(topic, 'You received a file: otv.bin', {
                attachment: { name: 'otv.bin', size: opts.body.length, url: RELAY + '/file/' + id + '.bin' },
            });
            return new Response(JSON.stringify(ev), { status: 200 });
        }
        return new Response(JSON.stringify(relay.publish(topic, opts.body)), { status: 200 });
    };
    relay.getAttachment = async url => relay.files.get(url.split('/file/')[1].replace('.bin', ''));
    return relay;
}

async function setup(opts = {}, tvOpts = {}) {
    const relay = makeRelay(opts);
    const tv = await createFakeTv(Object.assign({
        code: CODE, name: 'Conference Dahua',
        publish: (topic, env) => relay.publish(topic, env),
        getAttachment: relay.getAttachment,
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
    const ack = await link.send('open', { url: 'https://docs.google.com/spreadsheets' });
    assert.deepEqual(ack, { ok: true, msg: 'Link TV par khul gaya.', data: {} });
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
    assert.equal(m.cmd, 'open');
    assert.deepEqual(m.args, { url: 'https://docs.google.com/spreadsheets' });
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

test('ignores junk, foreign keys, other ids and duplicate parts; merges multi-part apps', async () => {
    const { relay, tv, link } = await setup({}, { appsCount: 40, appsPerPart: 15 });
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
    const ack = await link.send('apps', {});
    assert.equal(ack.ok, true);
    assert.equal(ack.data.apps.length, 40);
    assert.deepEqual(ack.data.apps.map(a => a.pkg), tv.apps.map(a => a.pkg));
    assert.equal(ack.partial, undefined);
    link.close();
});

test('duplicate ack parts are counted once', async () => {
    const { relay, tv, link } = await setup({}, { silent: true });
    const p = link.send('apps', {}, { timeoutMs: 2000 });
    while (!tv.commands.length) await sleep(5);
    const re = tv.commands[0].id;
    const part = (i, apps) => otv.seal(tv.key, tv.topic, { v: 1, dir: 't2c', id: otv.newId(), re, ok: true, msg: '3 apps', data: { apps }, part: i, parts: 2 });
    relay.publish(tv.topic, await part(1, [{ label: 'C', pkg: 'c' }]));
    relay.publish(tv.topic, await part(1, [{ label: 'C', pkg: 'c' }]));
    relay.publish(tv.topic, await part(0, [{ label: 'A', pkg: 'a' }, { label: 'B', pkg: 'b' }]));
    const ack = await p;
    assert.deepEqual(ack.data.apps.map(a => a.label), ['A', 'B', 'C']);
    link.close();
});

test('timeout rejects with code "timeout" and marks the TV offline; a late ack marks it online', async () => {
    const { relay, tv, link } = await setup({}, { silent: true });
    await assert.rejects(link.send('ping', {}, { timeoutMs: 300 }), e => e.code === 'timeout');
    assert.equal(link.state, 'offline');
    const re = tv.commands[0].id;
    relay.publish(tv.topic, await otv.seal(tv.key, tv.topic, { v: 1, dir: 't2c', id: otv.newId(), re, ok: true, msg: 'late', data: {} }));
    await sleep(30);
    assert.equal(link.state, 'online');
    link.close();
});

test('partial multi-part ack resolves at timeout with partial=true', async () => {
    const { relay, tv, link } = await setup({}, { silent: true });
    const p = link.send('apps', {}, { timeoutMs: 400 });
    while (!tv.commands.length) await sleep(5);
    relay.publish(tv.topic, await otv.seal(tv.key, tv.topic, { v: 1, dir: 't2c', id: otv.newId(), re: tv.commands[0].id, ok: true, msg: 'x', data: { apps: [{ label: 'A', pkg: 'a' }] }, part: 0, parts: 3 }));
    const ack = await p;
    assert.equal(ack.partial, true);
    assert.equal(ack.data.apps.length, 1);
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
    assert.equal((await link.send('key', { key: 'next_slide' })).ok, true);
    assert.equal(relay.sources.length, 1);
    relay.sources[0].drop(true);            // CLOSED: TvLink reconnects itself (1 s back-off)
    await sleep(1150);
    assert.equal(relay.sources.length, 2);
    assert.equal(link.connected, true);
    assert.equal((await link.send('key', { key: 'prev_slide' })).ok, true);
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

test('ping stores the status object; rename updates it', async () => {
    const { link } = await setup();
    const ack = await link.ping();
    assert.equal(ack.data.name, 'Conference Dahua');
    assert.equal(link.status.name, 'Conference Dahua');
    assert.ok(link.lastPingAt > 0);
    const r = await link.send('rename', { name: 'Board Room' });
    assert.equal(r.ok, true);
    assert.equal(link.status.name, 'Board Room');
    link.close();
});

test('sendFile encrypts, uploads to ?filename=otv.bin&firebase=no, then sends file command', async () => {
    const { relay, tv, link } = await setup();
    const bytes = new Uint8Array(300000).map((_, i) => i * 7);
    const file = new File([bytes], 'Sales.pptx');
    const seen = [];
    const ack = await link.sendFile(file, { onProgress: f => seen.push(f) });
    assert.equal(ack.ok, true);
    assert.equal(ack.msg, 'Sales.pptx TV par khul gaya.');
    assert.equal(relay.posts[0].url, RELAY + '/' + link.topic + '?filename=otv.bin&firebase=no');
    assert.equal(relay.posts[0].opts.body.length, bytes.length + 16);
    assert.deepEqual(tv.files[0].bytes, bytes);
    assert.equal(tv.files[0].name, 'Sales.pptx');
    const cmd = tv.received('file')[0];
    assert.deepEqual(Object.keys(cmd.args).sort(), ['iv', 'name', 'size', 'url']);
    assert.equal(cmd.args.size, bytes.length);
    assert.equal(seen[0], 0);
    assert.equal(seen[seen.length - 1], 1);
    assert.deepEqual(seen, seen.slice().sort((a, b) => a - b));
    assert.deepEqual(tv.errors, []);
    link.close();
});

test('sendFile refuses files over the limit without touching the relay', async () => {
    const { relay, link } = await setup();
    const big = { name: 'huge.mp4', size: otv.MAX_FILE_BYTES + 1, arrayBuffer: () => { throw new Error('must not read'); } };
    await assert.rejects(link.sendFile(big), e => e.code === 'too_big' && e.size === otv.MAX_FILE_BYTES + 1);
    assert.equal(relay.posts.length, 0);
    relay.mode = 429;
    await assert.rejects(link.sendFile(new File([new Uint8Array(10)], 'a.pdf')), e => e.code === 'rate_limit');
    relay.mode = 413;
    await assert.rejects(link.sendFile(new File([new Uint8Array(10)], 'a.pdf')), e => e.code === 'too_big' && e.size === 10);
    link.close();
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
});
