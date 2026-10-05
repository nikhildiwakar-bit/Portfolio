// Office TV "direct video" (PROTOCOL.md section 8): the laptop encodes the shared screen itself with WebCodecs
// (hardware H.264 where the computer has it) and sends the encoded frames over a WebRTC data channel; the TV app
// decodes them with its own low-latency hardware decoder straight onto the screen. This avoids the TV
// WebView's video path (no low-latency decoding, every frame drawn through the page at 4K), which caused most
// of the delay on interactive panels. Used only when both sides support it; otherwise the normal WebRTC
// picture is used, so every laptop and every TV keeps working.
//
// Wire format on the 'otv-video' channel (binary, ordered, reliable): one or more messages per encoded frame,
// each = 16-byte header + up to CHUNK_BYTES of the frame:
//   u8 type (1) | u8 flags (bit 0: key frame) | u16 chunk index | u16 chunk count | u16 reserved |
//   u32 frame id | u32 laptop time (ms, wraps)            -- all little-endian
// Control messages go over the existing 'otv' channel as JSON:
//   TV -> laptop  {type:'native', v:1, codecs:['avc','vp9','vp8'], maxWidth, maxHeight, maxFps}  (or {type:'native', off:true})
//   laptop -> TV  {type:'video', v:1, state:'start', codec:'avc'|'vp9'|'vp8', width, height}  /  {type:'video', v:1, state:'stop'}
//   TV -> laptop  {type:'keyframe'}

export const HEADER_BYTES = 16;
/** Below every browser's data channel message limit (64 KiB when the other side does not say). */
export const CHUNK_BYTES = 60000;
/** Encoded data waiting in the channel beyond this means the link is behind: skip frames (before encoding).
 * Small on purpose: everything queued here is delay on the TV (1.5 MB was ~1.3 s on school Wi-Fi). */
export const MAX_BUFFERED = 200000;
/** A key frame at least this often while frames flow, so a lost frame never freezes the TV for long. */
export const KEY_EVERY_MS = 10000; // the channel is reliable: key frames are big, so only as a safety net
/** Repeats of the newest frame after each change: they push it out of the TV decoder at once. */
export const PUSH_OUT = 3;

/** Splits one encoded frame into channel messages. */
export function packFrame(frameId, key, data, timeMs, chunkBytes = CHUNK_BYTES) {
    const count = Math.max(1, Math.ceil(data.length / chunkBytes));
    const out = [];
    for (let i = 0; i < count; i++) {
        const part = data.subarray(i * chunkBytes, Math.min(data.length, (i + 1) * chunkBytes));
        const buf = new ArrayBuffer(HEADER_BYTES + part.length);
        const v = new DataView(buf);
        v.setUint8(0, 1);
        v.setUint8(1, key ? 1 : 0);
        v.setUint16(2, i, true);
        v.setUint16(4, count, true);
        v.setUint16(6, 0, true);
        v.setUint32(8, frameId >>> 0, true);
        v.setUint32(12, (timeMs >>> 0), true);
        new Uint8Array(buf, HEADER_BYTES).set(part);
        out.push(buf);
    }
    return out;
}

/** TV side: puts the messages of a frame back together. push() returns {id, key, data, timeMs} when complete. */
export class FrameAssembler {
    constructor() {
        this.id = -1;
        this.parts = [];
        this.got = 0;
        this.count = 0;
        this.key = false;
        this.timeMs = 0;
        this.incomplete = 0; // frames that never completed (a newer one started first)
    }

    push(buf) {
        if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER_BYTES) return null;
        const v = new DataView(buf);
        if (v.getUint8(0) !== 1) return null;
        const key = (v.getUint8(1) & 1) === 1;
        const index = v.getUint16(2, true);
        const count = v.getUint16(4, true);
        const id = v.getUint32(8, true);
        if (count < 1 || index >= count) return null;
        if (id !== this.id) {
            if (this.got && this.got < this.count) this.incomplete++;
            this.id = id;
            this.parts = new Array(count);
            this.got = 0;
            this.count = count;
            this.key = key;
            this.timeMs = v.getUint32(12, true);
        }
        if (this.parts[index]) return null;
        this.parts[index] = new Uint8Array(buf, HEADER_BYTES);
        this.got++;
        if (this.got < this.count) return null;
        let len = 0;
        for (const p of this.parts) len += p.length;
        const data = new Uint8Array(len);
        let at = 0;
        for (const p of this.parts) { data.set(p, at); at += p.length; }
        this.parts = [];
        this.got = 0;
        return { id, key: this.key, data, timeMs: this.timeMs };
    }
}

