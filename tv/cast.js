// Office TV "Share my screen": laptop -> TV screen sharing over WebRTC (PROTOCOL.md section 8).
// Signaling (SDP offer/answer, with every ICE candidate inside) travels over the same encrypted relay
// topic as commands, in c2r (controller -> receiver) and r2c (receiver -> controller) messages that the
// TV app and TvLink both ignore. Media goes directly between the browsers; the relay never sees it.
import { MAX_ENVELOPE_BYTES, DEFAULT_RELAY, deriveKey, deriveTopic, newId, normalizeCode, normalizeRelay, open, seal } from './otv.js?v=2';

export const RECEIVER_URL = 'https://nikhildiwakar-bit.github.io/Portfolio/tv/receive.html';
export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
/** Max characters of signal payload per relay message; keeps each envelope well under 3,900 bytes. */
export const SIGNAL_CHUNK = 2400;
export const MAX_SIGNAL_PARTS = 8;
const FRESH_S = 300;

function castError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
}

// ---------- payload encoding ----------

function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

async function pipe(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
}

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
    && typeof Response === 'function' && typeof Blob === 'function';

/**
 * Encodes a session description {type, sdp} as text: "z" + base64url(deflate-raw(JSON)) when the browser
 * can compress (SDP shrinks about 3x, so an offer usually fits in one relay message), else "j" + JSON.
 */
