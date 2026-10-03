// Office TV relay protocol v1 (tv-app/PROTOCOL.md). Plain ES module for browsers and Node 22.
// Canonical vectors: tv-app/tests/vectors.json.
import { Relay } from './relay.js';

export { BROKERS, Relay } from './relay.js';
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CONTROLLER_URL = 'https://nikhildiwakar-bit.github.io/Portfolio/tv/';
export const DEFAULT_RELAY = 'https://ntfy.sh';
export const MAX_ENVELOPE_BYTES = 3900;

const enc = new TextEncoder();
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function subtle() {
    const s = globalThis.crypto && globalThis.crypto.subtle;
    if (!s) throw new Error('crypto.subtle is not available (page must be opened over https)');
    return s;
}

function randomBytes(n) {
    return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    return Uint8Array.from(x);
}

function hex(bytes) {
    let s = '';
    for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
    return s;
}

async function sha256(text) {
    return new Uint8Array(await subtle().digest('SHA-256', enc.encode(text)));
}

// ---------- §1 pairing code ----------

/**
 * TV code of user input, or null. Office TV 3.6+ TVs show a 4-digit code (a new one every time the app opens);
 * older TVs a 10-symbol code. Spaces and dashes are ignored, O counts as 0 and I/L as 1.
 */
export function normalizeCode(input) {
    if (typeof input !== 'string') return null;
    const s = input.toUpperCase()
        .replace(/[\s\-\u2010-\u2015\uFEFF]+/g, '')
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1');
    if (SHORT_CODE.test(s)) return s;
    if (s.length !== 10) return null;
    for (const ch of s) if (ALPHABET.indexOf(ch) < 0) return null;
    return s;
}

const SHORT_CODE = /^[0-9]{4}$/;

/** True for a 4-digit code (Office TV 3.6+). */
export function isShortCode(code) {
    return typeof code === 'string' && SHORT_CODE.test(code);
}

export function displayCode(code) {
    const c = normalizeCode(code);
    if (!c) return '';
    return isShortCode(c) ? c : c.slice(0, 5) + '-' + c.slice(5);
}

function codeOrThrow(code) {
    const c = normalizeCode(code);
    if (!c) throw new Error('invalid pairing code');
    return c;
}

// ---------- §2 derivation ----------

/** Relay topic: v1 for 10-symbol codes, v2 ("otv2...") for 4-digit codes, so the two can never meet. */
export async function deriveTopic(code) {
    const c = codeOrThrow(code);
    if (isShortCode(c)) return 'otv2' + hex((await sha256('officetv/topic/v2:' + c)).subarray(0, 16));
    return 'otv' + hex((await sha256('officetv/topic/v1:' + c)).subarray(0, 16));
}

/** Raw 32 key bytes (exposed for tests and tools; apps should use deriveKey). */
export async function deriveKeyBytes(code) {
    const c = codeOrThrow(code);
    return sha256((isShortCode(c) ? 'officetv/key/v2:' : 'officetv/key/v1:') + c);
}

export async function deriveKey(code) {
    return subtle().importKey('raw', await deriveKeyBytes(code), { name: 'AES-GCM' }, false,
        ['encrypt', 'decrypt']);
}

// ---------- base64url ----------

export function b64url(bytes) {
    const u8 = toBytes(bytes);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url with or without '=' padding. Throws on malformed input. */
export function unb64url(str) {
    if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(str)) throw new Error('bad base64url');
    let s = str.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    if (s.length % 4 === 1) throw new Error('bad base64url');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// ---------- §3 envelope ----------

function gcm(iv, aad) {
    return { name: 'AES-GCM', iv, additionalData: enc.encode(aad), tagLength: 128 };
}

function ivOrRandom(iv) {
    const v = iv ? toBytes(iv) : randomBytes(12);
    if (v.length !== 12) throw new Error('iv must be 12 bytes');
    return v;
}

export async function sealText(key, topic, text, iv) {
    const nonce = ivOrRandom(iv);
    const ct = await subtle().encrypt(gcm(nonce, topic), key, enc.encode(text));
    return 'otv1.' + b64url(nonce) + '.' + b64url(new Uint8Array(ct));
}

export function seal(key, topic, obj, iv) {
    return sealText(key, topic, JSON.stringify(obj), iv);
}

/** Decrypts an envelope into its JSON object. Returns null for anything invalid; never throws. */
export async function open(key, topic, envelope) {
    try {
        if (typeof envelope !== 'string' || envelope.length > 100000) return null;
        const parts = envelope.trim().split('.');
        if (parts.length !== 3 || parts[0] !== 'otv1') return null;
        const iv = unb64url(parts[1]);
        const ct = unb64url(parts[2]);
        if (iv.length !== 12 || ct.length < 16) return null;
        const pt = await subtle().decrypt(gcm(iv, topic), key, ct);
        const obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pt));
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch (e) {
        return null;
    }
}

