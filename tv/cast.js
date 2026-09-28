// Office TV "Share my screen": laptop -> TV screen sharing over WebRTC (PROTOCOL.md section 8).
// Signaling (SDP offer/answer, with every ICE candidate inside) travels over the same encrypted relay
// topic as commands, in c2r (controller -> receiver) and r2c (receiver -> controller) messages that the
// TV app ignores. Media goes directly between the browsers; the relay never sees it.
import { MAX_ENVELOPE_BYTES, DEFAULT_RELAY, deriveKey, deriveTopic, newId, normalizeCode, normalizeRelay, open, seal } from './otv.js?v=3';

export const RECEIVER_URL = 'https://nikhildiwakar-bit.github.io/Portfolio/tv/receive.html';
export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
/** Max characters of signal payload per relay message; keeps each envelope well under 3,900 bytes. */
export const SIGNAL_CHUNK = 2400;
export const MAX_SIGNAL_PARTS = 8;
/** Video budget: up to 1080p at 30 fps and 8 Mbps, plenty for sharp text and smooth video on office Wi-Fi. */
export const MAX_BITRATE = 8000000;
export const MAX_FPS = 30;
/** Keep the frame rate (smooth scrolling) and let the encoder lower the resolution when bandwidth runs short. */
export const DEGRADATION = 'maintain-framerate';
/** ICE gathering wait: stop at 1.5 s, or as soon as a host and a server-reflexive (STUN) address are known. */
export const ICE_WAIT_MS = 1500;
const now = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());
/** Connect timing log for comparing builds: console lines like "[otv] tx +123ms offer-sent". */
export function timingLog(tag) {
    const t0 = now();
    return (step, extra) => {
        try { console.info('[otv] ' + tag + ' +' + Math.round(now() - t0) + 'ms ' + step + (extra ? ' ' + extra : '')); } catch (e) { /* ignore */ }
    };
}
const FRESH_S = 300;

function castError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
}

// ---------- capture ----------

/**
 * getDisplayMedia options: about 1080p at 30 fps (sharp on a TV, light for the laptop's encoder and the
 * TV's decoder), tab or system audio, the Office TV tab itself left out of the picker, and Chrome's
 * "Share this tab instead" button so the user can switch what is shown without stopping.
 */
export function displayMediaOptions() {
    return {
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: MAX_FPS, max: MAX_FPS } },
        audio: true,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
    };
}

/**
 * Opens the browser's screen picker and resolves with the stream. Call it straight from a click handler,
 * before any await: browsers allow it only while the click still counts as a user gesture. If the browser
 * rejects one of the options (TypeError), it asks again with the plain defaults.
 */
export function captureScreen(md = globalThis.navigator && globalThis.navigator.mediaDevices) {
    if (!md || typeof md.getDisplayMedia !== 'function') {
        return Promise.reject(castError('unsupported', 'Screen capture is not available in this browser.'));
    }
    let p;
    try {
        p = md.getDisplayMedia(displayMediaOptions());
    } catch (e) {
        p = Promise.reject(e);
    }
    return Promise.resolve(p).catch(e => {
        if (e && e.name === 'TypeError') return md.getDisplayMedia({ video: true, audio: true });
        throw e;
    });
}

/** What this browser lacks for sharing its screen: null if supported, else 'display' | 'webrtc'. */
export function senderSupport(w = globalThis) {
    const md = w.navigator && w.navigator.mediaDevices;
    if (!md || typeof md.getDisplayMedia !== 'function') return 'display';
    if (typeof w.RTCPeerConnection !== 'function') return 'webrtc';
    return null;
}

// ---------- codecs and bitrate ----------

