// Office TV "Share my screen": laptop -> TV screen sharing over WebRTC (PROTOCOL.md section 8).
// Signaling (SDP offer/answer, with every ICE candidate inside) travels over the same encrypted relay
// topic as commands, in c2r (controller -> receiver) and r2c (receiver -> controller) messages that the
// TV app ignores. Media goes directly between the browsers; the relay never sees it.
import { MAX_ENVELOPE_BYTES, DEFAULT_RELAY, Relay, deriveKey, deriveTopic, isShortCode, newId, normalizeCode, normalizeRelay, open, seal } from './otv.js?v=4';
import {
    RX_STALE_MS, STATS_MS, connectionRows, connectionVerdict, hardwareProbe, parseReceiverStats, parseSenderStats, readReceiverMessage,
    receiverStatsMessage, selectedPair,
} from './stats.js?v=2';
import { STEADY_FPS, steadyTrack } from './steady.js';
import { DirectSender, FrameAssembler, directSupported, toBase64 } from './direct.js?v=6';

export const RECEIVER_URL = 'https://nikhildiwakar-bit.github.io/Portfolio/tv/receive.html';
export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
/** Max characters of signal payload per relay message; keeps each envelope well under 3,900 bytes. */
export const SIGNAL_CHUNK = 2400;
export const MAX_SIGNAL_PARTS = 8;
/** Video budget: the laptop's native resolution (up to 4K) at up to 30 fps and 15 Mbps, so text is as sharp as on the laptop. */
export const MAX_BITRATE = 8000000;
export const MAX_FPS = 60;
/** The rates the sender may fall back to on a slow computer, and how often it checks. */
export const FPS_STEPS = [60, 30];
/** What a busy laptop steps down through: resolution first (sharp enough at TV distance), 30 fps last. */
export const QUALITY_STEPS = [{ height: 1080, fps: 60 }, { height: 900, fps: 60 }, { height: 720, fps: 60 }, { height: 720, fps: 30 }];
export const ADAPT_MS = 3000;
/** Keep the resolution (sharp text) and let the encoder lower the frame rate when bandwidth or the processor runs short. */
export const DEGRADATION = 'maintain-resolution';
/** Chrome 144+: never cut the frame rate or size for load (frames are skipped instead), so the TV keeps a fresh picture. */
export const DEGRADATION_NEW = 'maintain-framerate-and-resolution';
/** Screen content (text, slides, spreadsheets): the encoder keeps fine detail instead of smooth motion. */
export const CONTENT_HINT = 'detail';
/** ICE gathering wait: stop at 1.5 s, or as soon as a host and a server-reflexive (STUN) address are known. */
export const ICE_WAIT_MS = 1500;
/** The tick worker of the steady frame rate (steady.js); relative to this module, so the TV app can serve it too. */
const TICK_URL = (() => { try { return new URL('./tick.js', import.meta.url).href; } catch (e) { return ''; } })();
/** The receiver ended the session because the laptop is not on the TV's network (4-digit codes). */
export const NETWORK_TEXT = 'Screen sharing works only from a laptop on the same network as this TV.';
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

/**
 * A relay failure in the sender's terms: the relay's own network error ('network' from TvLink or a publish)
 * becomes 'offline', because for the sender 'network' means the TV refused this laptop's network. Other
 * errors (timeout, rate_limit with its limit, relay, tv, ...) pass through unchanged.
 */
function relayProblem(e) {
    if (!e || e.code !== 'network' || e.lan) return e;
    const out = castError('offline', e.message || 'The relay could not be reached.');
    out.cause = e;
    return out;
}

/** The TV ended the session because this laptop is on another network (4-digit codes, receiver LAN check). */
function networkError() {
    const e = castError('network', NETWORK_TEXT);
    e.lan = true;
    return e;
}

// ---------- capture ----------

/**
 * getDisplayMedia options: the screen at its native resolution (ideal 2560 x 1440, at most 4K) and up to
 * 30 fps, so the TV is as sharp as the laptop; tab or system audio, the Office TV tab itself left out of the
 * picker, and Chrome's "Share this tab instead" button so the user can switch what is shown without stopping.
 * suppressLocalAudioPlayback (Chrome 109+): a shared tab goes silent on the laptop and plays on the TV only,
 * so the room never hears it twice from two places. (System audio of an entire screen cannot be muted
 * locally; browsers without the constraint ignore it.)
 */
export function displayMediaOptions() {
    return {
        video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: MAX_FPS, max: MAX_FPS } },
        audio: { suppressLocalAudioPlayback: true },
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
 * MAX_FPS, high priority and degradationPreference 'maintain-resolution'. A browser that rejects a field (older
 * Chrome threw on degradationPreference / networkPriority) is asked again without priorities, then with the
 * plain caps only. Where degradationPreference is not accepted, Chrome still keeps the resolution for a
 * 'detail' track (CONTENT_HINT).
 */
export async function tuneSender(sender, fps = MAX_FPS) {
    if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return false;
    const apply = async (priority, degradation) => {
        const p = sender.getParameters();
        if (!p || !Array.isArray(p.encodings) || !p.encodings.length) return false;
        for (const e of p.encodings) {
            e.maxBitrate = MAX_BITRATE;
            e.maxFramerate = fps;
            if (priority) { e.priority = 'high'; e.networkPriority = 'high'; }
        }
        if (degradation) p.degradationPreference = degradation;
        await sender.setParameters(p);
        return true;
    };
    for (const [priority, degradation] of [[true, DEGRADATION_NEW], [true, DEGRADATION], [false, DEGRADATION], [false, false]]) {
        try {
            return await apply(priority, degradation);
        } catch (e) { /* try the next, smaller set */ }
    }
    return false; // the browser keeps its own limits
}

/**
 * How much to scale the shared screen down so the picture is no larger than the TV's screen ('WxH' in device
 * pixels, from the TV's stats): 1 = full size. The TV would scale a bigger picture down anyway, so sending
 * exactly its size looks the same and spares the TV's decoder (on slow TV chips a too-big picture is what
 * builds up delay). Implausible sizes keep the full picture.
 */
export function fitScale(srcW, srcH, tvScreen) {
    const m = /^(\d{1,5})x(\d{1,5})$/.exec(typeof tvScreen === 'string' ? tvScreen : '');
    if (!m || !(srcW > 0) || !(srcH > 0)) return 1;
    const tw = +m[1], th = +m[2];
    if (tw < 640 || th < 360) return 1;
    const s = Math.max(srcW / tw, srcH / th);
    return s > 1.05 ? Math.min(4, Math.round(s * 100) / 100) : 1;
}