/** Encrypts file bytes for an attachment (AAD = topic + ':file'). */
export async function sealFile(key, topic, bytes, iv) {
    const nonce = ivOrRandom(iv);
    const ct = await subtle().encrypt(gcm(nonce, topic + ':file'), key, toBytes(bytes));
    return { iv: b64url(nonce), data: new Uint8Array(ct) };
}

/** Reverse of sealFile. Returns the plaintext bytes, or null if they do not decrypt. */
export async function openFile(key, topic, iv, data) {
    try {
        const nonce = typeof iv === 'string' ? unb64url(iv) : toBytes(iv);
        if (nonce.length !== 12) return null;
        return new Uint8Array(await subtle().decrypt(gcm(nonce, topic + ':file'), key, toBytes(data)));
    } catch (e) {
        return null;
    }
}

// ---------- ids, names, pairing links ----------

export function newId(len = 12) {
    const n = Math.max(10, len | 0);
    let out = '';
    while (out.length < n) {
        for (const b of randomBytes(n * 2)) {
            if (b < 252 && out.length < n) out += BASE36[b % 36]; // 252 = 7 * 36, keeps it unbiased
        }
    }
    return out;
}

/** Trims a TV name to what the TV accepts (1-40 chars, no control characters). */
export function cleanName(name) {
    return String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 40).trim();
}

/** Accepts only http(s) relay URLs; returns them without a trailing slash, or null. */
export function normalizeRelay(url) {
    try {
        const u = new URL(String(url).trim());
        if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
        return (u.origin + u.pathname).replace(/\/+$/, '');
    } catch (e) {
        return null;
    }
}

/** '#pair=CODE&name=..&relay=..' (or a whole pairing link) -> {code, name, relay} | null. */
export function parsePairFragment(hash) {
    if (typeof hash !== 'string') return null;
    let s = hash.trim();
    const at = s.indexOf('#');
    if (at >= 0) s = s.slice(at + 1);
    else if (s.indexOf('?') >= 0) s = s.slice(s.indexOf('?') + 1);
    let p;
    try {
        p = new URLSearchParams(s);
    } catch (e) {
        return null;
    }
    const code = normalizeCode(p.get('pair') || '');
    if (!code) return null;
    const rawRelay = p.get('relay');
    const relay = rawRelay ? normalizeRelay(rawRelay) : DEFAULT_RELAY;
    if (!relay) return null;
    return { code, name: cleanName(p.get('name') || ''), relay };
}

export function pairLink(code, name, relay) {
    let url = CONTROLLER_URL + '#pair=' + normalizeCode(code);
    if (name) url += '&name=' + encodeURIComponent(name);
    if (relay && normalizeRelay(relay) !== DEFAULT_RELAY) url += '&relay=' + encodeURIComponent(relay);
    return url;
}

// ---------- acks ----------

// ntfy 429 codes: 42901 = too many requests right now; 42905/42908 = daily attachment/message quota.
const BURST_CODES = [42901, 42903];
const DAILY_CODES = [42902, 42905, 42908, 42910];

function rateLimitInfo(body) {
    let code = 0;
    try { code = Number(JSON.parse(body).code) || 0; } catch (e) { /* not JSON */ }
    const limit = BURST_CODES.indexOf(code) >= 0 ? 'burst' : DAILY_CODES.indexOf(code) >= 0 ? 'daily' : 'unknown';
    return { status: 429, relayCode: code, limit };
}

function linkError(code, message, extra) {
    const e = new Error(message || code);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
}