export async function encodeSignal(desc, { compress = true } = {}) {
    const json = JSON.stringify({ type: desc.type, sdp: desc.sdp });
    if (compress && canCompress()) {
        try {
            return 'z' + b64(await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw')));
        } catch (e) { /* fall through to plain JSON */ }
    }
    return 'j' + json;
}

/** Inverse of encodeSignal. Returns {type, sdp} or null if the text is not a valid description. */
export async function decodeSignal(text) {
    if (typeof text !== 'string' || text.length < 2) return null;
    let json;
    try {
        if (text[0] === 'z') {
            if (!canCompress()) return null;
            json = new TextDecoder().decode(await pipe(unb64(text.slice(1)), new DecompressionStream('deflate-raw')));
        } else if (text[0] === 'j') {
            json = text.slice(1);
        } else return null;
        const d = JSON.parse(json);
        if (!d || (d.type !== 'offer' && d.type !== 'answer') || typeof d.sdp !== 'string') return null;
        return { type: d.type, sdp: d.sdp };
    } catch (e) {
        return null;
    }
}

// ---------- message format ----------

/**
 * Splits one signal into the plaintext relay messages that carry it:
 * {v:1, dir, id, ts, session, cast:'offer'|'answer'|'bye', part, parts, data}.
 */
export function signalMessages({ dir, session, cast, data = '', ts = Date.now() }) {
    const parts = Math.max(1, Math.ceil(data.length / SIGNAL_CHUNK));
    if (parts > MAX_SIGNAL_PARTS) throw castError('too_big', 'signal too large');
    const out = [];
    for (let i = 0; i < parts; i++) {
        out.push({
            v: 1, dir, id: newId(), ts, session, cast, part: i, parts,
            data: data.slice(i * SIGNAL_CHUNK, (i + 1) * SIGNAL_CHUNK),
        });
    }
    return out;
}

/** Collects parts per (session, cast). add(m) returns the joined data once every part arrived, else null. */
export class SignalAssembler {
    constructor() {
        this._map = new Map();
    }

    add(m) {
        const parts = parseInt(m.parts, 10);
        const part = parseInt(m.part, 10);
        if (!(parts >= 1 && parts <= MAX_SIGNAL_PARTS) || !(part >= 0 && part < parts) || typeof m.data !== 'string') return null;
        const k = m.session + '/' + m.cast;
        let e = this._map.get(k);
        if (!e || e.parts !== parts) {
            e = { parts, got: new Map() };
            this._map.set(k, e);
        }
        e.got.set(part, m.data);
        if (e.got.size < parts) return null;
        this._map.delete(k);
        let s = '';
        for (let i = 0; i < parts; i++) s += e.got.get(i);
        return s;
    }
}

export function validSession(s) {
    return typeof s === 'string' && /^[a-z0-9]{12,32}$/.test(s);
}

/** Receiver page URL. The pairing code is in the fragment, which never leaves the device. */
export function receiverUrl({ session, code, relay }, base = RECEIVER_URL) {
    let f = 's=' + session + '&code=' + code;
    const r = normalizeRelay(relay || '');
    if (r && r !== DEFAULT_RELAY) f += '&relay=' + encodeURIComponent(r);
    return base + '#' + f;
}

/** Parses the receiver fragment. Returns {session, code, relay} or null. */
export function parseReceiverFragment(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const session = p.get('s');
    const code = normalizeCode(p.get('code') || '');
    if (!validSession(session) || !code) return null;
    return { session, code, relay: normalizeRelay(p.get('relay') || '') || DEFAULT_RELAY };
}

// ---------- relay channel ----------

/**
 * One cast session's signaling over the relay. `out` is the direction this side sends ('c2r' or 'r2c');
 * it listens for the opposite one, the same session id, and fresh, never-seen message ids.
 * onsignal(cast, data) fires for each complete signal.
 */
export class CastChannel {
    constructor({ code, relay = DEFAULT_RELAY, session, out, since = '', fetch: fetchFn, EventSource: ES } = {}) {
        this.code = normalizeCode(code);
        if (!this.code) throw new Error('invalid pairing code');
        if (!validSession(session)) throw new Error('invalid session');
        this.relay = normalizeRelay(relay || DEFAULT_RELAY) || DEFAULT_RELAY;
        this.session = session;
        this.out = out;
        this.in = out === 'c2r' ? 'r2c' : 'c2r';
        this.since = since;
        this.onsignal = null;
        this.connected = false;
        this.posted = 0;
        this._fetch = fetchFn || ((...a) => globalThis.fetch(...a));
        this._ES = ES || globalThis.EventSource;
        this._asm = new SignalAssembler();
        this._seen = [];
        this._waiters = [];
        this._es = null;
        this._closed = false;
    }

    async init() {
        this.topic = await deriveTopic(this.code);
        this.key = await deriveKey(this.code);
        if (this._closed) return;
        const url = this.relay + '/' + this.topic + '/sse' + (this.since ? '?since=' + encodeURIComponent(this.since) : '');
        const es = new this._ES(url);
        this._es = es;
        es.onopen = () => this._setConnected(true);
        es.onmessage = ev => { this._onEvent(ev && ev.data); };
        if (typeof es.addEventListener === 'function') es.addEventListener('open', () => this._setConnected(true));
        es.onerror = () => { if (es.readyState === 2) this._setConnected(false); };
    }

    _setConnected(on) {
        this.connected = on;
        if (on) {
            const w = this._waiters;
            this._waiters = [];
            for (const f of w) f(true);
        }
    }

    waitOpen(ms) {
        if (this.connected) return Promise.resolve(true);
        return new Promise(resolve => {
            const done = v => { clearTimeout(t); resolve(v); };
            const t = setTimeout(() => {
                this._waiters = this._waiters.filter(f => f !== done);
                resolve(false);
            }, ms);
            this._waiters.push(done);
        });
    }

    async _onEvent(raw) {
        if (typeof raw !== 'string' || this._closed) return;
        let ev;
        try { ev = JSON.parse(raw); } catch (e) { return; }
        if (!ev || ev.event !== 'message' || typeof ev.message !== 'string' || ev.message.indexOf('otv1.') !== 0) return;
        const m = await open(this.key, this.topic, ev.message);
        if (!m || m.v !== 1 || m.dir !== this.in || m.session !== this.session || typeof m.id !== 'string') return;
        const now = typeof ev.time === 'number' ? ev.time : Date.now() / 1000;
        if (typeof m.ts !== 'number' || Math.abs(m.ts / 1000 - now) > FRESH_S) return;
        if (this._seen.indexOf(m.id) >= 0) return;
        this._seen.push(m.id);
        if (this._seen.length > 64) this._seen.shift();
        const data = this._asm.add(m);
        if (data !== null && typeof this.onsignal === 'function') this.onsignal(m.cast, data);
    }

    /** Publishes one signal (split into parts if needed). Rejects with err.code 'rate_limit' | 'network' | 'relay'. */
    async send(cast, data) {
        const msgs = signalMessages({ dir: this.out, session: this.session, cast, data });
        for (const m of msgs) {
            const env = await seal(this.key, this.topic, m);
            if (env.length > MAX_ENVELOPE_BYTES) throw castError('too_big', 'envelope too large');
            let res;
            try {
                res = await this._fetch(this.relay + '/' + this.topic + '?firebase=no', {
                    method: 'POST', body: env, credentials: 'omit', referrerPolicy: 'no-referrer',
                });
            } catch (e) {
                throw castError('network', 'network error');
            }
            if (res.status === 429) throw castError('rate_limit', 'relay limit reached');
            if (!res.ok) throw castError('relay', 'relay HTTP ' + res.status);
            this.posted++;
        }
        return msgs.length;
    }

    close() {
        this._closed = true;
        if (this._es) {
            try { this._es.close(); } catch (e) { /* ignore */ }
        }
        this._es = null;
        for (const f of this._waiters) f(false);
        this._waiters = [];
    }
}

// ---------- WebRTC helpers ----------

/** Resolves when ICE gathering is complete (or after ms), so one description carries every candidate. */
export function iceGathered(pc, ms = 4000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve(true);
    return new Promise(resolve => {
        const t = setTimeout(() => { cleanup(); resolve(false); }, ms);
        const check = () => {
            if (pc.iceGatheringState === 'complete') { cleanup(); resolve(true); }
        };
        const onCand = e => { if (!e.candidate) { cleanup(); resolve(true); } };
        function cleanup() {
            clearTimeout(t);
            pc.removeEventListener('icegatheringstatechange', check);
            pc.removeEventListener('icecandidate', onCand);
        }
        pc.addEventListener('icegatheringstatechange', check);
        pc.addEventListener('icecandidate', onCand);
    });
}

/** What this browser lacks for sharing its screen: null if supported, else 'display' | 'webrtc'. */
export function senderSupport(w = globalThis) {
    const md = w.navigator && w.navigator.mediaDevices;
    if (!md || typeof md.getDisplayMedia !== 'function') return 'display';
    if (typeof w.RTCPeerConnection !== 'function') return 'webrtc';
    return null;
}

/**
 * Laptop side. states: 'idle' | 'starting' | 'waiting' | 'sharing' | 'stopped' | 'error'.
 * onstate(state, detail) is called on each change; detail.code/message for errors.
 */
export class CastSender {
    constructor({ link, RTCPeerConnection: PC, fetch: fetchFn, EventSource: ES, answerTimeoutMs = 60000, onstate } = {}) {
        this.link = link;
        this.state = 'idle';
        this.onstate = onstate || null;
        this._PC = PC || globalThis.RTCPeerConnection;
        this._fetch = fetchFn;
        this._ES = ES;
        this._answerTimeoutMs = answerTimeoutMs;
        this.pc = null;
        this.dc = null;
        this.channel = null;
        this.stream = null;
        this.session = null;
        this._tvStarted = false;
    }

    _set(s, detail) {
        if (this.state === 'stopped' || this.state === 'error') return;
        this.state = s;
        if (typeof this.onstate === 'function') {
            try { this.onstate(s, detail || {}); } catch (e) { /* UI errors must not break sharing */ }
        }
    }

    get active() {
        return this.state === 'starting' || this.state === 'waiting' || this.state === 'sharing';
    }

    /** Starts sharing `stream` (from getDisplayMedia, obtained inside the click handler). */
    async start(stream) {
        this.stream = stream;
        this._set('starting');
        try {
            await this._start(stream);
        } catch (e) {
            this._fail(e);
        }
    }

    async _start(stream) {
        for (const t of stream.getTracks()) {
            t.addEventListener('ended', () => this.stop('ended'));
        }
        await this.link.init();
        this.session = newId(16);
        const ch = new CastChannel({
            code: this.link.code, relay: this.link.relay, session: this.session, out: 'c2r',
            fetch: this._fetch, EventSource: this._ES,
        });
        this.channel = ch;
        const answer = new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(castError('no_answer', 'The TV did not connect.')), this._answerTimeoutMs);
            ch.onsignal = (cast, data) => {
                if (cast === 'answer') { clearTimeout(t); resolve(data); }
                else if (cast === 'bye') { clearTimeout(t); reject(castError('declined', 'The TV ended the session.')); }
            };
        });
        answer.catch(() => {});
        await ch.init();
        const pc = new this._PC({ iceServers: ICE_SERVERS });
        this.pc = pc;
        for (const t of stream.getTracks()) pc.addTrack(t, stream);
        this.dc = pc.createDataChannel('otv');
        pc.addEventListener('connectionstatechange', () => this._onConn());
        pc.addEventListener('iceconnectionstatechange', () => this._onConn());
        await pc.setLocalDescription(await pc.createOffer());
        const [, opened] = await Promise.all([iceGathered(pc), ch.waitOpen(8000)]);
        if (this.state !== 'starting') return;
        if (!opened) throw castError('network', 'relay not reachable');
        this._set('waiting');
        const ack = await this.link.send('cast', { action: 'start', session: this.session }, { timeoutMs: 20000 });
        if (!ack.ok) throw castError('tv', ack.msg || 'The TV could not start the receiver.');
        this._tvStarted = true;
        if (!this.active) return;
        await ch.send('offer', await encodeSignal(pc.localDescription));
        const desc = await decodeSignal(await answer);
        if (!desc || desc.type !== 'answer') throw castError('bad_answer', 'The TV sent an invalid answer.');
        if (!this.active) return;
        await pc.setRemoteDescription(desc);
    }

    _onConn() {
        const pc = this.pc;
        if (!pc || !this.active) return;
        const s = pc.connectionState || pc.iceConnectionState;
        if (s === 'connected' || s === 'completed') {
            clearTimeout(this._dropTimer);
            this._set('sharing');
        } else if (s === 'failed') {
            this._fail(castError('ice', 'Could not connect to the TV.'));
        } else if (s === 'disconnected' && this.state === 'sharing') {
            clearTimeout(this._dropTimer);
            this._dropTimer = setTimeout(() => {
                if (this.pc && (this.pc.connectionState || this.pc.iceConnectionState) === 'disconnected') {
                    this._fail(castError('ice', 'The connection to the TV was lost.'));
                }
            }, 10000);
        }
    }

    _fail(e) {
        if (!this.active) return;
        const code = (e && e.code) || 'error';
        this._teardown(true);
        this._set('error', { code, message: (e && e.message) || 'error', error: e });
        this.state = 'error';
    }

    /** Stops sharing. reason: 'user' | 'ended' (the browser's own "Stop sharing" button). */
    stop(reason = 'user') {
        if (!this.active) return;
        this._teardown(true);
        this._set('stopped', { reason });
    }

    _teardown(tellTv) {
        clearTimeout(this._dropTimer);
        const dc = this.dc;
        let told = false;
        if (tellTv && dc && dc.readyState === 'open') {
            try { dc.send('bye'); told = true; } catch (e) { /* fall back to the relay */ }
        }
        if (tellTv && !told && this._tvStarted) {
            // The data channel is not up yet, so ask the TV app to close the receiver (one relay message).
            this.link.send('cast', { action: 'stop', session: this.session }).catch(() => {});
        }
        const pc = this.pc;
        this.pc = null;
        this.dc = null;
        // Give the "bye" a moment to leave before closing the connection.
        if (pc) setTimeout(() => { try { pc.close(); } catch (e) { /* ignore */ } }, told ? 300 : 0);
        if (this.stream) for (const t of this.stream.getTracks()) { try { t.stop(); } catch (e) { /* ignore */ } }
        if (this.channel) this.channel.close();
    }
}