/** Codec list with `mime` first (packetization-mode=1 entries before the others), the rest in the original order. */
export function preferCodec(codecs, mime = 'video/H264') {
    const want = mime.toLowerCase();
    const list = Array.isArray(codecs) ? codecs : [];
    const is = c => String(c && c.mimeType).toLowerCase() === want;
    const pm1 = c => /packetization-mode=1/.test((c && c.sdpFmtpLine) || '');
    const hit = list.filter(is);
    return hit.filter(pm1).concat(hit.filter(c => !pm1(c)), list.filter(c => !is(c)));
}

const codecKey = c => (c.mimeType + ' ' + c.clockRate + ' ' + (c.sdpFmtpLine || '')).toLowerCase();

/**
 * Puts H.264 first in the offer when this browser can send it. TV chips decode H.264 in hardware, which keeps
 * the picture smooth on slow TV processors; if the TV cannot decode it, its answer picks the next codec (VP8).
 * Only codecs this browser can both send and receive are listed, which every browser accepts.
 */
export function preferH264(transceiver, w = globalThis) {
    try {
        const R = w.RTCRtpReceiver;
        const S = w.RTCRtpSender;
        if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return false;
        if (!R || typeof R.getCapabilities !== 'function' || !S || typeof S.getCapabilities !== 'function') return false;
        const recv = R.getCapabilities('video');
        const send = S.getCapabilities('video');
        if (!recv || !send || !Array.isArray(recv.codecs) || !Array.isArray(send.codecs)) return false;
        const sendKeys = new Set(send.codecs.map(codecKey));
        const both = recv.codecs.filter(c => sendKeys.has(codecKey(c)));
        if (!both.some(c => /^video\/h264$/i.test(c.mimeType))) return false;
        transceiver.setCodecPreferences(preferCodec(both));
        return true;
    } catch (e) {
        return false;
    }
}