/** Merges the parts of one ack (a TV may split a long reply over several) into {ok, msg, data}. */
export function mergeAcks(acks) {
    const list = acks.slice().sort((a, b) => (a.part | 0) - (b.part | 0));
    const data = {};
    for (const a of list) {
        const d = a.data && typeof a.data === 'object' && !Array.isArray(a.data) ? a.data : {};
        for (const k of Object.keys(d)) data[k] = d[k];
    }
    const first = list.find(a => typeof a.msg === 'string' && a.msg);
    return {
        ok: list.length > 0 && list.every(a => a.ok === true),
        msg: first ? first.msg : '',
        data,
    };
}

// ---------- TvLink ----------

/** 4-digit codes: a command sent over MQTT only goes out once more over ntfy if no ack came in this time. */
export const NTFY_FALLBACK_MS = 2500;

/**
 * One paired TV. Messages come and go through one Relay (tv/relay.js): for a 4-digit code the MQTT brokers
 * plus the ntfy event stream, for a 10-symbol code the ntfy event stream and simple CORS POSTs, as before.
 * state: 'unknown' | 'online' | 'offline'. onchange(link) fires when state/status/connected change.
 * Other messages on the topic (screen sharing signals) go to listen() callbacks, so a sharing session
 * needs no second connection. suspend() closes the transports while nothing needs them.
 * transports: 'auto' (the website), 'mqtt' (brokers only, no ntfy) or 'ntfy' (no brokers); the last two are
 * for CI and tests. lastAckVia: the transport the last completed ack came over ('mqtt' | 'ntfy').
 * brokers (default tv/relay.js BROKERS), WebSocket, EventSource and fetch can be injected (tests, CI).
 * Every message is handled once per id, however many brokers and ntfy deliver it.
 */
export class TvLink {
    constructor({
        code, name = '', relay = DEFAULT_RELAY, fetch: fetchFn, EventSource: ES, WebSocket: WS, brokers,
        transports = 'auto', ntfyFallbackMs = NTFY_FALLBACK_MS,
    } = {}) {
        const c = normalizeCode(code);
        if (!c) throw new Error('invalid pairing code');
        this.code = c;
        this.name = cleanName(name);
        this.relay = normalizeRelay(relay || DEFAULT_RELAY) || DEFAULT_RELAY;
        this.short = isShortCode(c);
        this.topic = null;
        this.key = null;
        this.state = 'unknown';
        this.status = null;
        this.connected = false;
        this.lastAckAt = 0;
        this.lastPingAt = 0;
        this.lastAckVia = '';
        this.clockOffsetMs = 0;
        this.onchange = null;
        this.transport = null; // the Relay, while open
        this._fetch = fetchFn || ((...a) => globalThis.fetch(...a));
        this._ES = ES || globalThis.EventSource;
        this._WS = WS;
        this._brokers = brokers;
        this._transports = transports;
        this._fallbackMs = ntfyFallbackMs;
        this._pending = new Map();
        this._listeners = new Set();
        this._recent = [];
        this._seen = [];
        this._closed = false;
        this._initP = null;
    }

    init() {
        if (!this._initP) {
            this._initP = (async () => {
                this.topic = await deriveTopic(this.code);
                this.key = await deriveKey(this.code);
                this._connect();
            })();
            this._initP.catch(() => { this._initP = null; });
        }
        return this._initP;
    }

    get url() {
        return this.relay + '/' + this.topic;
    }

    _emit() {
        if (typeof this.onchange === 'function') {
            try { this.onchange(this); } catch (e) { /* UI errors must not break the link */ }
        }
    }

    _setState(s) {
        if (this.state !== s) {
            this.state = s;
            this._emit();
        }
    }

    // --- transports ---

    /** Opens the Relay if needed; one that is waiting for a reconnect back-off reconnects now. */
    _connect() {
        if (this._closed || !this.topic) return null;
        if (this.transport) {
            if (!this.transport.connected) this.transport.kick();
            return this.transport;
        }
        const t = new Relay({
            topic: this.topic, code: this.code,
            ntfy: this._transports === 'mqtt' ? false : this.relay,
            brokers: this._transports === 'ntfy' ? [] : this._brokers,
            WebSocket: this._WS, EventSource: this._ES, fetch: this._fetch,
        });
        this.transport = t;
        t.onmessage = (env, meta) => { if (t === this.transport) this._onEnvelope(env, meta); };
        t.onchange = () => { if (t === this.transport) this._setConnected(t.connected); };
        t.ontime = sec => { if (t === this.transport) this._noteServerTime(sec); };
        t.start();
        return t;
    }

    _setConnected(on) {
        if (this.connected === on) return;
        this.connected = on;
        this._emit();
    }