/**
 * TV side (runs in receive.html inside the TV app's WebView). states: 'waiting' | 'connecting' |
 * 'playing' | 'ended'. ontrack(stream) gets the remote media; onend(reason) fires once.
 */
export class CastReceiver {
    constructor({ code, relay, session, RTCPeerConnection: PC, fetch: fetchFn, EventSource: ES, offerTimeoutMs = 90000, onstate, ontrack, onend } = {}) {
        this.code = code;
        this.relay = relay;
        this.session = session;
        this.state = 'idle';
        this.onstate = onstate || null;
        this.ontrack = ontrack || null;
        this.onend = onend || null;
        this._PC = PC || globalThis.RTCPeerConnection;
        this._fetch = fetchFn;
        this._ES = ES;
        this._offerTimeoutMs = offerTimeoutMs;
        this.pc = null;
        this.channel = null;
        this._gotOffer = false;
    }

    _set(s, detail) {
        if (this.state === 'ended') return;
        this.state = s;
        if (typeof this.onstate === 'function') {
            try { this.onstate(s, detail || {}); } catch (e) { /* ignore */ }
        }
    }

    async start() {
        this._set('waiting');
        // since=5m: the laptop may publish the offer before this page finished loading; ntfy replays it.
        const ch = new CastChannel({
            code: this.code, relay: this.relay, session: this.session, out: 'r2c', since: '5m',
            fetch: this._fetch, EventSource: this._ES,
        });
        this.channel = ch;
        ch.onsignal = (cast, data) => {
            if (cast === 'offer' && !this._gotOffer) {
                this._gotOffer = true;
                this._answer(data).catch(e => this.end('error', e));
            } else if (cast === 'bye') this.end('stopped');
        };
        this._offerTimer = setTimeout(() => { if (!this._gotOffer) this.end('timeout'); }, this._offerTimeoutMs);
        await ch.init();
    }

