// Office TV relay protocol v1 (tv-app/PROTOCOL.md). Plain ES module for browsers and Node 22.
// Canonical vectors: tv-app/tests/vectors.json.

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CONTROLLER_URL = 'https://nikhildiwakar-bit.github.io/Portfolio/tv/';
export const DEFAULT_RELAY = 'https://ntfy.sh';
/** Largest file sendFile() accepts (plaintext). ntfy.sh caps attachments at about 15 MB. */
export const MAX_FILE_BYTES = 15 * 1000 * 1000;
export const MAX_ENVELOPE_BYTES = 3900;

const enc = new TextEncoder();
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const RECONNECT_S = [1, 2, 4, 8, 16, 30, 60];

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

export function normalizeCode(input) {
    if (typeof input !== 'string') return null;
    const s = input.toUpperCase()
        .replace(/[\s\-\u2010-\u2015]+/g, '')
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1');
    if (s.length !== 10) return null;
    for (const ch of s) if (ALPHABET.indexOf(ch) < 0) return null;
    return s;
}

export function displayCode(code) {
    const c = normalizeCode(code);
    return c ? c.slice(0, 5) + '-' + c.slice(5) : '';
}

function codeOrThrow(code) {
    const c = normalizeCode(code);
    if (!c) throw new Error('invalid pairing code');
    return c;
}

// ---------- §2 derivation ----------

export async function deriveTopic(code) {
    const h = await sha256('officetv/topic/v1:' + codeOrThrow(code));
    return 'otv' + hex(h.subarray(0, 16));
}