    /** Resolves true once the relay can carry a message (tv/relay.js ready()), or false after ms. */
    _waitConnected(ms) {
        const t = this._connect();
        return t ? t.ready(ms) : Promise.resolve(false);
    }

    _noteServerTime(sec) {
        if (typeof sec !== 'number' || !isFinite(sec)) return;
        const off = sec * 1000 - Date.now();
        // Only correct clocks that are clearly wrong; ntfy time has 1 s resolution.
        this.clockOffsetMs = Math.abs(off) > 30000 ? off : 0;
    }

    /**
     * Publishes a sealed envelope over this link's relay (screen sharing signals use it). Resolves with the
     * Relay's result {via, ok, status?, body?}; never throws.
     */
    publishEnvelope(envelope, opts) {
        const t = this._connect();
        if (!t) return Promise.resolve({ via: 'ntfy', ok: false, status: 0, error: new Error('link closed') });
        return t.publish(envelope, opts);
    }

    async _onEnvelope(body, meta) {
        if (typeof body !== 'string' || body.indexOf('otv1.') !== 0 || !this.key) return;
        const m = await open(this.key, this.topic, body);
        if (!m || this._closed) return;
        // The same message can arrive over three brokers and ntfy: handle each id once.
        if (typeof m.id === 'string') {
            if (this._seen.indexOf(m.id) >= 0) return;
            this._seen.push(m.id);
            if (this._seen.length > 256) this._seen.shift();
        }
        const info = meta && typeof meta === 'object' ? meta : { via: 'ntfy', time: Date.now() / 1000 };
        if (m.dir !== 't2c') {
            // Commands (own echoes) and screen sharing signals: listeners filter what they need.
            for (const fn of Array.from(this._listeners)) {
                try { fn(m, info); } catch (e) { /* a listener must not break the link */ }
            }
            return;
        }
        if (typeof m.re !== 'string') return;
        const p = this._pending.get(m.re);
        if (p) {
            this._onAckPart(p, m, info);
        } else if (this._recent.indexOf(m.re) >= 0) {
            // Late ack for a command that already timed out: the TV is alive after all.
            this.lastAckAt = Date.now();
            this._setState('online');
        }
    }

    _onAckPart(p, m, info) {
        const parts = Math.max(1, Math.min(100, parseInt(m.parts, 10) || 1));
        const part = Math.max(0, parseInt(m.part, 10) || 0);
        p.parts = parts;
        if (p.got.has(part)) return;
        p.got.set(part, m);
        if (!p.via) p.via = info.via || '';
        this.lastAckAt = Date.now();
        if (p.got.size >= p.parts) this._finish(p, false);
    }

    _finish(p, partial) {
        if (!this._pending.has(p.id)) return;
        this._pending.delete(p.id);
        clearTimeout(p.timer);
        clearTimeout(p.fallback);
        const ack = mergeAcks(Array.from(p.got.values()));
        if (partial) ack.partial = true;
        if (p.cmd === 'ping' && ack.ok && ack.data && typeof ack.data.name === 'string') {
            this.status = ack.data;
        }
        this.lastAckVia = p.via || '';
        this.state = 'online';
        this._emit();
        p.resolve(ack);
    }

    _fail(p, code, message, extra) {
        if (!this._pending.has(p.id)) return;
        this._pending.delete(p.id);
        clearTimeout(p.timer);
        clearTimeout(p.fallback);
        if (code === 'timeout') this._setState('offline');
        p.reject(linkError(code, message, extra));
    }

    _remember(id) {
        this._recent.push(id);
        if (this._recent.length > 64) this._recent.shift();
    }

    // --- commands ---