/** The sendEncodings entry for the screen: bitrate/frame-rate caps, full resolution, high priority (DSCP where the OS allows). */
export function videoEncoding() {
    return { maxBitrate: MAX_BITRATE, maxFramerate: MAX_FPS, scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high' };
}

/**
 * Applies the encoder settings (again after connecting, for browsers that ignore sendEncodings): MAX_BITRATE,
 * MAX_FPS, high priority and degradationPreference 'maintain-framerate'. A browser that rejects a field (older
 * Chrome threw on degradationPreference / networkPriority) gets the plain caps instead.
 */
export async function tuneSender(sender) {
    if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return false;
    const apply = async full => {
        const p = sender.getParameters();
        if (!p || !Array.isArray(p.encodings) || !p.encodings.length) return false;
        for (const e of p.encodings) {
            e.maxBitrate = MAX_BITRATE;
            e.maxFramerate = MAX_FPS;
            if (full) { e.priority = 'high'; e.networkPriority = 'high'; }
        }
        if (full) p.degradationPreference = DEGRADATION;
        await sender.setParameters(p);
        return true;
    };
    try {
        return await apply(true);
    } catch (e) {
        try { return await apply(false); } catch (e2) { return false; } // the browser keeps its own limits
    }
}

/** Codecs for the TV's answer: H.264 (packetization-mode=1, constrained baseline first), then VP8, VP9, the rest. */
export function receiverCodecOrder(codecs) {
    const list = Array.isArray(codecs) ? codecs : [];
    const mt = c => String(c && c.mimeType).toLowerCase();
    const fmtp = c => (c && c.sdpFmtpLine) || '';
    const rank = c => {
        const m = mt(c);
        if (m === 'video/h264') {
            const pm1 = /packetization-mode=1/.test(fmtp(c)) ? 0 : 2;
            const cb = /profile-level-id=42e0/i.test(fmtp(c)) ? 0 : 1; // constrained baseline
            return pm1 + cb;
        }
        if (m === 'video/vp8') return 4;
        if (m === 'video/vp9') return 5;
        return 6;
    };
    return list.map((c, i) => [rank(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
}

/** TV side: prefers hardware-decodable H.264 in the answer. False when unsupported (the offer's order stays). */
export function preferReceiveCodecs(pc, w = globalThis) {
    try {
        const R = w.RTCRtpReceiver;
        if (!pc || typeof pc.getTransceivers !== 'function' || !R || typeof R.getCapabilities !== 'function') return false;
        const caps = R.getCapabilities('video');
        if (!caps || !Array.isArray(caps.codecs) || !caps.codecs.length) return false;
        const order = receiverCodecOrder(caps.codecs);
        let done = false;
        for (const tr of pc.getTransceivers()) {
            const kind = tr && tr.receiver && tr.receiver.track && tr.receiver.track.kind;
            if (kind !== 'video' || typeof tr.setCodecPreferences !== 'function') continue;
            try { tr.setCodecPreferences(order); done = true; } catch (e) { /* keep the offer's order */ }
        }
        return done;
    } catch (e) {
        return false;
    }
}

/**
 * TV side: play frames as soon as they are decodable. jitterBufferTarget = 0 (Chrome 114+) and the older
 * playoutDelayHint = 0 on both video and audio receivers, so WebRTC's A/V sync keeps them together.
 * Returns which knob was set: 'jitterBufferTarget' | 'playoutDelayHint' | ''.
 */
export function lowLatencyReceiver(receiver) {
    if (!receiver) return '';
    let used = '';
    try {
        if ('jitterBufferTarget' in receiver) { receiver.jitterBufferTarget = 0; used = 'jitterBufferTarget'; }
    } catch (e) { /* optional */ }
    try {
        if ('playoutDelayHint' in receiver) { receiver.playoutDelayHint = 0; if (!used) used = 'playoutDelayHint'; }
    } catch (e) { /* optional */ }
    return used;
}

/** Adds the shared screen as send-only tracks with the video limits. Returns the video RTCRtpSender. */
function addMedia(pc, stream, w) {
    let videoSender = null;
    for (const track of stream.getTracks()) {
        let tr = null;
        if (typeof pc.addTransceiver === 'function') {
            const init = { direction: 'sendonly', streams: [stream] };
            if (track.kind === 'video') init.sendEncodings = [videoEncoding()];
            try { tr = pc.addTransceiver(track, init); } catch (e) { tr = null; }
        }
        const sender = tr ? tr.sender : pc.addTrack(track, stream);
        if (track.kind === 'video') {
            videoSender = sender;
            if (tr) preferH264(tr, w);
        }
    }
    return videoSender;
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
 * With `link` (a TvLink) it shares that link's event stream; otherwise it opens its own (the receiver,
 * with since= so an offer published before the page loaded is replayed).
 * onsignal(cast, data) fires for each complete signal.
 */
export class CastChannel {
    constructor({ code, relay = DEFAULT_RELAY, session, out, since = '', link = null, fetch: fetchFn, EventSource: ES } = {}) {
        this.link = link;
        this.code = normalizeCode(link ? link.code : code);
        if (!this.code) throw new Error('invalid pairing code');
        if (!validSession(session)) throw new Error('invalid session');
        this.relay = link ? link.relay : normalizeRelay(relay || DEFAULT_RELAY) || DEFAULT_RELAY;
        this.session = session;
        this.out = out;
        this.in = out === 'c2r' ? 'r2c' : 'c2r';
        this.since = since;
        this.onsignal = null;
        this.connected = false;
        this.posted = 0;
        this._fetch = fetchFn || (link && link._fetch) || ((...a) => globalThis.fetch(...a));
        this._ES = ES || globalThis.EventSource;
        this._asm = new SignalAssembler();
        this._seen = [];
        this._waiters = [];
        this._es = null;
        this._unlisten = null;
        this._closed = false;
    }

    async init() {
        if (this.link) {
            await this.link.init();
            this.topic = this.link.topic;
            this.key = this.link.key;
            if (!this._closed && !this._unlisten) this._unlisten = this.link.listen((m, ev) => this._onMessage(m, ev));
            return;
        }
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

    /** Resolves true once the event stream is open, or false after ms. */
    waitOpen(ms) {
        if (this.link) return this.link.ready(ms);
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
        this._onMessage(await open(this.key, this.topic, ev.message), ev);
    }

    _onMessage(m, ev) {
        if (this._closed || !m || m.v !== 1 || m.dir !== this.in || m.session !== this.session || typeof m.id !== 'string') return;
        const now = ev && typeof ev.time === 'number' ? ev.time : Date.now() / 1000;
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
        if (this._unlisten) this._unlisten();
        this._unlisten = null;
        if (this._es) {
            try { this._es.close(); } catch (e) { /* ignore */ }
        }
        this._es = null;
        for (const f of this._waiters) f(false);
        this._waiters = [];
    }
}

// ---------- WebRTC helpers ----------

/**
 * Resolves when ICE gathering is complete, when both a host and a server-reflexive/relay candidate are known
 * (the ones that matter on one network; the description then carries every candidate gathered so far), or
 * after ms. true = complete or early, false = timed out.
 */
export function iceGathered(pc, ms = ICE_WAIT_MS) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve(true);
    return new Promise(resolve => {
        const t = setTimeout(() => { cleanup(); resolve(false); }, ms);
        const seen = new Set();
        const check = () => {
            if (pc.iceGatheringState === 'complete') { cleanup(); resolve(true); }
        };
        const onCand = e => {
            if (!e.candidate) { cleanup(); resolve(true); return; }
            const c = e.candidate;
            const type = c.type || (/ typ (\w+)/.exec(c.candidate || '') || [])[1] || '';
            seen.add(type === 'relay' ? 'srflx' : type);
            if (seen.has('host') && seen.has('srflx')) { cleanup(); resolve(true); }
        };
        function cleanup() {
            clearTimeout(t);
            pc.removeEventListener('icegatheringstatechange', check);
            pc.removeEventListener('icecandidate', onCand);
        }
        pc.addEventListener('icegatheringstatechange', check);
        pc.addEventListener('icecandidate', onCand);
    });
}

const connState = pc => pc.connectionState || pc.iceConnectionState;
const SENDER_LIVE = ['starting', 'waiting', 'connecting', 'sharing', 'reconnecting'];

/**
 * Laptop side.
 * states: 'idle' -> 'starting' (relay stream) -> 'waiting' (TV opens the receiver) -> 'connecting' (TV said
 * yes; offer sent) -> 'sharing' <-> 'reconnecting' (one ICE restart after a drop), then 'stopped' or 'error'.
 * onstate(state, detail): stopped has detail.reason 'user' | 'ended' (the browser's own "Stop sharing") |
 * 'tv' (the TV closed the receiver) | 'page'; error has detail.code and detail.error.
 * Relay cost: 'cast' command + ack + offer + answer; stopping uses the data channel (no relay message).
 */
export class CastSender {
    constructor({
        link, RTCPeerConnection: PC, onstate, window: w,
        ackTimeoutMs = 20000, answerTimeoutMs = 30000, connectTimeoutMs = 20000, dropMs = 3000, reconnectTimeoutMs = 12000,
    } = {}) {
        this.link = link;
        this.state = 'idle';
        this.onstate = onstate || null;
        this._w = w || globalThis;
        this._PC = PC || this._w.RTCPeerConnection;
        this._ackTimeoutMs = ackTimeoutMs;
        this._answerTimeoutMs = answerTimeoutMs;
        this._connectTimeoutMs = connectTimeoutMs;
        this._dropMs = dropMs;
        this._reconnectTimeoutMs = reconnectTimeoutMs;
        this.pc = null;
        this.dc = null;
        this.channel = null;
        this.stream = null;
        this.session = null;
        this.videoSender = null;
        this.tvData = {};
        this.reconnects = 0;
        this._tvStarted = false;
        this._waiter = null;
    }

    get active() {
        return SENDER_LIVE.indexOf(this.state) >= 0;
    }

    _emit(s, detail) {
        if (typeof this.onstate === 'function') {
            try { this.onstate(s, detail || {}); } catch (e) { /* UI errors must not break sharing */ }
        }
    }

    _set(s, detail) {
        if (!this.active || this.state === s) return;
        this.state = s;
        this._emit(s, detail);
    }

    /** Starts sharing `stream` (from captureScreen(), called inside the click handler). */
    async start(stream) {
        if (this.state !== 'idle') return;
        this.stream = stream;
        this.state = 'starting';
        this._emit('starting');
        try {
            await this._start(stream);
        } catch (e) {
            this._fail(e);
        }
    }

    async _start(stream) {
        for (const t of stream.getTracks()) t.addEventListener('ended', () => this.stop('ended'));
        const video = stream.getVideoTracks()[0];
        // 'motion' (with degradationPreference 'maintain-framerate') keeps scrolling and video smooth: when
        // bandwidth runs short the encoder lowers the resolution for a moment, not the frame rate. At 8 Mbps
        // on office Wi-Fi text stays sharp at full 1080p.
        if (video && 'contentHint' in video) {
            try { video.contentHint = 'motion'; } catch (e) { /* optional */ }
        }
        const log = timingLog('tx');
        this._log = log;
        this.session = newId(16);
        const ch = new CastChannel({ link: this.link, session: this.session, out: 'c2r' });
        this.channel = ch;
        ch.onsignal = (cast, data) => this._onSignal(cast, data);
        // Everything at once: the TV opens its receiver (it gets 'cast start' first), this page connects to
        // the relay and the browser gathers its network addresses.
        const session = this.session;
        const ack = this.link.send('cast', { action: 'start', session }, { timeoutMs: this._ackTimeoutMs }).then(a => {
            log('tv-ack', a && a.ok ? 'ok' : 'refused');
            if (a.ok) {
                this._tvStarted = true;
                // Cancelled while the TV was opening the receiver: close it again.
                if (!this.active) this.link.send('cast', { action: 'stop', session }).catch(() => {});
            }
            return a;
        });
        ack.catch(() => {}); // handled below; avoids an unhandled rejection if the relay fails first
        const pc = new this._PC({ iceServers: ICE_SERVERS });
        this.pc = pc;
        this.videoSender = addMedia(pc, stream, this._w);
        const dc = pc.createDataChannel('otv');
        this.dc = dc;
        // The TV closing the receiver (Back on the remote, or the app) closes the data channel at once.
        dc.addEventListener('close', () => { if (this.dc === dc) this.stop('tv'); });
        dc.addEventListener('message', e => { if (this.dc === dc && e.data === 'bye') this.stop('tv'); });
        pc.addEventListener('connectionstatechange', () => this._onConn());
        pc.addEventListener('iceconnectionstatechange', () => this._onConn());
        const offer = (async () => {
            await pc.setLocalDescription(await pc.createOffer());
            await iceGathered(pc);
            log('ice-gathered');
        })();
        offer.catch(() => {});
        await ch.init();
        if (!this.active) return;
        if (!await ch.waitOpen(8000)) throw castError('network', 'The relay could not be reached.');
        log('relay-open');
        if (!this.active) return;
        this._set('waiting');
        const [a] = await Promise.all([ack, offer]);
        if (!this.active) return;
        if (!a.ok) throw castError('tv', a.msg || 'The TV could not open the screen receiver.');
        this.tvData = a.data && typeof a.data === 'object' ? a.data : {};
        this._set('connecting', { data: this.tvData });
        const answer = this._expect(this._answerTimeoutMs, 'no_answer', 'The TV did not connect.');
        await ch.send('offer', await encodeSignal(pc.localDescription, { compress: false }));
        log('offer-sent');
        const desc = await decodeSignal(await answer);
        if (!this.active) return;
        if (!desc || desc.type !== 'answer') throw castError('bad_answer', 'The TV sent an invalid answer.');
        log('answer');
        await pc.setRemoteDescription(desc);
        tuneSender(this.videoSender);
        // The laptop and the TV cannot reach each other (different networks, no TURN): say so in good time.
        this._connectTimer = setTimeout(() => {
            if (this.state === 'connecting') this._fail(castError('ice', 'Could not connect to the TV.'));
        }, this._connectTimeoutMs);
    }

    _expect(ms, code, message) {
        return new Promise((resolve, reject) => {
            const w = {
                resolve: d => { clearTimeout(t); resolve(d); },
                reject: e => { clearTimeout(t); reject(e); },
            };
            const t = setTimeout(() => {
                if (this._waiter === w) this._waiter = null;
                reject(castError(code, message));
            }, ms);
            this._waiter = w;
        });
    }

    _onSignal(cast, data) {
        if (cast === 'answer') {
            const w = this._waiter;
            this._waiter = null;
            if (w) w.resolve(data);
        } else if (cast === 'bye') {
            // The receiver gave up (e.g. it could not use the offer) or closed.
            if (this.state === 'sharing' || this.state === 'reconnecting') this.stop('tv');
            else this._fail(castError('tv_error', 'The TV could not show the screen.'), false);
        }
    }

    _onConn() {
        const pc = this.pc;
        if (!pc || !this.active) return;
        const s = connState(pc);
        if (s === 'connected' || s === 'completed') {
            clearTimeout(this._dropTimer);
            if (this.state === 'connecting' || this.state === 'reconnecting') {
                clearTimeout(this._restartTimer);
                if (this._log) this._log(this.state === 'connecting' ? 'connected' : 'reconnected');
                this._set('sharing');
                tuneSender(this.videoSender);
            }
        } else if (s === 'failed') {
            this._dropped();
        } else if (s === 'disconnected' && this.state === 'sharing') {
            // Often a short Wi-Fi hiccup that heals by itself; restart only if it lasts.
            clearTimeout(this._dropTimer);
            this._dropTimer = setTimeout(() => {
                const now = this.pc && connState(this.pc);
                if (now === 'disconnected' || now === 'failed') this._dropped();
            }, this._dropMs);
        }
    }

    _dropped() {
        if (this.state === 'reconnecting') return; // the restart's own timer decides
        if (this.state === 'sharing' && this.reconnects < 1) this.reconnect();
        else if (this.state === 'sharing') this._fail(castError('lost', 'The connection to the TV was lost.'));
        else this._fail(castError('ice', 'Could not connect to the TV.'));
    }

    /**
     * Reconnects once after the connection dropped: an ICE restart (new offer and answer, two relay messages)
     * on the same session, so the TV keeps its receiver open. Resolves true if the TV answered.
     */
    async reconnect() {
        if (this.state !== 'sharing' || !this.pc || this.reconnects >= 1) return false;
        this.reconnects++;
        clearTimeout(this._dropTimer);
        this._set('reconnecting');
        const pc = this.pc;
        const lost = () => castError('lost', 'The connection to the TV was lost.');
        this._restartTimer = setTimeout(() => { if (this.state === 'reconnecting') this._fail(lost()); }, this._reconnectTimeoutMs);
        try {
            await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
            await iceGathered(pc);
            if (!this.active || this.pc !== pc) return false;
            const answer = this._expect(this._reconnectTimeoutMs, 'lost', 'The connection to the TV was lost.');
            await this.channel.send('offer', await encodeSignal(pc.localDescription, { compress: false }));
            const desc = await decodeSignal(await answer);
            if (!this.active || this.pc !== pc) return false;
            if (!desc || desc.type !== 'answer') throw lost();
            await pc.setRemoteDescription(desc);
            this._onConn(); // an ICE restart on a working path never leaves 'connected', so no event fires
            return true;
        } catch (e) {
            if (this.state === 'reconnecting') this._fail(lost());
            return false;
        }
    }

    _fail(e, tellTv = true) {
        const code = (e && e.code) || 'error';
        this._end('error', { code, message: (e && e.message) || 'error', error: e }, tellTv);
    }

    /** Stops sharing. reason: 'user' | 'ended' (the browser's own "Stop sharing" button) | 'tv' | 'page'. */
    stop(reason = 'user') {
        this._end('stopped', { reason }, reason !== 'tv');
    }

    _end(s, detail, tellTv) {
        if (!this.active) return false;
        this.state = s; // final first, so events caused by the teardown are ignored
        this._teardown(tellTv);
        this._emit(s, detail);
        return true;
    }

    _teardown(tellTv) {
        clearTimeout(this._dropTimer);
        clearTimeout(this._restartTimer);
        clearTimeout(this._connectTimer);
        const w = this._waiter;
        this._waiter = null;
        if (w) w.reject(castError('closed', 'closed'));
        const dc = this.dc;
        let told = false;
        if (tellTv && dc && dc.readyState === 'open') {
            try { dc.send('bye'); told = true; } catch (e) { /* fall back to the relay */ }
        }
        if (tellTv && !told && this._tvStarted) {
            // The data channel is not up (yet), so ask the TV app to close the receiver (one relay message).
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

    /** Outgoing video right now: {codec, width, height, fps, bytes}, or null (for tests and diagnostics). */
    async videoStats() {
        const pc = this.pc;
        if (!pc || typeof pc.getStats !== 'function') return null;
        try {
            const report = await pc.getStats();
            let out = null;
            const codecs = new Map();
            report.forEach(r => { if (r.type === 'codec') codecs.set(r.id, r.mimeType); });
            report.forEach(r => {
                if (r.type === 'outbound-rtp' && r.kind === 'video') {
                    out = { codec: codecs.get(r.codecId) || '', width: r.frameWidth || 0, height: r.frameHeight || 0, fps: r.framesPerSecond || 0, bytes: r.bytesSent || 0 };
                }
            });
            return out;
        } catch (e) {
            return null;
        }
    }
}

/**
 * TV side (runs in receive.html inside the TV app's WebView). states: 'waiting' | 'connecting' |
 * 'playing' | 'reconnecting' | 'ended'. ontrack(stream) gets the remote media; onend(reason) fires once.
 */
export class CastReceiver {
    constructor({
        code, relay, session, RTCPeerConnection: PC, fetch: fetchFn, EventSource: ES,
        offerTimeoutMs = 90000, graceMs = 25000, onstate, ontrack, onend, window: w,
    } = {}) {
        this._w = w || globalThis;
        this._log = () => {};
        this.lowLatency = '';
        this.codecPrefs = false;
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
        this._graceMs = graceMs;
        this.pc = null;
        this.channel = null;
        this._gotOffer = false;
        this._lastOffer = '';
        this._graceTimer = null;
    }

    _set(s, detail) {
        if (this.state === 'ended' || this.state === s) return;
        this.state = s;
        if (typeof this.onstate === 'function') {
            try { this.onstate(s, detail || {}); } catch (e) { /* ignore */ }
        }
    }

    async start() {
        this._log = timingLog('rx');
        this._set('waiting');
        // since=5m: the laptop may publish the offer before this page finished loading; ntfy replays it.
        const ch = new CastChannel({
            code: this.code, relay: this.relay, session: this.session, out: 'r2c', since: '5m',
            fetch: this._fetch, EventSource: this._ES,
        });
        this.channel = ch;
        ch.onsignal = (cast, data) => {
            if (cast === 'offer') {
                if (!this.pc && !this._gotOffer) {
                    this._gotOffer = true;
                    this._answer(data).catch(e => this._failed(e));
                } else if (this.pc) {
                    this._restart(data).catch(() => { /* the grace timer ends the session */ });
                }
            } else if (cast === 'bye') this.end('stopped');
        };
        this._offerTimer = setTimeout(() => { if (!this._gotOffer) this.end('timeout'); }, this._offerTimeoutMs);
        await ch.init();
    }

    async _answer(data) {
        const desc = await decodeSignal(data);
        if (!desc || desc.type !== 'offer') throw castError('bad_offer', 'invalid offer');
        this._lastOffer = data;
        this._set('connecting');
        this._log('offer');
        const pc = new this._PC({ iceServers: ICE_SERVERS });
        this.pc = pc;
        pc.addEventListener('track', e => {
            this.lowLatency = lowLatencyReceiver(e.receiver) || this.lowLatency || '';
            const stream = (e.streams && e.streams[0]) || null;
            if (stream && typeof this.ontrack === 'function') this.ontrack(stream, e.track);
        });
        pc.addEventListener('datachannel', e => {
            const dc = e.channel;
            dc.addEventListener('message', m => { if (m.data === 'bye') this.end('stopped'); });
            // The laptop closed the connection (tab closed, sharing stopped).
            dc.addEventListener('close', () => this.end('stopped'));
        });
        pc.addEventListener('connectionstatechange', () => this._onConn());
        pc.addEventListener('iceconnectionstatechange', () => this._onConn());
        await pc.setRemoteDescription(desc);
        // Receivers exist now: no jitter buffer, and hardware-decodable H.264 first in the answer.
        if (typeof pc.getReceivers === 'function') {
            for (const r of pc.getReceivers()) this.lowLatency = lowLatencyReceiver(r) || this.lowLatency || '';
        }
        this.codecPrefs = preferReceiveCodecs(pc, this._w);
        await pc.setLocalDescription(await pc.createAnswer());
        await iceGathered(pc);
        this._log('ice-gathered');
        if (this.state === 'ended') return;
        await this.channel.send('answer', await encodeSignal(pc.localDescription));
        this._log('answer-sent', 'lowLatency=' + (this.lowLatency || 'none') + ' h264First=' + this.codecPrefs);
    }

    /** The laptop's one reconnect: a new offer with ICE restart on the same connection. */
    async _restart(data) {
        if (this.state === 'ended' || data === this._lastOffer) return;
        const desc = await decodeSignal(data);
        if (!desc || desc.type !== 'offer') return;
        this._lastOffer = data;
        const pc = this.pc;
        await pc.setRemoteDescription(desc);
        await pc.setLocalDescription(await pc.createAnswer());
        await iceGathered(pc);
        if (this.state === 'ended' || this.pc !== pc) return;
        await this.channel.send('answer', await encodeSignal(pc.localDescription));
    }

    _failed(e) {
        // Tell the laptop right away instead of letting it wait for an answer (one relay message).
        if (this.channel && this.state !== 'ended') this.channel.send('bye', 'error').catch(() => {});
        this.end('error', e);
    }

    _onConn() {
        const pc = this.pc;
        if (!pc || this.state === 'ended') return;
        const s = connState(pc);
        if (s === 'connected' || s === 'completed') {
            clearTimeout(this._graceTimer);
            this._graceTimer = null;
            if (this.state !== 'playing' && this._log) this._log('connected');
            this._set('playing');
        } else if (s === 'closed') {
            this.end('disconnected');
        } else if (s === 'failed' || s === 'disconnected') {
            if (this.state === 'playing') this._set('reconnecting');
            // Wait for the laptop's reconnect before giving up.
            if (!this._graceTimer) {
                this._graceTimer = setTimeout(() => {
                    this._graceTimer = null;
                    const now = this.pc && connState(this.pc);
                    if (now !== 'connected' && now !== 'completed') this.end('disconnected');
                }, this._graceMs);
            }
        }
    }

    end(reason, err) {
        if (this.state === 'ended') return;
        clearTimeout(this._offerTimer);
        clearTimeout(this._graceTimer);
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