/** Standard base64 of bytes (for the TV app's bridge), in slices so big key frames do not overflow the stack. */
export function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

/** True when this browser can encode the screen itself (Chrome/Edge 94+ on Windows, macOS, ChromeOS, Linux). */
export function directSupported(w = globalThis) {
    return !!w && typeof w.VideoEncoder === 'function' && typeof w.MediaStreamTrackProcessor === 'function'
        && typeof w.VideoFrame === 'function' && typeof w.RTCPeerConnection === 'function';
}

const CODEC_STRINGS = {
    // Constrained Baseline level 4.2 covers 1080p at 60 fps; Main and High as fallbacks for picky encoders.
    avc: ['avc1.42E02A', 'avc1.4D402A', 'avc1.64002A'],
    vp9: ['vp09.00.41.08'],
    vp8: ['vp8'],
};

const even = n => Math.max(16, Math.floor(n / 2) * 2);

/** The encode size: the captured size, at most the TV's limit (default 1920 x 1080), aspect kept, even sides. */
export function encodeSize(srcW, srcH, maxW = 1920, maxH = 1080) {
    if (!(srcW > 0) || !(srcH > 0)) return { width: even(maxW), height: even(maxH) };
    const s = Math.min(1, maxW / srcW, maxH / srcH);
    return { width: even(srcW * s), height: even(srcH * s) };
}

/**
 * Picks the first encoder configuration this browser supports: hardware first for every codec the TV can
 * decode (in the TV's order), then software (smaller, 30 fps, for Linux Chrome without hardware encoding).
 * Returns {codec, config, hardware} or null.
 */
export async function chooseConfig(VE, tvCodecs, width, height, fps) {
    const codecs = (Array.isArray(tvCodecs) ? tvCodecs : []).filter(c => CODEC_STRINGS[c]);
    const tries = [];
    for (const c of codecs) for (const s of CODEC_STRINGS[c]) tries.push({ c, s, hw: true, width, height, fps });
    const small = encodeSize(width, height, 1280, 720);
    // Chromebook and other laptop encoders often refuse level 4.2 / 60 fps but take 30 fps or 720p in hardware.
    const AVC_40 = ['avc1.42E028', 'avc1.4D4028', 'avc1.640028'];
    const AVC_31 = ['avc1.42E01F', 'avc1.4D401F', 'avc1.64001F'];
    for (const c of codecs) for (const s of c === 'avc' ? AVC_40 : CODEC_STRINGS[c]) tries.push({ c, s, hw: true, width, height, fps: Math.min(30, fps) });
    for (const c of codecs) for (const s of c === 'avc' ? AVC_31 : CODEC_STRINGS[c]) tries.push({ c, s, hw: true, width: small.width, height: small.height, fps: Math.min(30, fps) });
    for (const c of codecs) for (const s of CODEC_STRINGS[c]) tries.push({ c, s, hw: false, width: small.width, height: small.height, fps: Math.min(30, fps) });
    for (const t of tries) {
        const config = {
            codec: t.s, width: t.width, height: t.height, framerate: t.fps,
            bitrate: t.hw ? Math.round(5e6 * Math.min(1, (t.width * t.height) / (1920 * 1080)) + 1e6) : 3500000,
            latencyMode: 'realtime',
            hardwareAcceleration: t.hw ? 'prefer-hardware' : 'no-preference',
        };
        if (t.c === 'avc') config.avc = { format: 'annexb' };
        try {
            const r = await VE.isConfigSupported(config);
            if (r && r.supported) return { codec: t.c, config, hardware: t.hw };
        } catch (e) { /* try the next one */ }
    }
    return null;
}

/**
 * Laptop side of direct video. new DirectSender({track, dc (the 'otv-video' channel), caps (the TV's
 * 'native' message), tickUrl, onstart(codec, width, height), onfail(reason), log}).start() -> Promise<boolean>.
 * requestKey() forces a key frame; stop() ends it; stats() -> numbers for the info panel; busy() is true when
 * many frames had to be skipped lately (the laptop or the network cannot keep up).
 */
