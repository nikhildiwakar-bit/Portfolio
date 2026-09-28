#!/usr/bin/env node
// Real relay test for the emulator smoke test (smoke.sh): talks to the Office TV app on the emulator through
// the public relay exactly like the website does, using the website's own protocol code (tv/otv.js: same
// topic, key and encrypted envelopes, PROTOCOL.md sections 2-6).
//
//   node relay-cast.mjs --code <TV code> --step ping|start|stop [--session <id>] [--expect ok|fail|any]
//                       [--relay https://ntfy.sh] [--timeout <seconds, default 45>]
//
// Prints one line: RESULT {"step":..,"ok":..,"msg":..,"data":..,"ms":..} and exits
//   0  an ack arrived and its ok matches --expect (default ok)
//   1  failure: no ack in time, or an ack with the wrong ok
//   2  warning: the relay is unreachable from this machine or rate limited (HTTP 429)
// Needs Node 18+ (fetch, WebCrypto). Subscribes with the NDJSON stream (/json), so no EventSource is needed.
import { normalizeCode, deriveTopic, deriveKey, seal, open, newId } from '../../tv/otv.js';

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const code = normalizeCode(arg('code', '') || '');
const step = arg('step', 'ping');
const session = arg('session', '');
const expect = arg('expect', 'ok');
const relay = (arg('relay', 'https://ntfy.sh') || 'https://ntfy.sh').replace(/\/+$/, '');
const timeoutMs = Math.max(5, parseInt(arg('timeout', '45'), 10) || 45) * 1000;
const started = Date.now();

function done(exit, fields) {
    const out = Object.assign({ step, exit, ms: Date.now() - started }, fields);
    console.log('RESULT ' + JSON.stringify(out));
    process.exit(exit);
}

if (!code) done(1, { error: 'missing or invalid --code' });
let cmd, args;
if (step === 'ping') {
    cmd = 'ping';
    args = {};
} else if (step === 'start' || step === 'stop') {
    if (!/^[a-z0-9]{12,32}$/.test(session)) done(1, { error: 'missing or invalid --session' });
    cmd = 'cast';
    args = { action: step, session };
} else {
    done(1, { error: 'unknown --step ' + step });
}

const topic = await deriveTopic(code);
const key = await deriveKey(code);
const abort = new AbortController();
const timer = setTimeout(() => {
    abort.abort();
    done(1, { error: 'no ack within ' + timeoutMs / 1000 + ' s' });
}, timeoutMs);

// 1. Subscribe first, so the ack cannot be missed.
let res;
try {
    res = await fetch(relay + '/' + topic + '/json', { signal: abort.signal, headers: { 'User-Agent': 'otv-ci-relay-cast' } });
} catch (e) {
    clearTimeout(timer);
    done(2, { error: 'relay not reachable: ' + (e && e.message) });
}
if (res.status === 429) done(2, { error: 'relay rate limit (HTTP 429) on subscribe' });
if (!res.ok || !res.body) done(2, { error: 'relay subscribe HTTP ' + res.status });

const id = newId();
let opened = false;
let published = false;

async function publish() {
    published = true;
    const env = await seal(key, topic, { v: 1, dir: 'c2t', id, ts: Date.now(), cmd, args });
    let r;
    try {
        r = await fetch(relay + '/' + topic + '?firebase=no', { method: 'POST', body: env, headers: { 'Content-Type': 'text/plain' } });
    } catch (e) {
        done(2, { error: 'publish failed: ' + (e && e.message) });
    }
    if (r.status === 429) done(2, { error: 'relay rate limit (HTTP 429) on publish' });
    if (!r.ok) done(2, { error: 'publish HTTP ' + r.status });
}

async function onLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch (e) { return; }
    if (!ev || typeof ev !== 'object') return;
    if (ev.event === 'open' && !opened) {
        opened = true;
        if (!published) await publish();
        return;
    }
    if (ev.event !== 'message' || typeof ev.message !== 'string') return;
    const m = await open(key, topic, ev.message);
    if (!m || m.dir !== 't2c' || m.re !== id) return;
    clearTimeout(timer);
    abort.abort();
    const ok = m.ok === true;
    const good = expect === 'any' || (expect === 'ok' ? ok : !ok);
    done(good ? 0 : 1, { ok, msg: m.msg, data: m.data || {} });
}

// 2. Read the NDJSON stream line by line; publish once ntfy says the subscription is open.
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
try {
    for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) await onLine(line);
        }
    }
} catch (e) {
    if (!abort.signal.aborted) done(2, { error: 'relay stream ended: ' + (e && e.message) });
}
done(2, { error: 'relay closed the stream' });