/** A control message on the 'otv' data channel ({type:'native'|'keyframe'|'video'}), or null. */
export function readControl(data) {
    if (typeof data !== 'string' || data.length > 2048 || data[0] !== '{') return null;
    let m;
    try { m = JSON.parse(data); } catch (e) { return null; }
    if (!m || (m.type !== 'native' && m.type !== 'keyframe' && m.type !== 'video')) return null;
    return m;
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
            // Audio in its own stream: the TV then never holds the picture back to line it up with the sound.
            const own = track.kind === 'audio' && typeof MediaStream === 'function' ? new MediaStream([track]) : stream;
            const init = { direction: 'sendonly', streams: [own] };
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

/** Receiver URL (the TV app opens it). The pairing code is in the fragment, which never leaves the device. */
export function receiverUrl({ session, code, relay, ip }, base = RECEIVER_URL) {
    let f = 's=' + session + '&code=' + code;
    const lan = validLanIp(ip);
    if (lan) f += '&ip=' + lan;
    const r = normalizeRelay(relay || '');
    if (r && r !== DEFAULT_RELAY) f += '&relay=' + encodeURIComponent(r);
    return base + '#' + f;
}

/** Parses the receiver fragment. Returns {session, code, relay, ip} (ip: the TV's LAN IPv4 or '') or null. */
export function parseReceiverFragment(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const session = p.get('s');
    const code = normalizeCode(p.get('code') || '');
    if (!validSession(session) || !code) return null;
    return { session, code, relay: normalizeRelay(p.get('relay') || '') || DEFAULT_RELAY, ip: validLanIp(p.get('ip') || '') };
}

// ---------- relay channel ----------

/**
 * 4-digit codes: the receiver's 'ready' goes out every 2 s until an offer arrives (at most READY_MAX times), and
 * the sender's offer again every 2 s until the answer (at most OFFER_MAX times).
 */
export const OFFER_EVERY_MS = 2000;
export const READY_MAX = 15;
export const OFFER_MAX = 15;

function publishError(r) {
    if (r && r.status === 429) return castError('rate_limit', 'relay limit reached');
    if (!r || !r.status) return castError('network', 'network error');
    return castError('relay', 'relay HTTP ' + r.status);
}

/**
 * One cast session's signaling over the relay. `out` is the direction this side sends ('c2r' or 'r2c');
 * it listens for the opposite one, the same session id, and fresh, never-seen message ids.
 * With `link` (a TvLink) it shares that link's Relay (tv/relay.js); otherwise it opens its own (the receiver,
 * with since= so an offer published over ntfy before the page loaded is replayed). 4-digit codes use the MQTT
 * brokers and ntfy; 10-symbol codes (older TVs) only ntfy, exactly as before.
 *
 *   onsignal(cast, data, meta) for each complete 'offer' | 'answer' | 'bye' signal; meta = {via: 'mqtt' | 'ntfy'}.
 *   send(cast, data, {via}) publishes one signal (in parts if needed) and resolves with the number of messages;
 *     rejects with err.code 'rate_limit' | 'network' | 'relay' | 'too_big'. A reply goes back over ntfy when the
 *     other side's last signal came over ntfy (lastVia; that side may have no broker), else by the relay's policy.
 *   waitOpen(ms) -> Promise<boolean>: true once the relay can carry a message.
 *
 * 4-digit codes only (MQTT keeps no history, and the TV page subscribes after the laptop sent its offer):
 *   Receiver (out 'r2c', announce: true): publishes {cast:'ready'} as soon as the relay can carry it, then again
 *     every 2 s over MQTT until an offer arrives, at most 15 times (over ntfy only once: it counts against the
 *     daily quota). readySent counts them.
 *   Sender (out 'c2r'):
 *     offer(data) -> Promise<number>: publishes the offer at once (resolves or rejects like send()), then the SAME
 *       envelopes again whenever the receiver says 'ready' and every 2 s, at most 15 times, until an answer
 *       arrives, stopOffer() or close(). Repeats go over MQTT only (ntfy replays its own history), plus one copy
 *       over ntfy if a 'ready' came over ntfy (that TV has no broker). For 10-symbol codes it is send('offer').
 *       offersSent counts the publishes (the first one included).
 *     onready(meta) fires for every 'ready' of the receiver ({via}); readyCount counts them. A 'ready' also tells
 *       the link (TvLink.heard) that the TV has this session's 'cast start', so that command needs no ntfy copy.
 *     stopOffer() ends the repeats.
 */
export class CastChannel {
    constructor({
        code, relay = DEFAULT_RELAY, session, out, since = '', link = null, announce = false,
        fetch: fetchFn, EventSource: ES, WebSocket: WS, brokers, repeatMs = OFFER_EVERY_MS,
    } = {}) {
        this.link = link;
        this.code = normalizeCode(link ? link.code : code);
        if (!this.code) throw new Error('invalid pairing code');
        if (!validSession(session)) throw new Error('invalid session');
        this.relay = link ? link.relay : normalizeRelay(relay || DEFAULT_RELAY) || DEFAULT_RELAY;
        this.session = session;
        this.out = out;
        this.in = out === 'c2r' ? 'r2c' : 'c2r';
        this.since = since;
        this.short = isShortCode(this.code);
        this.announce = !!announce && this.short && out === 'r2c';
        this.onsignal = null;
        this.onready = null;
        this.connected = false;
        this.posted = 0;
        this.readySent = 0;
        this.readyCount = 0;
        this.offersSent = 0;
        this.lastVia = '';
        this.transport = null; // own Relay (no link)
        this._fetch = fetchFn || (link && link._fetch) || ((...a) => globalThis.fetch(...a));
        this._ES = ES || globalThis.EventSource;
        this._WS = WS;
        this._brokers = brokers;
        this._asm = new SignalAssembler();
        this._seen = [];
        this._unlisten = null;
        this._closed = false;
        this._initP = null;
        this._gotOffer = false;
        this._offer = null;       // {envs, ntfy, left, timer} while the offer is repeated
        this._readyNtfy = false;  // sender: a 'ready' came over ntfy; receiver: its one ntfy 'ready' went out
        this._readyTicks = 0;
        this._readyTimer = null;
        this._announcing = false;
        this._repeatMs = repeatMs; // 'ready' and offer repeats (2 s; shorter in tests)
    }

    init() {
        if (!this._initP) {
            this._initP = this._init();
            this._initP.catch(() => { this._initP = null; });
        }
        return this._initP;
    }

    async _init() {
        if (this.link) {
            await this.link.init();
            this.topic = this.link.topic;
            this.key = this.link.key;
            if (!this._closed && !this._unlisten) this._unlisten = this.link.listen((m, meta) => this._onMessage(m, meta));
        } else {
            this.topic = await deriveTopic(this.code);
            this.key = await deriveKey(this.code);
            if (this._closed) return;
            const t = new Relay({
                topic: this.topic, code: this.code, ntfy: this.relay, since: this.since, brokers: this._brokers,
                WebSocket: this._WS, EventSource: this._ES, fetch: this._fetch,
            });
            this.transport = t;
            t.onmessage = (env, meta) => { this._onEnvelope(env, meta); };
            t.onchange = () => { if (this.transport === t) this.connected = t.connected; };
            t.start();
        }
        if (this.announce) this._announce();
    }

    /** Resolves true once the relay can carry a message, or false after ms. */
    async waitOpen(ms) {
        if (this.link) return this.link.ready(ms);
        try { await this.init(); } catch (e) { return false; }
        return this.transport ? this.transport.ready(ms) : false;
    }

    /** After a network hiccup: dead relay sockets are found in seconds and reconnect (Relay.probe). */
    probe(ms) {
        const t = this.link ? this.link.transport : this.transport;
        if (t && typeof t.probe === 'function') { try { t.probe(ms); } catch (e) { /* ignore */ } }
    }

    _mqttCount() {
        const t = this.link ? this.link.transport : this.transport;
        return t ? t.mqttCount : 0;
    }

    /** ntfy clock minus ours, when ours is clearly wrong (a TV without the right time); else 0. */
    _clockOffset() {
        if (this.link) return this.link.clockOffsetMs || 0;
        const off = this.transport && this.transport.serverOffsetMs;
        return typeof off === 'number' && Math.abs(off) > 30000 ? off : 0;
    }

    async _onEnvelope(env, meta) {
        if (this._closed || !this.key) return;
        this._onMessage(await open(this.key, this.topic, env), meta);
    }

    _onMessage(m, meta) {
        if (this._closed || !m || m.v !== 1 || m.dir !== this.in || m.session !== this.session || typeof m.id !== 'string') return;
        const info = meta && typeof meta === 'object' ? meta : {};
        const now = typeof info.time === 'number' ? info.time : Date.now() / 1000;
        if (typeof m.ts !== 'number' || Math.abs(m.ts / 1000 - now) > FRESH_S) return;
        if (this._seen.indexOf(m.id) >= 0) return;
        this._seen.push(m.id);
        if (this._seen.length > 256) this._seen.shift();
        const data = this._asm.add(m);
        if (data === null) return;
        const via = info.via === 'mqtt' ? 'mqtt' : 'ntfy';
        this.lastVia = via;
        if (m.cast === 'ready') {
            if (this.out === 'c2r') this._onReady(via);
            return;
        }
        if (m.cast === 'offer' && this.out === 'r2c') this._stopAnnounce();
        if (m.cast === 'answer' && this.out === 'c2r') this.stopOffer();
        if (typeof this.onsignal === 'function') this.onsignal(m.cast, data, { via });
    }

    async _seal(cast, data) {
        if (!this.key) await this.init();
        const msgs = signalMessages({ dir: this.out, session: this.session, cast, data, ts: Date.now() + this._clockOffset() });
        const out = [];
        for (const m of msgs) {
            const env = await seal(this.key, this.topic, m);
            if (env.length > MAX_ENVELOPE_BYTES) throw castError('too_big', 'envelope too large');
            out.push(env);
        }
        return out;
    }

    /** One envelope through the relay: the Relay's result {via, ok, status?}; never throws. */
    async _publish(env, opts) {
        try {
            if (this.link) return await this.link.publishEnvelope(env, opts);
            if (this.transport) return await this.transport.publish(env, opts);
        } catch (e) { /* reported below */ }
        return { via: 'ntfy', ok: false, status: 0 };
    }

    async _publishAll(envs, opts) {
        let r = null;
        for (const env of envs) {
            r = await this._publish(env, opts);
            if (!r.ok) throw publishError(r);
            this.posted++;
        }
        return r;
    }

    /** Publishes one signal (split into parts if needed). Rejects with err.code 'rate_limit' | 'network' | 'relay'. */
    async send(cast, data = '', { via } = {}) {
        const envs = await this._seal(cast, data);
        await this._publishAll(envs, { via: via || (this.short && this.lastVia === 'ntfy' ? 'ntfy' : undefined) });
        return envs.length;
    }

    // --- sender: the offer, kept available for a receiver that subscribes later (4-digit codes) ---

    async offer(data) {
        if (!this.short) return this.send('offer', data);
        this.stopOffer();
        const envs = await this._seal('offer', data);
        const o = { envs, ntfy: false, left: OFFER_MAX, timer: null };
        this._offer = o;
        const r = await this._publishAll(envs, {});
        this.offersSent++;
        if (r && r.via === 'ntfy') o.ntfy = true;
        if (this._offer === o && !this._closed) {
            if (this._readyNtfy) this._offerNtfy(o);
            this._armOffer(o);
        }
        return envs.length;
    }

    stopOffer() {
        const o = this._offer;
        this._offer = null;
        if (o) clearTimeout(o.timer);
    }

    _onReady(via) {
        this.readyCount++;
        if (via === 'ntfy') this._readyNtfy = true;
        // The TV's receiver is running, so the TV got 'cast start': no ntfy copy of that command is needed.
        if (this.link && typeof this.link.heard === 'function') this.link.heard(this.session);
        if (typeof this.onready === 'function') {
            try { this.onready({ via }); } catch (e) { /* a listener must not break signaling */ }
        }
        // Before the offer exists, offer() takes care of it; after the answer, nothing is repeated.
        if (this._offer) this._repeatOffer(via);
    }

    _armOffer(o) {
        clearTimeout(o.timer);
        o.timer = null;
        if (this._offer !== o || o.left <= 0) return;
        o.timer = setTimeout(() => this._repeatOffer(''), this._repeatMs);
    }

    _repeatOffer(via) {
        const o = this._offer;
        if (!o || this._closed) return;
        if (via === 'ntfy') this._offerNtfy(o);
        if (o.left <= 0) return;
        o.left--;
        // MQTT only: ntfy keeps its own history, which the receiver replays when it subscribes.
        if (this._mqttCount() > 0) {
            this._publishAll(o.envs, { via: 'mqtt-only' }).then(() => { this.offersSent++; }, () => { /* the next one may go */ });
        }
        this._armOffer(o);
    }

    /** The one ntfy copy of the offer, for a receiver without a broker. */
    _offerNtfy(o) {
        if (o.ntfy) return;
        o.ntfy = true;
        this._publishAll(o.envs, { via: 'ntfy' }).then(() => { this.offersSent++; }, () => { /* the answer timeout reports it */ });
    }

    // --- receiver: 'ready' (4-digit codes) ---

    async _announce() {
        if (this._announcing || this._closed) return;
        this._announcing = true;
        // A broker, or ntfy when no broker comes up in a moment (tv/relay.js ready()).
        await this.waitOpen(this._repeatMs * READY_MAX);
        this._readyTick();
    }

    _readyTick() {
        this._readyTimer = null;
        if (this._closed || this._gotOffer || this._readyTicks >= READY_MAX) return;
        this._readyTicks++;
        const mqtt = this._mqttCount() > 0;
        if (mqtt || !this._readyNtfy) {
            if (!mqtt) this._readyNtfy = true;
            this.send('ready', '', { via: mqtt ? 'mqtt-only' : 'ntfy' }).then(() => { this.readySent++; }, () => { /* next tick */ });
        }
        this._readyTimer = setTimeout(() => this._readyTick(), this._repeatMs);
    }

    _stopAnnounce() {
        this._gotOffer = true;
        clearTimeout(this._readyTimer);
        this._readyTimer = null;
    }

    close() {
        this._closed = true;
        this.stopOffer();
        this._stopAnnounce();
        if (this._unlisten) this._unlisten();
        this._unlisten = null;
        const t = this.transport;
        this.transport = null;
        if (t) t.close();
        this.connected = false;
    }
}

// ---------- WebRTC helpers ----------

/**
 * Resolves when ICE gathering is complete, when both a host and a server-reflexive/relay candidate are known
 * (the ones that matter on one network; the description then carries every candidate gathered so far), or
 * after ms. true = complete or early, false = timed out.
 */
/**
 * After an ICE restart: setLocalDescription starts a new gathering a moment later, so iceGatheringState can
 * still read 'complete' from the old one. Wait for the new gathering to begin (briefly) before collecting.
 */
export async function iceRestartGathered(pc, ms = ICE_WAIT_MS) {
    if (pc.iceGatheringState === 'complete' && typeof pc.addEventListener === 'function') {
        await new Promise(resolve => {
            const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', done); resolve(); };
            const t = setTimeout(done, 400);
            pc.addEventListener('icegatheringstatechange', done);
        });
    }
    return iceGathered(pc, ms);
}

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

// ---------- same network (TV side) ----------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** [a, b, c, d] for a dotted IPv4 address, else null. */
function ipv4(s) {
    const m = IPV4.exec(String(s || '').trim());
    if (!m) return null;
    const b = m.slice(1).map(Number);
    return b.every(x => x <= 255) ? b : null;
}

/** The TV's LAN IPv4 address from the receiver URL (ip=), or '' if it is not a usable one. */
export function validLanIp(s) {
    const b = ipv4(s);
    return b && b[0] !== 0 && b[0] < 224 ? b.join('.') : '';
}

/**
 * The TV's answer with its real address next to every hidden one. The TV's web engine names its host
 * candidates "<uuid>.local" (mDNS), which many school and office Wi-Fi networks cannot resolve, so the laptop
 * could not reach the TV directly. For each host candidate line with a .local address a copy with the
 * address replaced by `ip` follows the original (which stays). Other lines are unchanged.
 */
export function withLanCandidates(sdp, ip) {
    const addr = validLanIp(ip);
    if (typeof sdp !== 'string' || !addr) return sdp;
    const eol = sdp.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const out = [];
    for (const line of sdp.split(eol)) {
        out.push(line);
        // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
        const f = /^a=candidate:/.test(line) ? line.split(' ') : null;
        if (f && f.length >= 8 && /\.local\.?$/i.test(f[4]) && f[6] === 'typ' && f[7] === 'host') {
            f[4] = addr;
            out.push(f.join(' '));
        }
    }
    return out.join(eol);
}

/**
 * Screen sharing with a 4-digit code is for laptops on the TV's own network: true when `address` (the
 * laptop's address as the TV sees it) is private (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16,
 * 127/8, fc00::/7, fe80::/10, ::1) or in the same /24 as the TV's `tvIp`. Unknown addresses (empty, or a
 * hostname such as an mDNS name) are allowed.
 */
export function sameNetworkAddress(address, tvIp) {
    let a = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!a) return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
    if (mapped) a = mapped[1];
    const b = ipv4(a);
    if (b) {
        const [x, y] = b;
        if (x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
            || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254)) return true;
        const t = ipv4(tvIp);
        return !!t && t[0] === b[0] && t[1] === b[1] && t[2] === b[2];
    }
    if (a.indexOf(':') < 0 || !/^[0-9a-f:.]+$/.test(a)) return true; // a hostname: unknown
    if (a === '::1') return true;
    const first = parseInt(a.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

const connState = pc => pc.connectionState || pc.iceConnectionState;
const SENDER_LIVE = ['starting', 'waiting', 'connecting', 'sharing', 'reconnecting'];

/**
 * Laptop side.
 * states: 'idle' -> 'starting' (relay connections) -> 'waiting' (TV opens the receiver) -> 'connecting' (TV
 * said yes, or its receiver answered) -> 'sharing' <-> 'reconnecting' (one ICE restart after a drop), then
 * 'stopped' or 'error'. onstate(state, detail): 'connecting' has detail.data (the TV's status object);
 * 'sharing' comes once more with detail.data when the TV's ack arrives after the connection is up. stopped
 * has detail.reason 'user' | 'ended' (the browser's own "Stop sharing") | 'tv' (the TV closed the receiver)
 * | 'page'; error has detail.code: 'timeout' (no TV answered the code) | 'tv' (the TV refused; message) |
 * 'offline' (the relay cannot be reached) | 'rate_limit' | 'relay' | 'no_answer' | 'tv_error' | 'ice' (no
 * connection) | 'network' (the TV refused a laptop from another network) | 'lost', and detail.error.
 * 4-digit codes (Office TV 3.6+): the offer goes out as soon as it is ready, without waiting for the TV's
 * ack (which is still awaited: a refusal fails the share), again whenever the receiver says 'ready' before
 * the answer, and every 2 s until the answer (at most 15 times; over MQTT, which has no history).
 * 10-symbol codes (older TVs): the offer goes out once, after the TV's ack, as before.
 * Relay cost (ntfy): 'cast' command + ack + offer + answer; stopping uses the data channel (no relay message).
 * The video track goes out through steadyTrack() (steady.js) where the browser can: at least 30 frames per
 * second even while the screen is still, so a TV decoder that holds each frame until the next shows changes
 * at once.
 * While sharing, the TV sends its playback numbers over the data channel every 2 s (rxStats);
 * connectionInfo() combines them with this browser's own getStats() for the "Connection info" panel.
 */
export class CastSender {
    constructor({
        link, RTCPeerConnection: PC, onstate, window: w,
        ackTimeoutMs = 20000, answerTimeoutMs = 30000, connectTimeoutMs = 20000, dropMs = 3000, reconnectTimeoutMs = 12000,
        lostMs = 90000, repeatMs = 2000,
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
        this._reconnectTimeoutMs = reconnectTimeoutMs; // one reconnect attempt (offer -> answer -> connected)
        this._lostMs = lostMs;                         // keep trying this long before "connection lost"
        this._repeatMs = repeatMs;                     // the reconnect offer is sent again this often
        this.pc = null;
        this.dc = null;
        this.channel = null;
        this.stream = null;
        this.session = null;
        this.videoSender = null;
        this.tvData = {};
        this.reconnects = 0;
        this._reconnectGen = 0;
        this.rxStats = null;     // the TV's latest numbers (readReceiverMessage), from the data channel
        this.rxStatsAt = 0;
        this.rxStatsCount = 0;
        this._txPrev = null;
        this.fpsLevel = MAX_FPS; // the frame rate asked of the encoder; _adapt() lowers it on a slow computer
        this._adaptTimer = null;
        this._adaptPrev = null;
        this._adaptBad = 0;
        this._adaptGood = 0;
        this._encoderHw = hardwareProbe(this._w.navigator && this._w.navigator.mediaCapabilities, 'encoding');
        this._tvStarted = false;
        this._waiter = null;
        this.short = false;      // a 4-digit code: MQTT signaling, offer before the ack (see above)
        this.answered = false;   // the receiver's answer arrived
        this.steady = null;      // steadyTrack() wrapper of the video track, or null (original track sent)
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
            this._fail(relayProblem(e));
        }
    }

    async _start(stream) {
        for (const t of stream.getTracks()) t.addEventListener('ended', () => this.stop('ended'));
        const video = stream.getVideoTracks()[0];
        // 'detail' (with degradationPreference 'maintain-resolution') keeps text as sharp as on the laptop:
        // when bandwidth or the processor runs short the encoder sends fewer frames, never a blurrier picture.
        if (video && 'contentHint' in video) {
            try { video.contentHint = CONTENT_HINT; } catch (e) { /* optional */ }
        }
        const log = timingLog('tx');
        this._log = log;
        this.session = newId(16);
        this.short = isShortCode(this.link.code);
        const ch = new CastChannel({ link: this.link, session: this.session, out: 'c2r' });
        this.channel = ch;
        ch.onsignal = (cast, data) => this._onSignal(cast, data);
        ch.onready = meta => log('tv-ready', meta && meta.via); // the channel sends the offer again by itself
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
        // Steady frame rate: the encoder gets at least 30 frames per second even while the screen is still.
        this.steady = video ? steadyTrack(video, { fps: STEADY_FPS, workerUrl: TICK_URL, window: this._w }) : null;
        let media = stream;
        if (this.steady) {
            media = this._withVideo(stream, this.steady.track);
            if (!media) {
                this.steady.stop();
                this.steady = null;
                media = stream;
            }
        }
        log('steady', this.steady ? STEADY_FPS + 'fps' : 'off');
        const pc = new this._PC({ iceServers: ICE_SERVERS });
        this.pc = pc;
        this.videoSender = addMedia(pc, media, this._w);
        const dc = pc.createDataChannel('otv');
        this.dc = dc;
        // The TV closing the receiver (Back on the remote, or the app) closes the data channel at once.
        // A close while the network is down is the connection timing out, not the TV: reconnecting decides then.
        dc.addEventListener('close', () => {
            if (this.dc !== dc) return;
            const s = this.pc && connState(this.pc);
            if (this.state === 'reconnecting' || (s && s !== 'connected' && s !== 'completed')) {
                if (this._log) this._log('control channel closed while reconnecting');
                return;
            }
            this.stop('tv');
        });
        dc.addEventListener('message', e => {
            if (this.dc !== dc) return;
            if (e.data === 'bye') { this.stop('tv'); return; }
            if (e.data === 'bye:network') { this._fail(networkError(), false); return; }
            const ctl = readControl(e.data);
            if (ctl) { this._onControl(ctl); return; }
            const st = readReceiverMessage(e.data);
            if (st) {
                this.rxStats = st;
                this.rxStatsAt = Date.now();
                this.rxStatsCount++;
                this._fitToTv(st.screen);
            }
        });
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
        if (!await ch.waitOpen(8000)) throw castError('offline', 'The relay could not be reached.');
        log('relay-open');
        if (!this.active) return;
        if (this.state === 'starting') this._set('waiting');
        let answer;
        if (this.short) {
            // Offer first; the ack is awaited alongside it.
            ack.then(a => this._onAck(a), e => {
                // The receiver answered, so the TV is there even though its ack got lost.
                if (this.active && !this.answered) this._fail(relayProblem(e));
            });
            await offer;
            if (!this.active) return;
            answer = this._expect(this._answerTimeoutMs, 'no_answer', 'The TV did not connect.');
            // CastChannel.offer(): now, then again on the receiver's 'ready' and every 2 s until the answer.
            await ch.offer(await encodeSignal(pc.localDescription, { compress: false }));
        } else {
            const [a] = await Promise.all([ack, offer]);
            if (!this.active) return;
            this._onAck(a);
            if (!this.active) return;
            answer = this._expect(this._answerTimeoutMs, 'no_answer', 'The TV did not connect.');
            await ch.send('offer', await encodeSignal(pc.localDescription, { compress: false }));
        }
        log('offer-sent');
        const desc = await decodeSignal(await answer);
        if (!this.active) return;
        if (!desc || desc.type !== 'answer') throw castError('bad_answer', 'The TV sent an invalid answer.');
        this.answered = true;
        log('answer');
        this._set('connecting', { data: this.tvData });
        await pc.setRemoteDescription(desc);
        tuneSender(this.videoSender);
        // The laptop and the TV cannot reach each other (different networks, no TURN): say so in good time.
        this._connectTimer = setTimeout(() => {
            if (this.state === 'connecting') this._fail(castError('ice', 'Could not connect to the TV.'));
        }, this._connectTimeoutMs);
    }

    /**
     * The TV's ack of 'cast start'. A refusal (setup needed, old web engine, ...) fails the share with the TV's
     * own message. Otherwise its status object (the TV's name) is kept and the panel moves on to 'connecting';
     * an ack that comes after the receiver already answered only updates the panel (same state again).
     */
    _onAck(a) {
        if (!this.active) return;
        if (!a || !a.ok) {
            this._fail(castError('tv', (a && a.msg) || 'The TV could not open the screen receiver.'));
            return;
        }
        this.tvData = a.data && typeof a.data === 'object' ? a.data : {};
        if (this.state === 'starting' || this.state === 'waiting') this._set('connecting', { data: this.tvData });
        else this._emit(this.state, { data: this.tvData });
    }

    /** The stream to send: the captured audio next to `video` (the steady track), or null if it cannot be built. */
    _withVideo(stream, video) {
        const MS = this._w.MediaStream || globalThis.MediaStream;
        if (typeof MS !== 'function') return null;
        try {
            return new MS(stream.getAudioTracks().concat([video]));
        } catch (e) {
            return null;
        }
    }

    // ---------- direct video (direct.js): the TV app decodes the laptop's own stream natively ----------

    _onControl(m) {
        if (m.type === 'native') {
            if (m.off) this._stopDirect('tv');
            else if (!this.direct && !this._directTried && directSupported(this._w)) this._startDirect(m).catch(() => this._stopDirect('error'));
        } else if (m.type === 'keyframe' && this.direct) {
            this.direct.requestKey();
        }
    }

    /** A control message to the TV over the 'otv' channel. */
    _control(obj) {
        const dc = this.dc;
        if (dc && dc.readyState === 'open') {
            try { dc.send(JSON.stringify(obj)); } catch (e) { /* the TV keeps what it has */ }
        }
    }

    async _startDirect(caps) {
        this._directTried = true;
        const video = this.stream && this.stream.getVideoTracks ? this.stream.getVideoTracks()[0] : null;
        const pc = this.pc;
        if (!video || !pc || !this.active) return;
        let vdc;
        try {
            vdc = pc.createDataChannel('otv-video', { ordered: true });
            vdc.binaryType = 'arraybuffer';
        } catch (e) { return; }
        await new Promise(res => {
            if (vdc.readyState === 'open') { res(); return; }
            const t = setTimeout(res, 5000);
            vdc.addEventListener('open', () => { clearTimeout(t); res(); });
        });
        if (vdc.readyState !== 'open' || !this.active || this.pc !== pc) { try { vdc.close(); } catch (e) { /* ignore */ } return; }
        const d = new DirectSender({
            track: video, dc: vdc, caps, tickUrl: TICK_URL, log: this._log, window: this._w,
            onstart: (codec, width, height) => this._control({ type: 'video', v: 1, state: 'start', codec, width, height }),
            onfail: reason => this._stopDirect(reason),
        });
        this.direct = d;
        this.videoDc = vdc;
        // The channel timed out (a long network outage): back to the WebRTC picture, which an ICE restart revives.
        vdc.addEventListener('close', () => { if (this.videoDc === vdc) this._stopDirect('channel closed'); });
        // The steady wrapper reads the same captured track: not needed any more.
        if (this.steady) { this.steady.stop(); this.steady = null; }
        if (!await d.start()) {
            this._stopDirect('unsupported');
            return;
        }
        // The TV shows the direct picture: stop sending the WebRTC one (saves the laptop an encoder and bandwidth).
        try { if (this.videoSender) await this.videoSender.replaceTrack(null); } catch (e) { /* ignore */ }
        if (this._log) this._log('direct', 'on');
    }

    /** Back to the normal WebRTC picture (the TV refused, or this browser could not encode). */
    _stopDirect(reason) {
        const d = this.direct;
        if (!d) return;
        this.direct = null;
        d.stop();
        this._control({ type: 'video', v: 1, state: 'stop' });
        if (this.videoDc) { try { this.videoDc.close(); } catch (e) { /* ignore */ } }
        this.videoDc = null;
        const video = this.stream && this.stream.getVideoTracks ? this.stream.getVideoTracks()[0] : null;
        if (this.active && video && this.videoSender) {
            // The steady frame rate again (it was stopped for direct video), so a still screen keeps reaching the TV.
            if (!this.steady) this.steady = steadyTrack(video, { fps: this.fpsLevel || STEADY_FPS, workerUrl: TICK_URL, window: this._w });
            this.videoSender.replaceTrack(this.steady ? this.steady.track : video).catch(() => {});
        }
        if (this._log) this._log('direct', 'off (' + reason + ')');
    }

    /**
     * A slow computer (a Chromebook with YouTube and other tabs open) cannot encode 60 frames a second without
     * making everything else lag. Every ADAPT_MS the encoder's own numbers are checked: if the processor is the
     * limit, or one frame takes longer to encode than the frame budget allows, the rate steps down
     * (60, 30, 20, 15 fps); after a long calm stretch it may step back up once. The picture's sharpness and size
     * are never reduced, only how often it is sent.
     */
    _startAdapt() {
        if (this._adaptTimer || typeof setInterval !== 'function') return;
        this._adaptTimer = setInterval(() => { this._adapt().catch(() => {}); }, ADAPT_MS);
    }

    async _adapt() {
        const pc = this.pc;
        if (!pc || this.state !== 'sharing' || typeof pc.getStats !== 'function') return;
        const i = Math.max(0, QUALITY_STEPS.findIndex(q => q.fps === this.fpsLevel && q.height === (this.heightLevel || 1080)));
        let slow;
        if (this.direct) {
            // Direct video: busy when the encoder itself falls behind. Frames skipped for the Wi-Fi do not count:
            // a smaller picture does not help a slow network, and every size change restarts the TV's decoder.
            slow = this.direct.busy();
        } else {
            const tx = parseSenderStats(await pc.getStats(), this._adaptPrev);
            if (this.pc !== pc) return;
            this._adaptPrev = tx;
            const enc = typeof tx.encodeMs === 'number' ? tx.encodeMs : null;
            // Busy: the browser itself says the processor is the limit, or encoding takes far longer than a frame.
            slow = tx.limit === 'cpu' || (enc !== null && enc > 2.5 * (1000 / QUALITY_STEPS[i].fps));
        }
        if (slow) { this._adaptBad++; this._adaptGood = 0; } else { this._adaptBad = 0; this._adaptGood++; }
        let j = i;
        if (this._adaptBad >= 2 && i < QUALITY_STEPS.length - 1) j = i + 1;
        else if (this._adaptGood >= 12 && i > 0) j = i - 1;
        if (j === i) return;
        this._adaptBad = 0;
        this._adaptGood = 0;
        await this._applyQuality(QUALITY_STEPS[j], slow);
    }

    /** Smaller picture first (scaled at capture, cheap), frame rate last and never below 30. */
    async _applyQuality(q, slow) {
        const d = this.direct;
        if (d && (d.small || d.hardware === false)) q = { height: Math.min(q.height, 720), fps: Math.min(q.fps, 30) }; // its own limit
        this.fpsLevel = q.fps;
        this.heightLevel = q.height;
        const track = this.stream && this.stream.getVideoTracks ? this.stream.getVideoTracks()[0] : null;
        if (track && typeof track.applyConstraints === 'function') {
            try {
                await track.applyConstraints({ width: { max: Math.round(q.height * 16 / 9) }, height: { max: q.height }, frameRate: { max: q.fps } });
            } catch (e) { /* the browser keeps the size */ }
        }
        if (this.steady && typeof this.steady.setFps === 'function') this.steady.setFps(q.fps);
        await tuneSender(this.videoSender, q.fps);
        if (this._log) this._log('quality', q.height + 'p' + q.fps + (slow ? ' (this computer is busy)' : ' (calm again)'));
    }

    /** Sends the picture at the TV's screen size (fitScale), again whenever the shared window or the TV changes. */
    _fitToTv(screen) {
        const sender = this.videoSender;
        // The captured track's size (the steady track's settings may not report one).
        const track = (this.stream && this.stream.getVideoTracks()[0]) || (sender && sender.track);
        if (!sender || !track || typeof track.getSettings !== 'function' || typeof sender.getParameters !== 'function'
            || typeof sender.setParameters !== 'function') return;
        let set;
        try { set = track.getSettings() || {}; } catch (e) { return; }
        const scale = fitScale(set.width, set.height, screen);
        const now = this._fitScale || 1;
        if (Math.abs(scale - now) < 0.05 || this._fitBusy) return;
        let p;
        try { p = sender.getParameters(); } catch (e) { return; }
        if (!p || !Array.isArray(p.encodings) || !p.encodings.length) return;
        for (const e of p.encodings) e.scaleResolutionDownBy = scale;
        this._fitBusy = true;
        Promise.resolve().then(() => sender.setParameters(p)).then(() => {
            this._fitScale = scale;
            if (this._log) this._log('fit-tv', set.width + 'x' + set.height + ' / ' + scale + ' for ' + screen);
        }, () => { this._fitScale = scale; /* the browser keeps the full size; do not retry every 2 s */ })
            .then(() => { this._fitBusy = false; });
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
            // The receiver gave up (e.g. it could not use the offer), closed, or refused this laptop's network.
            if (data === 'network') this._fail(networkError(), false);
            else if (this.state === 'sharing' || this.state === 'reconnecting') this.stop('tv');
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
                if (this.state === 'reconnecting') { this._reconnectGen++; this._stopRepeat(); } // the loop stops
                if (this._log) this._log(this.state === 'connecting' ? 'connected' : 'reconnected');
                this._set('sharing');
                tuneSender(this.videoSender, this.fpsLevel);
                this._startAdapt();
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
        if (this.state === 'reconnecting') return; // the reconnect loop decides
        if (this.state === 'sharing') this.reconnect();
        else this._fail(castError('ice', 'Could not connect to the TV.'));
    }

    /**
     * Reconnects after the connection dropped, as often as needed in a long meeting: ICE restarts (a new offer and
     * answer) on the same session, so the TV keeps its receiver open. Each offer is sent again every 2 s (and once
     * over ntfy) until the TV answers; attempts repeat until it works or lostMs (90 s) has passed. The TV waits
     * longer than that (graceMs). Resolves true once connected again.
     */
    async reconnect() {
        if (this.state !== 'sharing' || !this.pc) return false;
        this.reconnects++;
        const gen = ++this._reconnectGen;
        clearTimeout(this._dropTimer);
        this._set('reconnecting');
        const pc = this.pc;
        const lost = () => castError('lost', 'The connection to the TV was lost.');
        const until = Date.now() + this._lostMs;
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => { if (this.state === 'reconnecting') this._fail(lost()); }, this._lostMs);
        const going = () => this.active && this.pc === pc && this.state === 'reconnecting' && gen === this._reconnectGen;
        if (this.channel) this.channel.probe(); // dead relay sockets reconnect before the offer goes out
        for (let attempt = 0; going(); attempt++) {
            if (attempt > 0) {
                await new Promise(r => setTimeout(r, Math.min(1000 * attempt, 5000)));
                if (!going()) break;
                if (this.channel) this.channel.probe();
            }
            const left = until - Date.now();
            if (left <= 0) break;
            try {
                if (pc.signalingState === 'have-local-offer') {
                    try { await pc.setLocalDescription({ type: 'rollback' }); } catch (e) { /* a fresh offer replaces it */ }
                }
                await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
                await iceRestartGathered(pc);
                if (!going()) break;
                const answer = this._expect(Math.min(this._reconnectTimeoutMs, left), 'lost', 'The connection to the TV was lost.');
                this._repeatSignal('offer', await encodeSignal(pc.localDescription, { compress: false }));
                let data;
                try { data = await answer; } finally { this._stopRepeat(); }
                if (!this.active || this.pc !== pc) return false;
                const desc = await decodeSignal(data);
                if (!desc || desc.type !== 'answer' || pc.signalingState !== 'have-local-offer') continue;
                await pc.setRemoteDescription(desc);
                this._onConn(); // an ICE restart on a working path never leaves 'connected', so no event fires
                if (await this._connectedWithin(pc, Math.min(10000, Math.max(0, until - Date.now())))) {
                    this._onConn();
                    return true;
                }
            } catch (e) {
                this._stopRepeat();
                if (e && e.code === 'closed') return false;
                if (this._log) this._log('reconnect attempt ' + (attempt + 1) + ' failed (' + ((e && (e.code || e.message)) || e) + ')');
            }
        }
        if (gen === this._reconnectGen && this.active && this.pc === pc && this.state === 'reconnecting') this._fail(lost());
        return this.state === 'sharing';
    }

    /** True once the connection is up again, false after ms. */
    _connectedWithin(pc, ms) {
        const up = () => { const s = connState(pc); return s === 'connected' || s === 'completed'; };
        if (up()) return Promise.resolve(true);
        return new Promise(resolve => {
            const t0 = Date.now();
            const check = () => {
                if (this.pc !== pc || !this.active) { resolve(false); return; }
                if (up()) { resolve(true); return; }
                if (Date.now() - t0 >= ms) { resolve(false); return; }
                setTimeout(check, 250);
            };
            check();
        });
    }

    /** Publishes a signal now and again every repeatMs (one ntfy copy too) until _stopRepeat(). */
    _repeatSignal(cast, data) {
        this._stopRepeat();
        const r = { timer: null, n: 0 };
        this._repeat = r;
        const tick = () => {
            if (this._repeat !== r || !this.channel) return;
            r.n++;
            this.channel.send(cast, data).catch(() => { /* the next copy may get through */ });
            if (r.n === 2) this.channel.send(cast, data, { via: 'ntfy' }).catch(() => {});
            r.timer = setTimeout(tick, this._repeatMs);
        };
        tick();
    }

    _stopRepeat() {
        const r = this._repeat;
        this._repeat = null;
        if (r) clearTimeout(r.timer);
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
        this._stopRepeat();
        clearTimeout(this._dropTimer);
        clearTimeout(this._restartTimer);
        clearTimeout(this._connectTimer);
        clearInterval(this._adaptTimer);
        this._adaptTimer = null;
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
        if (this.steady) this.steady.stop(); // the worker, the processor and the last frame
        if (this.direct) { this.direct.stop(); this.direct = null; }
        if (this.stream) for (const t of this.stream.getTracks()) { try { t.stop(); } catch (e) { /* ignore */ } }
        if (this.channel) this.channel.close();
    }

    /**
     * "Connection info": {tx, rx, verdict, rows}. tx = this browser's outgoing video (parseSenderStats), rx =
     * the TV's numbers from the data channel (null if none arrived in the last 7 s), verdict =
     * connectionVerdict(), rows = connectionRows(). Null when not connected. Call about every 2 s: rates
     * and averages are measured between calls.
     */
    async connectionInfo() {
        const pc = this.pc;
        if (!pc || typeof pc.getStats !== 'function') return null;
        try {
            const tx = parseSenderStats(await pc.getStats(), this._txPrev);
            if (this.pc !== pc) return null;
            tx.steady = !!this.steady || !!this.direct; // false: this browser sends a still screen at its own (low) frame rate
            this._txPrev = tx;
            await this._encoderHw(tx);
            if (this.direct) {
                const d = this.direct.stats();
                Object.assign(tx, {
                    codec: 'video/' + ({ avc: 'H264', vp9: 'VP9', vp8: 'VP8' }[d.codec] || d.codec), width: d.width, height: d.height,
                    fps: d.fps, bitrate: d.bitrate, encodeMs: d.encodeMs, encoder: 'WebCodecs, direct to the TV\'s video chip',
                    hardware: d.hardware, hardwareFrom: 'stats', limit: d.skipped ? 'other' : 'none', direct: true,
                });
            }
            const rx = this.rxStats && Date.now() - this.rxStatsAt < RX_STALE_MS ? this.rxStats : null;
            const verdict = connectionVerdict(tx, rx);
            return { tx, rx, verdict, rows: connectionRows(tx, rx, verdict) };
        } catch (e) {
            return null;
        }
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
 * Every statsMs (2 s) while the data channel is open it sends the laptop a stats message
 * (receiverStatsMessage: decoded fps, dropped frames, decoder, jitter buffer, estimated delay) over that
 * channel; extraStats() may add {tvMs, screen} measured by the page.
 */
/** The TV app draws direct video under the page: the page must be see-through there (class on <html>). */
function seeThrough(on) {
    try { if (typeof document !== 'undefined') document.documentElement.classList.toggle('otv-native', !!on); } catch (e) { /* ignore */ }
}

export class CastReceiver {
    constructor({
        code, relay, session, ip = '', RTCPeerConnection: PC, fetch: fetchFn, EventSource: ES, WebSocket: WS, brokers, repeatMs,
        offerTimeoutMs = 90000, graceMs = 120000, statsMs = STATS_MS, extraStats = null, onstate, ontrack, onend, window: w, video = null,
    } = {}) {
        this._w = w || globalThis;
        // The TV's LAN address (receiver URL ip=): added to the answer next to the hidden .local candidates, and
        // for 4-digit codes only a laptop on this network may share (sameNetworkAddress, checked once connected).
        this.ip = validLanIp(ip);
        this.lanOnly = isShortCode(normalizeCode(String(code || '')) || '');
        this.lanChecked = false;
        this.remoteAddress = '';
        this._media = null; // [stream, track] waiting for the network check before it is shown
        this._statsMs = statsMs;
        this._extraStats = extraStats;
        this.video = video;          // the TV app's native decoder bridge (OfficeTvVideo), or null
        this.nativeActive = false;
        this._statsTimer = null;
        this._statsBusy = false;
        this._rxPrev = null;
        this._decoderHw = hardwareProbe(this._w.navigator && this._w.navigator.mediaCapabilities, 'decoding');
        this.dc = null;
        this.statsSent = 0;
        this.lastStats = '';
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
        this._WS = WS;
        this._brokers = brokers;   // tests; the page uses tv/relay.js BROKERS
        this._repeatMs = repeatMs; // tests; 'ready' every 2 s
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
        // 4-digit codes also use the MQTT brokers, which keep no history: the channel says 'ready' until the
        // offer comes (announce), and the laptop then sends it again.
        const ch = new CastChannel({
            code: this.code, relay: this.relay, session: this.session, out: 'r2c', since: '5m', announce: true,
            fetch: this._fetch, EventSource: this._ES, WebSocket: this._WS, brokers: this._brokers, repeatMs: this._repeatMs,
        });
        this.channel = ch;
        const offers = new Set();
        ch.onsignal = (cast, data, meta) => {
            if (cast === 'offer') {
                // Only the first offer of the session is answered: the laptop repeats it (MQTT, ntfy replay) until
                // the answer arrives, and every copy after the first is ignored. A different offer on the
                // running connection is the laptop's ICE restart.
                if (offers.has(data)) { this._answerAgain(data); return; }
                offers.add(data);
                if (!this.pc && !this._gotOffer) {
                    this._gotOffer = true;
                    this.offerVia = (meta && meta.via) || '';
                    this._answer(data).catch(e => this._failed(e));
                } else if (this.pc) {
                    this._restart(data).catch(() => { /* the grace timer ends the session */ });
                }
            } else if (cast === 'bye') { this._byLaptop = true; this.end('stopped'); }
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
            // Video and sound arrive in separate streams (no lip-sync delay); play them as one here.
            if (!e.track) return;
            if (!this._combined) {
                this._combined = typeof MediaStream === 'function' ? new MediaStream() : ((e.streams && e.streams[0]) || null);
            }
            const stream = this._combined;
            if (!stream) return;
            try { if (stream.getTracks().indexOf(e.track) < 0) stream.addTrack(e.track); } catch (err) { /* already there */ }
            // 4-digit codes: nothing is shown before the laptop is known to be on this network.
            if (this.lanOnly && !this.lanChecked) this._media = [stream, e.track];
            else this._show(stream, e.track);
        });
        pc.addEventListener('datachannel', e => this._watchChannel(e.channel));
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
        await this._sendAnswer(data, await encodeSignal(this._answerDesc(pc)));
        this._log('answer-sent', 'lowLatency=' + (this.lowLatency || 'none') + ' h264First=' + this.codecPrefs + ' ip=' + (this.ip || 'none'));
    }

    /** The local answer as sent to the laptop: with the TV's real address next to its .local candidates. */
    _answerDesc(pc) {
        const d = pc.localDescription;
        return { type: d.type, sdp: withLanCandidates(d.sdp, this.ip) };
    }

    _show(stream, track) {
        if (typeof this.ontrack === 'function') {
            try { this.ontrack(stream, track); } catch (e) { /* ignore */ }
        }
    }

    /**
     * 4-digit codes: once connected, the laptop's address (the selected candidate pair) must be on this
     * network (sameNetworkAddress); otherwise the session ends on both sides with 'network'. Then the
     * waiting picture is shown. Tries the stats a few times while the pair is not reported yet.
     */
    async _checkNetwork() {
        if (this.lanChecked || this._lanBusy || this.state === 'ended') return;
        this._lanBusy = true;
        const pc = this.pc;
        let pair = null;
        for (let i = 0; i < 4 && !pair; i++) {
            if (i) await new Promise(r => setTimeout(r, 250));
            if (this.pc !== pc || this.state === 'ended') return;
            try { pair = selectedPair(await pc.getStats()); } catch (e) { pair = null; }
        }
        this._lanBusy = false;
        if (this.pc !== pc || this.state === 'ended') return;
        this.remoteAddress = (pair && pair.remoteAddress) || '';
        const ok = sameNetworkAddress(this.remoteAddress, this.ip);
        this._log('network', (ok ? 'ok ' : 'refused ') + (this.remoteAddress || 'unknown') + ' tv=' + (this.ip || 'unknown'));
        if (!ok) {
            this._refuseNetwork();
            return;
        }
        this.lanChecked = true;
        const m = this._media;
        this._media = null;
        if (m) this._show(m[0], m[1]);
    }

    /** Tells the laptop why (data channel if open, and the relay), then ends with 'network'. */
    _refuseNetwork() {
        const dc = this.dc;
        if (dc && dc.readyState === 'open') {
            try { dc.send('bye:network'); } catch (e) { /* the relay message below still goes */ }
        }
        if (this.channel) this.channel.send('bye', 'network').catch(() => {});
        this._media = null;
        this._refused = true; // the laptop closing its end now does not make this a plain 'stopped'
        // A moment for the goodbye to leave before the connection closes.
        this._ending = setTimeout(() => this.end('network'), 600);
    }

    /** The laptop's data channel: 'bye' and its closing end the session; once open, stats go out on it. */
    _watchChannel(dc) {
        if (!dc) return;
        if (dc.label === 'otv-video') { this._watchVideo(dc); return; }
        this.dc = dc;
        dc.addEventListener('message', m => {
            if (m.data === 'bye') { this._byLaptop = true; this.end('stopped'); return; }
            const ctl = readControl(m.data);
            if (ctl && ctl.type === 'video') this._onVideoControl(ctl);
        });
        // Tell the laptop this TV can show its own stream through the hardware decoder (direct video).
        const hello = () => this._helloNative();
        if (dc.readyState === 'open') hello();
        else dc.addEventListener('open', hello);
        // The laptop closed the connection (tab closed, sharing stopped). A close while the network is down is the
        // connection timing out instead: the grace timer and the laptop's reconnect decide then.
        dc.addEventListener('close', () => {
            const s = this.pc && connState(this.pc);
            if (this.state === 'reconnecting' || (s && s !== 'connected' && s !== 'completed')) return;
            this._byLaptop = true;
            this.end('stopped');
        });
        if (dc.readyState === 'open') this._startStats();
        else dc.addEventListener('open', () => this._startStats());
    }

    // ---------- direct video: the laptop's own stream, decoded by the TV app (direct.js) ----------

    _helloNative() {
        const v = this.video;
        if (!v || typeof v.caps !== 'function' || this._helloSent) return;
        let caps;
        try { caps = JSON.parse(v.caps()); } catch (e) { return; }
        if (!caps || !Array.isArray(caps.codecs) || !caps.codecs.length) return;
        this._helloSent = true;
        const w = this._w || globalThis;
        w.__otvVideoEvent = name => this._onVideoEvent(name);
        this._sendControl(Object.assign({ type: 'native', v: 1 }, caps));
        if (this._log) this._log('native-offered', caps.codecs.join(','));
    }

    _sendControl(obj) {
        const dc = this.dc;
        if (dc && dc.readyState === 'open') {
            try { dc.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
        }
    }

    _onVideoControl(m) {
        const v = this.video;
        if (!v) return;
        if (m.state === 'start') {
            let ok = false;
            try { ok = !!v.start(String(m.codec || ''), m.width | 0, m.height | 0); } catch (e) { ok = false; }
            this.nativeActive = ok;
            seeThrough(ok);
            if (this._log) this._log('native', (ok ? 'on ' : 'refused ') + m.codec + ' ' + m.width + 'x' + m.height);
            if (!ok) this._sendControl({ type: 'native', v: 1, off: true });
        } else if (m.state === 'stop') {
            this._stopNative();
        }
    }

    /** From the TV app: 'keyframe' (the decoder needs one) or 'error' (back to the WebRTC picture). */
    _onVideoEvent(name) {
        if (name === 'keyframe') this._sendControl({ type: 'keyframe' });
        else if (name === 'error') {
            this._stopNative();
            this._sendControl({ type: 'native', v: 1, off: true });
        }
    }

    _stopNative() {
        if (this.video && this.nativeActive) { try { this.video.stop(); } catch (e) { /* ignore */ } }
        this.nativeActive = false;
        seeThrough(false);
    }

    _watchVideo(dc) {
        try { dc.binaryType = 'arraybuffer'; } catch (e) { /* ignore */ }
        const asm = new FrameAssembler();
        // The laptop goes back to the WebRTC picture when this channel closes; so does the TV.
        dc.addEventListener('close', () => { if (this.nativeActive) this._stopNative(); });
        dc.addEventListener('message', m => {
            if (!this.nativeActive || !this.video) return;
            const f = asm.push(m.data);
            if (!f) return;
            try { this.video.frame(toBase64(f.data), f.key); } catch (e) { /* the app went away */ }
        });
    }

    _startStats() {
        if (this._statsTimer || this.state === 'ended' || !(this._statsMs > 0)) return;
        this._statsTimer = setInterval(() => { this._sendStats(); }, this._statsMs);
    }

    /** One stats message to the laptop over the data channel (never the relay). */
    async _sendStats() {
        const pc = this.pc;
        const dc = this.dc;
        if (this._statsBusy || this.state === 'ended' || !pc || !dc || dc.readyState !== 'open' || typeof pc.getStats !== 'function') return false;
        this._statsBusy = true;
        try {
            const rx = parseReceiverStats(await pc.getStats(), this._rxPrev);
            this._rxPrev = rx;
            await this._decoderHw(rx);
            if (this.nativeActive && this.video && typeof this.video.stats === 'function') {
                try {
                    const n = JSON.parse(this.video.stats());
                    Object.assign(rx, {
                        fps: n.fps, decodeMs: n.decodeMs, framesDropped: n.dropped, framesDecoded: n.decoded, jitterMs: 0,
                        decoder: 'Office TV direct: ' + String(n.decoder || 'MediaCodec') + (n.lowLatency ? ' (low latency)' : ''),
                        hardware: true, hardwareFrom: 'stats', width: n.width, height: n.height,
                    });
                } catch (e) { /* keep the WebRTC numbers */ }
            }
            let extra = {};
            if (typeof this._extraStats === 'function') {
                try { extra = this._extraStats() || {}; } catch (e) { extra = {}; }
            }
            const text = JSON.stringify(receiverStatsMessage(rx, extra));
            if (this.pc !== pc || this.dc !== dc || dc.readyState !== 'open') return false;
            dc.send(text);
            this.statsSent++;
            this.lastStats = text;
            return true;
        } catch (e) {
            return false; // stats are only for the laptop's info panel
        } finally {
            this._statsBusy = false;
        }
    }

    /** A reconnect from the laptop: a new offer with ICE restart on the same connection. */
    async _restart(data) {
        if (this.state === 'ended' || data === this._lastOffer) return;
        const desc = await decodeSignal(data);
        if (!desc || desc.type !== 'offer') return;
        this._lastOffer = data;
        const pc = this.pc;
        await pc.setRemoteDescription(desc);
        await pc.setLocalDescription(await pc.createAnswer());
        await iceRestartGathered(pc);
        if (this.state === 'ended' || this.pc !== pc) return;
        await this._sendAnswer(data, await encodeSignal(this._answerDesc(pc)));
    }

    /** The answer to an offer, kept so a repeated offer (the laptop did not get it) is answered again. */
    async _sendAnswer(offer, answer) {
        this._answers = this._answers || new Map();
        this._answers.set(offer, answer);
        if (this._answers.size > 8) this._answers.delete(this._answers.keys().next().value);
        await this.channel.send('answer', answer);
    }

    _answerAgain(offer) {
        const a = this._answers && this._answers.get(offer);
        const now = Date.now();
        if (!a || this.state === 'ended' || !this.channel || now - (this._answeredAt || 0) < 1500) return;
        this._answeredAt = now;
        this.channel.send('answer', a).catch(() => { /* the next repeat asks again */ });
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
            if (this.lanOnly && !this.lanChecked) this._checkNetwork();
            this._set('playing');
        } else if (s === 'closed') {
            this.end('disconnected');
        } else if (s === 'failed' || s === 'disconnected') {
            if (this.state === 'playing') {
                this._set('reconnecting');
                if (this.channel) this.channel.probe(); // the laptop's reconnect offer must find a live relay socket
            }
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
        if (this._refused) reason = 'network';
        clearTimeout(this._ending);
        clearTimeout(this._offerTimer);
        clearTimeout(this._graceTimer);
        clearInterval(this._statsTimer);
        this._statsTimer = null;
        this._stopNative();
        // Tell the laptop at once (it otherwise keeps trying to reconnect), over the data channel and the relay.
        let bye = null;
        // Not when the laptop ended it, or when it is told separately (network refusal, setup error).
        if (!this._byLaptop && reason !== 'network' && reason !== 'error') {
            const dc = this.dc;
            if (dc && dc.readyState === 'open') { try { dc.send('bye'); } catch (e) { /* the relay copy goes */ } }
            if (this.channel && this.pc) bye = this.channel.send('bye', reason).catch(() => {});
        }
        this._set('ended', { reason, error: err });
        this.state = 'ended';
        if (this.pc) { try { this.pc.close(); } catch (e) { /* ignore */ } }
        this.pc = null;
        const ch = this.channel;
        if (ch && bye) Promise.race([bye, new Promise(r => setTimeout(r, 1500))]).then(() => ch.close());
        else if (ch) ch.close();
        if (typeof this.onend === 'function') {
            try { this.onend(reason, err); } catch (e) { /* ignore */ }
        }
    }
}