export class DirectSender {
    constructor({ track, dc, caps, tickUrl, onstart, onfail, log, window: w } = {}) {
        this.track = track;
        this.dc = dc;
        this.caps = caps || {};
        this.tickUrl = tickUrl;
        this.onstart = onstart;
        this.onfail = onfail;
        this._log = log || (() => {});
        this._w = w || globalThis;
        this.stopped = false;
        this.encoder = null;
        this.config = null;
        this.codec = '';
        this.hardware = null;
        this.frameId = 0;
        this.needKey = true;
        this.lastKeyAt = 0;
        this.last = null;
        this.repeatsLeft = 0;
        this.lastSentAt = 0;
        this.ts = 0;
        this.counts = { offered: 0, encoded: 0, skipped: 0, bytes: 0, encodeMsSum: 0, encodeN: 0, at: Date.now() };
        this.window = { offered: 0, skipped: 0 };
        this._pending = new Map(); // timestamp -> encode() call time, for encode latency
    }

    get fps() {
        const tv = Math.max(1, Math.min(60, this.caps.maxFps || 60));
        if (this.fpsCap) return Math.min(this.fpsCap, tv);
        return this.hardware === false ? Math.min(30, tv) : tv;
    }

    async start() {
        const w = this._w;
        const settings = typeof this.track.getSettings === 'function' ? this.track.getSettings() : {};
        const size = encodeSize(settings.width, settings.height, this.caps.maxWidth || 1920, this.caps.maxHeight || 1080);
        const pick = await chooseConfig(w.VideoEncoder, this.caps.codecs, size.width, size.height, this.fps);
        if (!pick || this.stopped) return false;
        this.codec = pick.codec;
        this.hardware = pick.hardware;
        this.fpsCap = pick.config.framerate;
        // A smaller hardware or software configuration keeps its size when the shared window changes.
        this.small = pick.config.width < size.width;
        if ((!pick.hardware || this.small) && typeof this.track.applyConstraints === 'function') {
            // Software encoding (Linux Chrome): a smaller picture at 30 fps, scaled at capture where it is cheap.
            try { await this.track.applyConstraints({ width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } }); } catch (e) { /* keep */ }
        }
        if (!this._configure(pick.config)) return false;
        this._log('direct', pick.config.codec + ' ' + pick.config.width + 'x' + pick.config.height + '@' + pick.config.framerate
            + (pick.hardware ? ' hardware' : ' software'));
        try {
            this.processor = new w.MediaStreamTrackProcessor({ track: this.track, maxBufferSize: 1 });
            this.reader = this.processor.readable.getReader();
        } catch (e) {
            this._fail('processor');
            return false;
        }
        if (this.tickUrl && typeof w.Worker === 'function') {
            try {
                this.worker = new w.Worker(this.tickUrl);
                this.worker.onmessage = () => this._tick();
                this.worker.postMessage(Math.round(1000 / this.fps));
            } catch (e) { this.worker = null; }
        }
        this._readLoop();
        return true;
    }

    _configure(config) {
        const w = this._w;
        try {
            if (!this.encoder) {
                this.encoder = new w.VideoEncoder({
                    output: (chunk, meta) => this._output(chunk, meta),
                    error: e => this._fail('encoder ' + (e && e.message ? e.message : e)),
                });
            }
            this.encoder.configure(config);
        } catch (e) {
            this._fail('configure ' + (e && e.message ? e.message : e));
            return false;
        }
        this.config = config;
        this.needKey = true;
        if (typeof this.onstart === 'function') {
            try { this.onstart(this.codec, config.width, config.height); } catch (e) { /* ignore */ }
        }
        return true;
    }

    async _readLoop() {
        try {
            for (;;) {
                const { value: frame, done } = await this.reader.read();
                if (done || this.stopped) { if (frame) frame.close(); break; }
                this._onFrame(frame);
            }
        } catch (e) { /* the track ended or stop() cancelled the reader */ }
    }

    _onFrame(frame) {
        this.counts.offered++;
        this.window.offered++;
        // The shared window changed size: a new encoder size (and a key frame) instead of a stretched picture.
        const size = this.hardware === false || this.small ? encodeSize(frame.displayWidth, frame.displayHeight, 1280, 720)
            : encodeSize(frame.displayWidth, frame.displayHeight, this.caps.maxWidth || 1920, this.caps.maxHeight || 1080);
        if (this.config && (size.width !== this.config.width || size.height !== this.config.height)) {
            this._configure(Object.assign({}, this.config, size));
        }
        if (this.last) this.last.close();
        this.last = frame;
        this.repeatsLeft = PUSH_OUT;
        this._skipCounted = false;
        this.fresh = true; // not on the TV yet: a slide change skipped now is retried on the next tick
        this._encode(false);
    }

    _tick() {
        if (this.stopped || !this.last) return;
        if (this.fresh) { this._encode(false); return; } // the newest picture was skipped: send it as soon as the link allows
        if (this.repeatsLeft <= 0) return;
        if (performance.now() - this.lastSentAt < 1000 / this.fps - 2) return;
        this.repeatsLeft--;
        this._encode(true);
    }

    /** Encodes the newest frame (again, for a repeat). Skips it when the encoder or the network is behind. */
    _encode(repeat) {
        const enc = this.encoder;
        if (!enc || enc.state !== 'configured' || !this.last) return;
        if (enc.encodeQueueSize > 1 || (this.dc && this.dc.bufferedAmount > MAX_BUFFERED)) {
            if (!repeat && !this._skipCounted) { this.counts.skipped++; this.window.skipped++; this._skipCounted = true; }
            return; // skipped before encoding: nothing is corrupted, the next frame carries on
        }
        const now = performance.now();
        const key = this.needKey || now - this.lastKeyAt > KEY_EVERY_MS;
        this.ts = Math.max(this.ts + 1, Math.round(now * 1000));
        let f;
        try { f = new this._w.VideoFrame(this.last, { timestamp: this.ts }); } catch (e) { return; }
        try {
            this._pending.set(this.ts, now);
            enc.encode(f, { keyFrame: key });
            if (key) { this.needKey = false; this.lastKeyAt = now; }
            this.lastSentAt = now;
            this.fresh = false;
            this._skipCounted = false;
        } catch (e) {
            this._fail('encode ' + (e && e.message ? e.message : e));
        } finally {
            f.close();
        }
    }

    _output(chunk) {
        if (this.stopped || !this.dc || this.dc.readyState !== 'open') return;
        const t0 = this._pending.get(chunk.timestamp);
        if (t0 !== undefined) {
            this._pending.delete(chunk.timestamp);
            this.counts.encodeMsSum += performance.now() - t0;
            this.counts.encodeN++;
        }
        if (this._pending.size > 120) this._pending.clear();
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const id = ++this.frameId;
        try {
            for (const m of packFrame(id, chunk.type === 'key', data, performance.now())) this.dc.send(m);
            this.counts.encoded++;
            this.counts.bytes += data.length;
        } catch (e) {
            // The channel refused (queue full or closing): the TV will miss this frame, so start again from a key frame.
            this.needKey = true;
        }
    }

    requestKey() {
        this.needKey = true;
        if (this.last && this.repeatsLeft <= 0) this.repeatsLeft = 1; // a still screen: send the key frame now
    }

    /** True when a quarter or more of the frames had to be skipped since the last call. */
    busy() {
        const w = this.window;
        const b = w.offered >= 10 && w.skipped / w.offered >= 0.25;
        this.window = { offered: 0, skipped: 0 };
        return b;
    }

    /** {codec, width, height, fps, bitrate, encodeMs, hardware, skipped} since the last call. */
    stats() {
        const c = this.counts;
        const now = Date.now();
        const secs = Math.max(0.001, (now - c.at) / 1000);
        const out = {
            codec: this.codec, width: this.config ? this.config.width : 0, height: this.config ? this.config.height : 0,
            fps: c.encoded / secs, bitrate: c.bytes * 8 / secs, encodeMs: c.encodeN ? c.encodeMsSum / c.encodeN : null,
            hardware: this.hardware, skipped: c.skipped,
        };
        this.counts = { offered: 0, encoded: 0, skipped: 0, bytes: 0, encodeMsSum: 0, encodeN: 0, at: now };
        return out;
    }

    _fail(reason) {
        if (this.stopped) return;
        this._log('direct-failed', reason);
        this.stop();
        if (typeof this.onfail === 'function') {
            try { this.onfail(reason); } catch (e) { /* ignore */ }
        }
    }

    stop() {
        if (this.stopped) return;
        this.stopped = true;
        if (this.worker) { try { this.worker.postMessage(0); this.worker.terminate(); } catch (e) { /* ignore */ } }
        if (this.reader) { try { this.reader.cancel().catch(() => {}); } catch (e) { /* ignore */ } }
        if (this.encoder) { try { if (this.encoder.state !== 'closed') this.encoder.close(); } catch (e) { /* ignore */ } }
        if (this.last) { try { this.last.close(); } catch (e) { /* ignore */ } }
        this.last = null;
    }
}
