// A small MQTT 3.1.1 client over WebSocket, just what Office TV signaling needs (PROTOCOL.md section 6): one
// topic, QoS 0 publish and subscribe, keep-alive, and reconnect with back-off. Plain ES module for browsers and
// Node 22 (global WebSocket). Relative imports only: the TV app serves tv/ from its own assets.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Largest packet accepted from a broker (an envelope is under 4 KB). */
export const MAX_PACKET = 65536;
export const KEEPALIVE_S = 30;
export const PING_MS = 25000;
export const PONG_TIMEOUT_MS = 10000;
/** WebSocket open + CONNACK must happen within this time, or the broker counts as broken. */
export const CONNECT_TIMEOUT_MS = 10000;
export const BACKOFF_S = [1, 2, 4, 8, 15, 30];

const CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4, PUBREC = 5, PUBREL = 6, PUBCOMP = 7;
const SUBSCRIBE = 8, SUBACK = 9, PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// ---------- packets ----------

/** MQTT "remaining length": 1-4 bytes, 7 bits each, least significant first. */
export function encodeLength(n) {
    if (!(n >= 0 && n <= 268435455) || n !== Math.floor(n)) throw new RangeError('bad remaining length');
    const out = [];
    do {
        let b = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) b |= 128;
        out.push(b);
    } while (n > 0);
    return out;
}

/**
 * Reads a remaining length at buf[off]: {value, bytes}, or null if more bytes are needed. Throws on a length
 * longer than 4 bytes (malformed).
 */
export function decodeLength(buf, off = 0) {
    let value = 0;
    let mul = 1;
    for (let i = 0; i < 4; i++) {
        if (off + i >= buf.length) return null;
        const b = buf[off + i];
        value += (b & 127) * mul;
        if (!(b & 128)) return { value, bytes: i + 1 };
        mul *= 128;
    }
    throw new Error('malformed remaining length');
}

function packet(type, flags, body) {
    const len = encodeLength(body.length);
    const out = new Uint8Array(1 + len.length + body.length);
    out[0] = (type << 4) | flags;
    out.set(len, 1);
    out.set(body, 1 + len.length);
    return out;
}

function lp(bytes) {
    const out = new Uint8Array(2 + bytes.length);
    out[0] = bytes.length >> 8;
    out[1] = bytes.length & 255;
    out.set(bytes, 2);
    return out;
}