    /**
     * Sends one command and resolves with its ack {ok, msg, data} (plus partial: true if some parts of a
     * multi-part ack never came). Rejects with err.code 'timeout' | 'rate_limit' | 'network' | 'relay' | 'closed';
     * rate_limit errors also carry err.limit 'burst' | 'daily' | 'unknown'.
     * 4-digit codes: sent to every connected MQTT broker; if no ack came within 2.5 s (fallbackMs), the same
     * envelope goes out once more over ntfy (the TV may reach other brokers, or none), unless heard() showed the
     * TV already has it. Without a broker it goes over ntfy.
     */
    async send(cmd, args, { timeoutMs = 15000, fallbackMs = this._fallbackMs } = {}) {
        await this.init();
        if (this._closed) throw linkError('closed', 'link closed');
        const id = newId();
        this._remember(id);
        if (cmd === 'ping') this.lastPingAt = Date.now();
        return new Promise((resolve, reject) => {
            const p = {
                id, cmd, args: args || {}, got: new Map(), parts: 1, resolve, reject, timer: null, fallback: null,
                fallbackMs, heard: false, via: '',
            };
            this._pending.set(id, p);
            p.timer = setTimeout(() => {
                if (p.got.size) this._finish(p, true);
                else this._fail(p, 'timeout', 'TV did not answer', p.fallbackError ? { fallbackError: p.fallbackError } : undefined);
            }, timeoutMs);
            this._post(p, cmd, args);
        });
    }

    async _post(p, cmd, args) {
        // The ack is only delivered to open subscriptions, so give the relay a moment first.
        await this._waitConnected(5000);
        if (!this._pending.has(p.id)) return;
        let envelope;
        try {
            envelope = await seal(this.key, this.topic, {
                v: 1, dir: 'c2t', id: p.id, ts: Date.now() + this.clockOffsetMs, cmd, args: args || {},
            });
        } catch (e) {
            this._fail(p, 'relay', 'encrypt failed: ' + e.message);
            return;
        }
        const r = await this.publishEnvelope(envelope);
        if (!this._pending.has(p.id)) return;
        if (!r.ok) {
            this._failPublish(p, r);
            return;
        }
        const t = this.transport;
        if (r.via === 'mqtt' && p.fallbackMs > 0 && t && t.ntfy && !p.heard) {
            p.fallback = setTimeout(() => this._fallback(p, envelope), p.fallbackMs);
        }
    }

    async _fallback(p, envelope) {
        if (!this._pending.has(p.id) || p.got.size || p.heard || !this.transport) return;
        const r = await this.transport.publish(envelope, { via: 'ntfy' });
        // The MQTT copy may still be answered, so a failed ntfy copy does not fail the command.
        if (!r.ok) p.fallbackError = publishError(r);
    }

    _failPublish(p, r) {
        const e = publishError(r);
        this._fail(p, e.code, e.message, e.extra);
    }

    /**
     * The TV's screen sharing receiver for `session` spoke (its 'ready' signal, tv/cast.js), so the TV has the
     * 'cast start' of that session: its ntfy copy is not needed. The TV acks 'cast start' only once its screen is
     * open, often later than 2.5 s; this keeps a normal share free of ntfy messages (daily quota).
     */
    heard(session) {
        for (const p of this._pending.values()) {
            if (p.cmd === 'cast' && p.args.action === 'start' && p.args.session === session) {
                p.heard = true;
                clearTimeout(p.fallback);
                p.fallback = null;
            }
        }
    }

    ping(opts) {
        return this.send('ping', {}, opts);
    }

    /** fn(message, meta) gets every decrypted message that is not an ack; meta = {via, time}. Returns an unsubscribe function. */
    listen(fn) {
        this._listeners.add(fn);
        return () => { this._listeners.delete(fn); };
    }

    /** Derives the keys and opens the relay if needed. Resolves true once it can carry messages, false after ms. */
    async ready(ms = 8000) {
        await this.init();
        if (this._closed) return false;
        return this._waitConnected(ms);
    }

    /**
     * Closes the relay while nothing needs it (no command waiting for an ack, no listener), so an idle page
     * holds no relay connection. The next send() or ready() opens it again. Returns true if idle.
     */
    suspend() {
        if (this._pending.size || this._listeners.size) return false;
        const t = this.transport;
        this.transport = null;
        if (t) t.close();
        this._setConnected(false);
        return true;
    }

    close() {
        this._closed = true;
        const t = this.transport;
        this.transport = null;
        if (t) t.close();
        this.connected = false;
        for (const p of Array.from(this._pending.values())) this._fail(p, 'closed', 'link closed');
    }
}

/** {code, message, extra} for a failed Relay publish. */
function publishError(r) {
    if (r.status === 429) return { code: 'rate_limit', message: 'relay limit reached', extra: rateLimitInfo(r.body || '') };
    if (!r.status) return { code: 'network', message: 'network error: ' + (r.error && r.error.message), extra: undefined };
    return { code: 'relay', message: 'relay HTTP ' + r.status, extra: { status: r.status } };
}
