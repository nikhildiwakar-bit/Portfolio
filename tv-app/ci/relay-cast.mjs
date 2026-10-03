#!/usr/bin/env node
// Real relay test for the emulator smoke test (smoke.sh): talks to the Office TV app on the emulator through
// the public relays exactly like the website does, with the website's own code (tv/otv.js TvLink over
// tv/relay.js: same topic, key and encrypted envelopes, PROTOCOL.md sections 2-6). 4-digit codes (Office TV
// 3.6+) use the public MQTT brokers and ntfy.sh like the website; 10-symbol codes ntfy.sh only.
//
//   node relay-cast.mjs --code <TV code> --step ping|start|stop [--session <id>] [--expect ok|fail|any]
//                       [--relay https://ntfy.sh] [--timeout <seconds, default 45>] [--transport auto|mqtt|ntfy]
//
// --transport (4-digit codes): auto = the website's behaviour (every broker, and the same envelope over ntfy
// if no ack came within 2.5 s); mqtt = the brokers only (no ntfy at all); ntfy = ntfy only. 10-symbol codes
// always use ntfy (mqtt is an error for them).
//
// Prints one line: RESULT {"step":..,"exit":..,"ms":..,"ok":..,"msg":..,"data":..,"via":..,"brokers":..} and exits
//   0  an ack arrived and its ok matches --expect (default ok); via = the transport it came over (mqtt | ntfy)
//   1  failure: no ack in time, or an ack with the wrong ok
//   2  warning: the relay is unreachable from this machine or rate limited (HTTP 429)
// Needs Node 22+ (fetch, WebCrypto, WebSocket). ntfy is read as its NDJSON stream (/json), so no EventSource
// is needed.
import { TvLink, isShortCode, normalizeCode } from '../../tv/otv.js';

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
const transport = arg('transport', 'auto');
const started = Date.now();
let link = null;

function done(exit, fields) {
    const out = Object.assign({ step, exit, ms: Date.now() - started, transport }, fields);
    if (link && link.transport) out.brokers = link.transport.mqttCount;
    console.log('RESULT ' + JSON.stringify(out));
    process.exit(exit);
}

if (!code) done(1, { error: 'missing or invalid --code' });
if (['auto', 'mqtt', 'ntfy'].indexOf(transport) < 0) done(1, { error: 'unknown --transport ' + transport });
if (transport === 'mqtt' && !isShortCode(code)) done(1, { error: '--transport mqtt needs a 4-digit code (Office TV 3.6+)' });
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

/**
 * The part of EventSource that tv/relay.js uses, over ntfy's NDJSON stream (<relay>/<topic>/json): onopen,
 * onmessage for 'message' events, named 'open' / 'keepalive' listeners, onerror + readyState 2 when the stream
 * ends (the relay then reconnects by itself), close().
 */
class NdjsonEventSource {
    constructor(url) {
        this.readyState = 0;
        this.listeners = {};
        this.onopen = this.onmessage = this.onerror = null;
        this._abort = new AbortController();
        this._run(url.replace(/\/sse(\?|$)/, '/json$1'));
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    close() {
        this.readyState = 2;
        this._abort.abort();
    }
    _emit(type, data) { for (const f of this.listeners[type] || []) f({ data }); }
    _fail(why) {
        if (this.readyState === 2) return;
        this.readyState = 2;
        this.lastError = why;
        NdjsonEventSource.lastError = why;
        if (this.onerror) this.onerror({});
    }
    async _run(url) {
        let res;
        try {
            res = await fetch(url, { signal: this._abort.signal, headers: { 'User-Agent': 'otv-ci-relay-cast' } });
        } catch (e) {
            this._fail('relay not reachable: ' + (e && e.message));
            return;
        }
        if (!res.ok || !res.body) {
            NdjsonEventSource.lastStatus = res.status;
            this._fail(res.status === 429 ? 'relay rate limit (HTTP 429) on subscribe' : 'relay subscribe HTTP ' + res.status);
            return;
        }
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
                    if (line) this._line(line);
                }
            }
        } catch (e) {
            if (this.readyState !== 2) this._fail('relay stream ended: ' + (e && e.message));
            return;
        }
        this._fail('relay closed the stream');
    }
    _line(line) {
        if (this.readyState === 2) return;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { return; }
        if (!ev || typeof ev !== 'object') return;
        if (ev.event === 'open') {
            this.readyState = 1;
            if (this.onopen) this.onopen({});
            this._emit('open', line);
        } else if (ev.event === 'keepalive') {
            this._emit('keepalive', line);
        } else if (ev.event === 'message' && this.onmessage) {
            this.onmessage({ data: line });
        }
    }
}

const timer = setTimeout(() => done(1, { error: 'no ack within ' + timeoutMs / 1000 + ' s' }), timeoutMs);

link = new TvLink({
    code, relay, EventSource: NdjsonEventSource,
    transports: isShortCode(code) ? transport : 'ntfy',
});

// 1. Connect first (the brokers and/or the ntfy stream), so the ack cannot be missed.
const readyMs = Math.min(20000, Math.max(3000, timeoutMs - 5000));
if (!await link.ready(readyMs)) {
    clearTimeout(timer);
    done(2, { error: NdjsonEventSource.lastError || (transport === 'mqtt' ? 'no MQTT broker reachable' : 'relay not reachable') });
}
if (transport === 'mqtt' && link.transport.mqttCount === 0) {
    clearTimeout(timer);
    done(2, { error: 'no MQTT broker reachable' });
}

// 2. One command, one ack.
try {
    const ack = await link.send(cmd, args, { timeoutMs: Math.max(3000, timeoutMs - (Date.now() - started) - 500) });
    clearTimeout(timer);
    const ok = ack.ok === true;
    const good = expect === 'any' || (expect === 'ok' ? ok : !ok);
    done(good ? 0 : 1, { ok, msg: ack.msg, data: ack.data || {}, via: link.lastAckVia });
} catch (e) {
    clearTimeout(timer);
    const c = e && e.code;
    if (c === 'rate_limit') done(2, { error: 'relay rate limit (HTTP 429) on publish', limit: e.limit });
    if (c === 'network' || c === 'relay') done(2, { error: 'publish failed: ' + (e && e.message) });
    if (c === 'timeout') {
        const extra = e.fallbackError ? ' (ntfy copy: ' + e.fallbackError.message + ')' : '';
        done(1, { error: 'no ack within ' + timeoutMs / 1000 + ' s' + extra });
    }
    done(1, { error: String((e && e.message) || e) });
}