function cat(...parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/** CONNECT: protocol "MQTT" level 4, clean session only, no will/username/password. */
export function connectPacket(clientId, keepAliveS = KEEPALIVE_S) {
    const head = Uint8Array.of(4, 0x02, keepAliveS >> 8, keepAliveS & 255);
    return packet(CONNECT, 0, cat(lp(enc.encode('MQTT')), head, lp(enc.encode(clientId))));
}

/** SUBSCRIBE (fixed header flags 0b0010) to one topic at QoS 0. */
export function subscribePacket(id, topic) {
    return packet(SUBSCRIBE, 2, cat(Uint8Array.of(id >> 8, id & 255), lp(enc.encode(topic)), Uint8Array.of(0)));
}

/** PUBLISH at QoS 0, retain 0 (no packet id). */
export function publishPacket(topic, text) {
    return packet(PUBLISH, 0, cat(lp(enc.encode(topic)), enc.encode(text)));
}

const ack = (type, flags, id) => Uint8Array.of((type << 4) | flags, 2, id >> 8, id & 255);
const PINGREQ_BYTES = Uint8Array.of(PINGREQ << 4, 0);
const DISCONNECT_BYTES = Uint8Array.of(DISCONNECT << 4, 0);

/**
 * Splits the byte stream of a connection into MQTT packets. WebSocket frames need not line up with packets: a
 * frame may hold several packets, and a packet may span frames. push(bytes) returns the packets completed so far
 * as [{type, flags, body}]; it throws on a malformed length or a packet bigger than `max`.
 */
export class PacketReader {
    constructor(max = MAX_PACKET) {
        this.max = max;
        this.buf = new Uint8Array(0);
    }

    push(chunk) {
        const buf = this.buf.length ? cat(this.buf, chunk) : chunk;
        const out = [];
        let off = 0;
        while (buf.length - off >= 2) {
            const len = decodeLength(buf, off + 1);
            if (!len) break;
            if (len.value > this.max) throw new Error('packet too large');
            const start = off + 1 + len.bytes;
            if (buf.length < start + len.value) break;
            out.push({ type: buf[off] >> 4, flags: buf[off] & 15, body: buf.slice(start, start + len.value) });
            off = start + len.value;
        }
        this.buf = buf.slice(off);
        return out;
    }
}

/** Decodes a PUBLISH body: {topic, qos, id, payload (bytes)}. Throws if it is malformed. */
export function parsePublish(flags, body) {
    const qos = (flags >> 1) & 3;
    if (qos === 3 || body.length < 2) throw new Error('malformed publish');
    const tlen = (body[0] << 8) | body[1];
    let off = 2 + tlen;
    if (body.length < off + (qos ? 2 : 0)) throw new Error('malformed publish');
    const topic = dec.decode(body.subarray(2, off));
    let id = 0;
    if (qos) {
        id = (body[off] << 8) | body[off + 1];
        off += 2;
    }
    return { topic, qos, id, payload: body.subarray(off) };
}

export function newClientId() {
    let s = 'otv';
    for (const b of globalThis.crypto.getRandomValues(new Uint8Array(32))) {
        if (b < 252 && s.length < 19) s += ID_CHARS[b % 36];
    }
    while (s.length < 19) s += ID_CHARS[Math.floor(Math.random() * 36)];
    return s;
}

// ---------- client ----------

/**
 * One broker connection. start() connects (and keeps reconnecting with back-off 1, 2, 4, 8, 15, 30 s, reset after
 * a CONNACK); once the broker accepted the connection it subscribes to `topic` and reports onstate(true).
 * onmessage(text) gets the UTF-8 payload of every QoS 0 message on that topic (our own publishes included, as MQTT
 * 3.1.1 has no "no local"). publish(text) returns false while not connected. A missing PINGRESP (10 s), a socket
 * error, a refused CONNECT or SUBSCRIBE and a malformed or oversized packet all count as broken: the socket is
 * closed and a reconnect scheduled. onerror() fires on every failed or broken connection. close() ends it for good.
 */
export class MqttClient {
    constructor({
        url, topic, WebSocket: WS, onmessage = null, onstate = null, onerror = null, clientId,
        keepAliveS = KEEPALIVE_S, pingMs = PING_MS, pongTimeoutMs = PONG_TIMEOUT_MS,
        connectTimeoutMs = CONNECT_TIMEOUT_MS, backoffS = BACKOFF_S,
    } = {}) {
        this.url = url;
        this.topic = topic;
        this.onmessage = onmessage;
        this.onstate = onstate;
        this.onerror = onerror;
        this.clientId = clientId || newClientId();
        this.failures = 0;       // failed or broken connections since the last CONNACK
        this.connects = 0;       // CONNACKs received (for tests and diagnostics)
        this.lastError = '';
        this._WS = WS || globalThis.WebSocket;
        this._keepAliveS = keepAliveS;
        this._pingMs = pingMs;
        this._pongTimeoutMs = pongTimeoutMs;
        this._connectTimeoutMs = connectTimeoutMs;
        this._backoff = backoffS && backoffS.length ? backoffS : BACKOFF_S;
        this._retry = 0;
        this._ws = null;
        this._up = false;
        this._started = false;
        this._closed = false;
        this._timers = { retry: null, connect: null, ping: null, pong: null };
    }

    get connected() {
        return this._up;
    }

    start() {
        if (this._started || this._closed) return;
        this._started = true;
        this._open();
    }

    /** Connects now if a reconnect is waiting for its back-off (the page needs the relay right away). */
    kick() {
        if (this._closed || !this._started || this._ws || !this._timers.retry) return;
        clearTimeout(this._timers.retry);
        this._timers.retry = null;
        this._open();
    }

    publish(text) {
        if (!this._up || typeof text !== 'string') return false;
        return this._send(publishPacket(this.topic, text));
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        const ws = this._ws;
        const was = this._up;
        this._stopTimers();
        this._ws = null;
        this._up = false;
        if (ws) {
            if (was) { try { ws.send(DISCONNECT_BYTES); } catch (e) { /* closing anyway */ } }
            try { ws.close(); } catch (e) { /* ignore */ }
        }
        if (was) this._emit(false);
    }

    _emit(up) {
        if (typeof this.onstate === 'function') {
            try { this.onstate(up); } catch (e) { /* callers must not break the connection */ }
        }
    }

    _stopTimers() {
        for (const k of Object.keys(this._timers)) {
            clearTimeout(this._timers[k]);
            clearInterval(this._timers[k]);
            this._timers[k] = null;
        }
    }

    _open() {
        if (this._closed) return;
        let ws;
        try {
            if (typeof this._WS !== 'function') throw new Error('WebSocket is not available');
            ws = new this._WS(this.url, 'mqtt');
            ws.binaryType = 'arraybuffer';
        } catch (e) {
            this._ws = null;
            this._broken(null, 'socket: ' + (e && e.message));
            return;
        }
        this._ws = ws;
        this._reader = new PacketReader();
        this._chain = Promise.resolve();
        this._timers.connect = setTimeout(() => this._broken(ws, 'connect timeout'), this._connectTimeoutMs);
        ws.onopen = () => {
            if (ws === this._ws) this._send(connectPacket(this.clientId, this._keepAliveS));
        };
        ws.onmessage = ev => {
            if (ws === this._ws) this._onData(ws, ev && ev.data);
        };
        ws.onerror = () => this._broken(ws, 'socket error');
        ws.onclose = () => this._broken(ws, 'socket closed');
    }

    _onData(ws, data) {
        if (data instanceof ArrayBuffer) this._onBytes(ws, new Uint8Array(data));
        else if (ArrayBuffer.isView(data)) this._onBytes(ws, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        else if (data && typeof data.arrayBuffer === 'function') {
            // A Blob (binaryType could not be set): read it in order with any others still being read.
            this._chain = this._chain.then(() => data.arrayBuffer()).then(b => {
                if (ws === this._ws) this._onBytes(ws, new Uint8Array(b));
            }, () => this._broken(ws, 'read error'));
        }
        // Text frames are not MQTT: ignore them.
    }

    _onBytes(ws, bytes) {
        let packets;
        try {
            packets = this._reader.push(bytes);
        } catch (e) {
            this._broken(ws, e.message);
            return;
        }
        for (const p of packets) {
            if (ws !== this._ws) return;
            try {
                this._onPacket(ws, p);
            } catch (e) {
                this._broken(ws, 'bad packet: ' + (e && e.message));
                return;
            }
        }
    }

    _onPacket(ws, { type, flags, body }) {
        switch (type) {
            case CONNACK: {
                if (this._up) return;
                if (body.length < 2 || body[1] !== 0) {
                    this._broken(ws, 'connect refused (' + (body.length > 1 ? body[1] : '?') + ')');
                    return;
                }
                clearTimeout(this._timers.connect);
                this._timers.connect = null;
                this._retry = 0;
                this.failures = 0;
                this.connects++;
                // Packets are handled in order, so the subscription is in place before anything published next.
                if (!this._send(subscribePacket(1, this.topic))) return;
                this._up = true;
                this._timers.ping = setInterval(() => this._ping(ws), this._pingMs);
                this._emit(true);
                return;
            }
            case SUBACK:
                if (body.length >= 3 && body[2] === 0x80) this._broken(ws, 'subscribe refused');
                return;
            case PUBLISH: {
                const m = parsePublish(flags, body);
                // We subscribe at QoS 0, so a broker must not send more; acknowledge and drop anything else.
                if (m.qos === 1) { this._send(ack(PUBACK, 0, m.id)); return; }
                if (m.qos === 2) { this._send(ack(PUBREC, 0, m.id)); return; }
                if (m.topic !== this.topic || typeof this.onmessage !== 'function') return;
                let text;
                try { text = dec.decode(m.payload); } catch (e) { return; }
                try { this.onmessage(text); } catch (e) { /* a listener must not break the connection */ }
                return;
            }
            case PUBREL:
                if (body.length >= 2) this._send(ack(PUBCOMP, 0, (body[0] << 8) | body[1]));
                return;
            case PINGRESP:
                clearTimeout(this._timers.pong);
                this._timers.pong = null;
                return;
            default:
                // PUBACK, PUBREC, PUBCOMP, UNSUBACK and anything a broker should not send: nothing to do.
        }
    }

    _ping(ws) {
        if (ws !== this._ws || !this._up || this._timers.pong) return;
        if (!this._send(PINGREQ_BYTES)) return;
        this._timers.pong = setTimeout(() => this._broken(ws, 'no PINGRESP'), this._pongTimeoutMs);
    }

    _send(bytes) {
        const ws = this._ws;
        if (!ws) return false;
        try {
            ws.send(bytes);
            return true;
        } catch (e) {
            this._broken(ws, 'send failed');
            return false;
        }
    }

    _broken(ws, why) {
        if (ws !== this._ws || this._closed) return;
        const was = this._up;
        this._stopTimers();
        this._ws = null;
        this._up = false;
        this.failures++;
        this.lastError = why || '';
        if (ws) {
            ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
            try { ws.close(); } catch (e) { /* ignore */ }
        }
        if (was) this._emit(false);
        if (typeof this.onerror === 'function') {
            try { this.onerror(why); } catch (e) { /* ignore */ }
        }
        if (this._closed) return;
        const s = this._backoff[Math.min(this._retry++, this._backoff.length - 1)];
        this._timers.retry = setTimeout(() => {
            this._timers.retry = null;
            this._open();
        }, s * 1000);
    }
}