/** Raw 32 key bytes (exposed for tests and tools; apps should use deriveKey). */
export async function deriveKeyBytes(code) {
    return sha256('officetv/key/v1:' + codeOrThrow(code));
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

async function readText(res) {
    try { return await res.text(); } catch (e) { return ''; }
}

function linkError(code, message, extra) {
    const e = new Error(message || code);
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
}

/** Merges the parts of one ack (the 'apps' list comes in several) into {ok, msg, data}. */
export function mergeAcks(acks) {
    const list = acks.slice().sort((a, b) => (a.part | 0) - (b.part | 0));
    const data = {};
    let apps = null;
    for (const a of list) {
        const d = a.data && typeof a.data === 'object' && !Array.isArray(a.data) ? a.data : {};
        for (const k of Object.keys(d)) {
            if (k === 'apps' && Array.isArray(d.apps)) apps = (apps || []).concat(d.apps);
            else data[k] = d[k];
        }
    }
    if (apps) data.apps = apps;
    const first = list.find(a => typeof a.msg === 'string' && a.msg);
    return {
        ok: list.length > 0 && list.every(a => a.ok === true),
        msg: first ? first.msg : '',
        data,
    };
}

// ---------- TvLink ----------

/**
 * One paired TV. Events come over one EventSource; commands are simple CORS POSTs.
 * state: 'unknown' | 'online' | 'offline'. onchange(link) fires when state/status/connected change.
 */
export class TvLink {
    constructor({ code, name = '', relay = DEFAULT_RELAY, fetch: fetchFn, EventSource: ES, XMLHttpRequest: XHR } = {}) {
        const c = normalizeCode(code);
        if (!c) throw new Error('invalid pairing code');
        this.code = c;
        this.name = cleanName(name);
        this.relay = normalizeRelay(relay || DEFAULT_RELAY) || DEFAULT_RELAY;
        this.topic = null;
        this.key = null;
        this.state = 'unknown';
        this.status = null;
        this.connected = false;
        this.lastAckAt = 0;
        this.lastPingAt = 0;
        this.clockOffsetMs = 0;
        this.onchange = null;
        this._fetch = fetchFn || ((...a) => globalThis.fetch(...a));
        this._ES = ES || globalThis.EventSource;
        this._XHR = XHR || (fetchFn ? null : globalThis.XMLHttpRequest);
        this._pending = new Map();
        this._recent = [];
        this._es = null;
        this._retry = 0;
        this._retryTimer = null;
        this._openWaiters = [];
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

    // --- subscription ---

    _connect() {
        if (this._closed || !this._ES || !this.topic) return;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        if (this._es) {
            try { this._es.close(); } catch (e) { /* ignore */ }
        }
        let es;
        try {
            es = new this._ES(this.url + '/sse');
        } catch (e) {
            this._es = null;
            this._scheduleReconnect();
            return;
        }
        this._es = es;
        es.onopen = () => {
            if (es !== this._es) return;
            this._retry = 0;
            this._setConnected(true);
        };
        es.onmessage = ev => {
            if (es === this._es) this._onEvent(ev && ev.data);
        };
        const named = ev => {
            // ntfy sends 'open' and 'keepalive' as named SSE events; the built-in 'open' has no data.
            if (es === this._es && ev && typeof ev.data === 'string') this._onEvent(ev.data);
        };
        if (typeof es.addEventListener === 'function') {
            es.addEventListener('open', named);
            es.addEventListener('keepalive', named);
        }
        es.onerror = () => {
            if (es !== this._es) return;
            this._setConnected(false);
            // CONNECTING (0): the browser retries by itself. CLOSED (2): it gave up, so we retry.
            if (es.readyState === 2) this._scheduleReconnect();
        };
    }

    _setConnected(on) {
        if (this.connected === on) return;
        this.connected = on;
        if (on) {
            const w = this._openWaiters;
            this._openWaiters = [];
            for (const f of w) f(true);
        }
        this._emit();
    }

    _scheduleReconnect() {
        if (this._closed || this._retryTimer) return;
        const s = RECONNECT_S[Math.min(this._retry++, RECONNECT_S.length - 1)];
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this._connect();
        }, s * 1000);
    }

    /** Resolves true once the event stream is open, or false after ms. */
    _waitConnected(ms) {
        if (this.connected) return Promise.resolve(true);
        if (!this._es || this._es.readyState === 2) this._connect();
        return new Promise(resolve => {
            const t = setTimeout(() => {
                this._openWaiters = this._openWaiters.filter(f => f !== done);
                resolve(false);
            }, ms);
            const done = v => { clearTimeout(t); resolve(v); };
            this._openWaiters.push(done);
        });
    }

    _noteServerTime(sec) {
        if (typeof sec !== 'number' || !isFinite(sec)) return;
        const off = sec * 1000 - Date.now();
        // Only correct clocks that are clearly wrong; ntfy time has 1 s resolution.
        this.clockOffsetMs = Math.abs(off) > 30000 ? off : 0;
    }

    async _onEvent(raw) {
        if (typeof raw !== 'string') return;
        let body = raw;
        let ev = null;
        try { ev = JSON.parse(raw); } catch (e) { /* not JSON: maybe a bare envelope */ }
        if (ev && typeof ev === 'object') {
            if (ev.event === 'open' || ev.event === 'keepalive') {
                this._noteServerTime(ev.time);
                return;
            }
            if (ev.event && ev.event !== 'message') return;
            body = ev.message;
        }
        if (typeof body !== 'string' || body.indexOf('otv1.') !== 0 || !this.key) return;
        const m = await open(this.key, this.topic, body);
        if (!m || m.dir !== 't2c' || typeof m.re !== 'string') return; // own echoes, other senders
        const p = this._pending.get(m.re);
        if (p) {
            this._onAckPart(p, m);
        } else if (this._recent.indexOf(m.re) >= 0) {
            // Late ack for a command that already timed out: the TV is alive after all.
            this.lastAckAt = Date.now();
            this._setState('online');
        }
    }

    _onAckPart(p, m) {
        const parts = Math.max(1, Math.min(100, parseInt(m.parts, 10) || 1));
        const part = Math.max(0, parseInt(m.part, 10) || 0);
        p.parts = parts;
        if (p.got.has(part)) return;
        p.got.set(part, m);
        this.lastAckAt = Date.now();
        if (p.got.size >= p.parts) this._finish(p, false);
    }

    _finish(p, partial) {
        if (!this._pending.has(p.id)) return;
        this._pending.delete(p.id);
        clearTimeout(p.timer);
        const ack = mergeAcks(Array.from(p.got.values()));
        if (partial) ack.partial = true;
        if ((p.cmd === 'ping' || p.cmd === 'rename') && ack.ok && ack.data && typeof ack.data.name === 'string') {
            this.status = ack.data;
        }
        this.state = 'online';
        this._emit();
        p.resolve(ack);
    }

    _fail(p, code, message, extra) {
        if (!this._pending.has(p.id)) return;
        this._pending.delete(p.id);
        clearTimeout(p.timer);
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
     */
    async send(cmd, args, { timeoutMs = 15000 } = {}) {
        await this.init();
        if (this._closed) throw linkError('closed', 'link closed');
        const id = newId();
        this._remember(id);
        if (cmd === 'ping') this.lastPingAt = Date.now();
        return new Promise((resolve, reject) => {
            const p = { id, cmd, got: new Map(), parts: 1, resolve, reject, timer: null };
            this._pending.set(id, p);
            p.timer = setTimeout(() => {
                if (p.got.size) this._finish(p, true);
                else this._fail(p, 'timeout', 'TV did not answer');
            }, timeoutMs);
            this._post(p, cmd, args);
        });
    }

    async _post(p, cmd, args) {
        // The ack is only delivered to open subscriptions, so give the stream a moment first.
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
        let res;
        try {
            res = await this._fetch(this.url + '?firebase=no', {
                method: 'POST', body: envelope, credentials: 'omit', referrerPolicy: 'no-referrer',
            });
        } catch (e) {
            this._fail(p, 'network', 'network error: ' + (e && e.message));
            return;
        }
        if (res.status === 429) {
            this._fail(p, 'rate_limit', 'relay limit reached', rateLimitInfo(await readText(res)));
            return;
        }
        if (!res.ok) {
            this._fail(p, 'relay', 'relay HTTP ' + res.status, { status: res.status });
            return;
        }
        try {
            const j = await res.json();
            if (j && typeof j.time === 'number') this._noteServerTime(j.time);
        } catch (e) { /* body is optional */ }
    }

    ping(opts) {
        return this.send('ping', {}, opts);
    }

    /** Encrypts and uploads a File/Blob (<= MAX_FILE_BYTES) and asks the TV to open it. */
    async sendFile(file, { onProgress, timeoutMs = 90000 } = {}) {
        await this.init();
        const size = file && typeof file.size === 'number' ? file.size : -1;
        if (size < 0) throw linkError('relay', 'not a file');
        if (size > MAX_FILE_BYTES) throw linkError('too_big', 'file too big', { size, max: MAX_FILE_BYTES });
        const progress = f => {
            if (typeof onProgress === 'function') {
                try { onProgress(Math.max(0, Math.min(1, f))); } catch (e) { /* ignore */ }
            }
        };
        progress(0);
        const bytes = await readBytes(file);
        const sealed = await sealFile(this.key, this.topic, bytes);
        progress(0.03);
        const res = await this._upload(this.url + '?filename=otv.bin&firebase=no', sealed.data,
            f => progress(0.03 + f * 0.87));
        const url = res && res.attachment && res.attachment.url;
        if (typeof url !== 'string' || !url) throw linkError('relay', 'relay returned no attachment url');
        progress(0.92);
        const name = String(file.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'file';
        const ack = await this.send('file', { url, name, iv: sealed.iv, size }, { timeoutMs });
        progress(1);
        return ack;
    }

    _upload(url, data, onFrac) {
        // 413: the relay refused the size (its limit may be lower than ours).
        const tooBig = () => linkError('too_big', 'relay refused the file size', { size: data.length - 16, max: MAX_FILE_BYTES, status: 413 });
        const viaFetch = async () => {
            let res;
            try {
                res = await this._fetch(url, { method: 'POST', body: data, credentials: 'omit', referrerPolicy: 'no-referrer' });
            } catch (e) {
                throw linkError('network', 'upload failed: ' + (e && e.message));
            }
            if (res.status === 429) throw linkError('rate_limit', 'relay limit reached', rateLimitInfo(await readText(res)));
            if (res.status === 413) throw tooBig();
            if (!res.ok) throw linkError('relay', 'relay HTTP ' + res.status, { status: res.status });
            onFrac(1);
            try { return await res.json(); } catch (e) { throw linkError('relay', 'bad relay reply'); }
        };
        if (!this._XHR) return viaFetch();
        return new Promise((resolve, reject) => {
            const x = new this._XHR();
            x.open('POST', url);
            x.upload.onprogress = e => { if (e.lengthComputable && e.total) onFrac(e.loaded / e.total); };
            x.onload = () => {
                if (x.status === 429) return reject(linkError('rate_limit', 'relay limit reached', rateLimitInfo(x.responseText)));
                if (x.status === 413) return reject(tooBig());
                if (x.status < 200 || x.status >= 300) return reject(linkError('relay', 'relay HTTP ' + x.status, { status: x.status }));
                onFrac(1);
                try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(linkError('relay', 'bad relay reply')); }
            };
            // Progress listeners force a CORS preflight; if that is refused, retry once as a simple request.
            x.onerror = () => viaFetch().then(resolve, reject);
            x.send(data);
        });
    }

    close() {
        this._closed = true;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        if (this._es) {
            try { this._es.close(); } catch (e) { /* ignore */ }
        }
        this._es = null;
        this.connected = false;
        for (const p of Array.from(this._pending.values())) this._fail(p, 'closed', 'link closed');
        for (const f of this._openWaiters) f(false);
        this._openWaiters = [];
    }
}

async function readBytes(file) {
    if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
    if (typeof FileReader !== 'undefined') {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(new Uint8Array(r.result));
            r.onerror = () => reject(r.error);
            r.readAsArrayBuffer(file);
        });
    }
    throw new Error('cannot read file');
}