    async _answer(data) {
        const desc = await decodeSignal(data);
        if (!desc || desc.type !== 'offer') throw castError('bad_offer', 'invalid offer');
        this._set('connecting');
        const pc = new this._PC({ iceServers: ICE_SERVERS });
        this.pc = pc;
        pc.addEventListener('track', e => {
            const stream = (e.streams && e.streams[0]) || null;
            if (stream && typeof this.ontrack === 'function') this.ontrack(stream, e.track);
        });
        pc.addEventListener('datachannel', e => {
            e.channel.addEventListener('message', m => { if (m.data === 'bye') this.end('stopped'); });
        });
        pc.addEventListener('connectionstatechange', () => this._onConn());
        pc.addEventListener('iceconnectionstatechange', () => this._onConn());
        await pc.setRemoteDescription(desc);
        await pc.setLocalDescription(await pc.createAnswer());
        await iceGathered(pc);
        if (this.state === 'ended') return;
        await this.channel.send('answer', await encodeSignal(pc.localDescription));
    }

    _onConn() {
        const pc = this.pc;
        if (!pc || this.state === 'ended') return;
        const s = pc.connectionState || pc.iceConnectionState;
        if (s === 'connected' || s === 'completed') {
            clearTimeout(this._dropTimer);
            this._set('playing');
        } else if (s === 'failed' || s === 'closed') {
            this.end('disconnected');
        } else if (s === 'disconnected') {
            clearTimeout(this._dropTimer);
            this._dropTimer = setTimeout(() => {
                if (this.pc && (this.pc.connectionState || this.pc.iceConnectionState) === 'disconnected') this.end('disconnected');
            }, 8000);
        }
    }

    end(reason, err) {
        if (this.state === 'ended') return;
        clearTimeout(this._offerTimer);
        clearTimeout(this._dropTimer);
        this._set('ended', { reason, error: err });
        this.state = 'ended';
        if (this.pc) { try { this.pc.close(); } catch (e) { /* ignore */ } }
        this.pc = null;
        if (this.channel) this.channel.close();
        if (typeof this.onend === 'function') {
            try { this.onend(reason, err); } catch (e) { /* ignore */ }
        }
    }
}
