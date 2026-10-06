// Office TV relay transports (PROTOCOL.md section 6). 4-digit codes (Office TV 3.6+): three public MQTT brokers
// over WebSocket, all at once, plus the ntfy.sh event stream; publishing uses the brokers (no daily quota) and
// ntfy only when no broker is connected. 10-symbol codes (older TVs): ntfy only, exactly as before.
// The relays only ever carry the encrypted envelopes ("otv1...."); this module never sees a key.
import { MqttClient } from './mqtt.js';

export const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://mqtt.eclipseprojects.io:443/mqtt',
];
export const NTFY = 'https://ntfy.sh';
/** MQTT topic = this prefix + the relay topic. */
export const MQTT_PREFIX = 'officetv/';
/**
 * ready() waits this long (from start) for a broker while only ntfy is up: every ntfy publish counts against the
 * office's daily quota, and a broker is usually connected a moment later.
 */
export const MQTT_GRACE_MS = 1500;
const RECONNECT_S = [1, 2, 4, 8, 16, 30, 60];
const SEEN_MAX = 256;
const SHORT = /^[0-9]{4}$/;

/** Test override (the browser tests set it before the page loads): {brokers, ntfy} replace the defaults. */
function override() {
    const c = globalThis.__otvRelayConfig;
    return c && typeof c === 'object' ? c : {};
}

async function readText(res) {
    try { return await res.text(); } catch (e) { return ''; }
}

/** Same envelope from several transports = same key (IV + tag), without keeping 4 KB strings around. */
function envelopeKey(text) {
    const a = text.indexOf('.', 5);
    return a < 0 ? text : text.slice(5, a) + text.slice(-24) + text.length;
}

/**
 * The transports of one relay topic.
 *   onmessage(envelope, {via: 'mqtt' | 'ntfy', time}) every envelope once, even when it arrives over several
 *     brokers and ntfy; time = the ntfy server's receive time (s) for ntfy, now (s, corrected by the ntfy server
 *     clock when known) for MQTT.
 *   onchange() when connected / mqttCount changes; ontime(seconds) with the ntfy server time (open, keepalive,
 *     publish replies).
 *   connected (any transport), mqttCount, ntfyConnected, serverOffsetMs (ntfy clock minus ours, null if unknown).
 *   ready(ms) -> Promise<boolean>: true once publish() can go out without waiting (a broker, or ntfy when no broker
 *     came up within MQTT_GRACE_MS or every broker failed), false after ms with nothing connected.
 *   publish(envelope, {via}) -> Promise<{via, ok, status?, body?, error?}>: via undefined or 'mqtt' = every connected
 *     broker, or ntfy if none is; via 'ntfy' = ntfy only; via 'mqtt-only' = every connected broker, never ntfy
 *     (ok false with status 0 when none is connected; for repeats that ntfy's history makes unnecessary).
 *     count = the brokers it went to. ntfy failures carry the HTTP status (0 = network error) and, for 429,
 *     the response body.
 * Options: ntfy base URL (false = no ntfy, tests and CI only), brokers ([] = no MQTT), since (ntfy history for the
 * first subscription, e.g. '5m'), injectable WebSocket / EventSource / fetch, mqtt (MqttClient timing options).
 */
export class Relay {
    constructor({ topic, code, ntfy, brokers, since = '', WebSocket: WS, EventSource: ES, fetch: fetchFn, mqtt = {} } = {}) {
        const cfg = override();
        this.topic = topic;
        this.short = SHORT.test(String(code || ''));
        let base = ntfy === false ? '' : String(ntfy || NTFY).replace(/\/+$/, '');
        if (base === NTFY && typeof cfg.ntfy === 'string' && cfg.ntfy) base = cfg.ntfy.replace(/\/+$/, '');
        this.ntfy = base;
        const list = Array.isArray(brokers) ? brokers : Array.isArray(cfg.brokers) ? cfg.brokers : BROKERS;
        this.brokers = this.short ? list.slice() : [];
        this.since = since || '';
        this.serverOffsetMs = null;
        this.onmessage = null;
        this.onchange = null;
        this.ontime = null;
        this._WS = WS || globalThis.WebSocket;
        this._ES = ES || globalThis.EventSource;
        this._fetch = fetchFn || ((...a) => globalThis.fetch(...a));
        this._mqttOptions = mqtt || {};
        this._clients = [];
        this._es = null;
        this._esOpen = false;
        this._retry = 0;
        this._retryTimer = null;
        this._graceTimer = null;
        this._lastNtfyId = '';
        this._seen = new Set();
        this._seenQ = [];
        this._waiters = [];
        this._started = false;
        this._closed = false;
        this._startedAt = 0;
        this._lastState = '';
    }

    get mqttCount() {
        let n = 0;
        for (const c of this._clients) if (c.connected) n++;
        return n;
    }

    get ntfyConnected() {
        return this._esOpen;
    }

    get connected() {
        return this._esOpen || this.mqttCount > 0;
    }

    start() {
        if (this._started || this._closed) return;
        this._started = true;
        this._startedAt = Date.now();
        if (this.brokers.length && typeof this._WS === 'function') {
            for (const url of this.brokers) {
                const c = new MqttClient(Object.assign({}, this._mqttOptions, {
                    url, topic: MQTT_PREFIX + this.topic, WebSocket: this._WS,
                    onmessage: text => this._deliver(text, 'mqtt'),
                    onstate: () => this._changed(),
                    onerror: () => this._check(),
                }));
                this._clients.push(c);
                c.start();
            }
            this._graceTimer = setTimeout(() => this._check(), MQTT_GRACE_MS);
        }
        this._connectNtfy();
    }

    /** Reconnects at once whatever is waiting for its back-off. */
    kick() {
        if (this._closed) return;
        if (!this._started) { this.start(); return; }
        for (const c of this._clients) c.kick();
        if (this.ntfy && (!this._es || this._es.readyState === 2)) this._connectNtfy();
    }

    /** After a network hiccup: checks every broker that looks connected (dead ones reconnect) and ntfy. */
    probe(ms) {
        if (this._closed || !this._started) return;
        for (const c of this._clients) { if (typeof c.probe === 'function') c.probe(ms); }
        this.kick();
    }

    _usable() {
        if (this.mqttCount > 0) return true;
        if (!this._esOpen) return false;
        if (!this._clients.length) return true;
        if (this._clients.every(c => c.failures > 0)) return true;
        return Date.now() - this._startedAt >= MQTT_GRACE_MS;
    }

    ready(ms = 8000) {
        if (this._closed) return Promise.resolve(false);
        this.start();
        if (this._usable()) return Promise.resolve(true);
        if (!this.connected) this.kick();
        return new Promise(resolve => {
            const w = v => {
                clearTimeout(t);
                this._waiters = this._waiters.filter(f => f !== w);
                resolve(v);
            };
            const t = setTimeout(() => w(this.connected), ms);
            this._waiters.push(w);
        });
    }

    _check() {
        if (!this._waiters.length) return;
        if (this._closed) {
            for (const w of this._waiters.slice()) w(false);
        } else if (this._usable()) {
            for (const w of this._waiters.slice()) w(true);
        }
    }

    _changed() {
        const s = this.mqttCount + '/' + this._esOpen;
        if (s !== this._lastState) {
            this._lastState = s;
            if (typeof this.onchange === 'function') {
                try { this.onchange(); } catch (e) { /* callers must not break the relay */ }
            }
        }
        this._check();
    }

    _noteTime(sec) {
        if (typeof sec !== 'number' || !isFinite(sec)) return;
        this.serverOffsetMs = sec * 1000 - Date.now();
        if (typeof this.ontime === 'function') {
            try { this.ontime(sec); } catch (e) { /* ignore */ }
        }
    }

    _deliver(text, via, time) {
        if (this._closed || typeof text !== 'string' || text.indexOf('otv1.') !== 0) return;
        const k = envelopeKey(text);
        if (this._seen.has(k)) return;
        this._seen.add(k);
        this._seenQ.push(k);
        if (this._seenQ.length > SEEN_MAX) this._seen.delete(this._seenQ.shift());
        const t = typeof time === 'number' && isFinite(time) ? time : (Date.now() + (this.serverOffsetMs || 0)) / 1000;
        if (typeof this.onmessage === 'function') {
            try { this.onmessage(text, { via, time: t }); } catch (e) { /* a listener must not break the relay */ }
        }
    }

    // --- ntfy ---

    _connectNtfy() {
        if (this._closed || !this.ntfy || !this.topic || typeof this._ES !== 'function') return;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        if (this._es) {
            try { this._es.close(); } catch (e) { /* ignore */ }
        }
        const since = this._lastNtfyId || this.since;
        const url = this.ntfy + '/' + this.topic + '/sse' + (since ? '?since=' + encodeURIComponent(since) : '');
        let es;
        try {
            es = new this._ES(url);
        } catch (e) {
            this._es = null;
            this._scheduleNtfy();
            return;
        }
        this._es = es;
        es.onopen = () => {
            if (es !== this._es) return;
            this._retry = 0;
            this._setNtfy(true);
        };
        es.onmessage = ev => {
            if (es === this._es) this._onNtfy(ev && ev.data);
        };
        const named = ev => {
            // ntfy sends 'open' and 'keepalive' as named SSE events; the built-in 'open' has no data.
            if (es === this._es && ev && typeof ev.data === 'string') this._onNtfy(ev.data);
        };
        if (typeof es.addEventListener === 'function') {
            es.addEventListener('open', named);
            es.addEventListener('keepalive', named);
        }
        es.onerror = () => {
            if (es !== this._es) return;
            this._setNtfy(false);
            // CONNECTING (0): the browser retries by itself. CLOSED (2): it gave up, so we retry.
            if (es.readyState === 2) this._scheduleNtfy();
        };
    }

    _setNtfy(on) {
        this._esOpen = on;
        this._changed();
    }

    _scheduleNtfy() {
        if (this._closed || this._retryTimer) return;
        const s = RECONNECT_S[Math.min(this._retry++, RECONNECT_S.length - 1)];
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this._connectNtfy();
        }, s * 1000);
    }

    _onNtfy(raw) {
        if (typeof raw !== 'string') return;
        let ev;
        try { ev = JSON.parse(raw); } catch (e) { return; }
        if (!ev || typeof ev !== 'object') return;
        if (ev.event === 'open' || ev.event === 'keepalive') {
            this._noteTime(ev.time);
            return;
        }
        if (ev.event !== 'message' || typeof ev.message !== 'string') return;
        if (typeof ev.id === 'string' && ev.id) this._lastNtfyId = ev.id;
        this._deliver(ev.message, 'ntfy', ev.time);
    }

    async _ntfyPublish(envelope) {
        if (!this.ntfy) return { via: 'mqtt', ok: false, status: 0, error: new Error('no broker connected') };
        let res;
        try {
            res = await this._fetch(this.ntfy + '/' + this.topic + '?firebase=no', {
                method: 'POST', body: envelope, credentials: 'omit', referrerPolicy: 'no-referrer',
            });
        } catch (e) {
            return { via: 'ntfy', ok: false, status: 0, error: e };
        }
        if (!res.ok) {
            return { via: 'ntfy', ok: false, status: res.status, body: res.status === 429 ? await readText(res) : '' };
        }
        try {
            const j = await res.json();
            if (j && typeof j.time === 'number') this._noteTime(j.time);
        } catch (e) { /* body is optional */ }
        return { via: 'ntfy', ok: true, status: res.status };
    }

    /** Publishes one envelope (contract in the class comment). Never throws. */
    async publish(envelope, { via } = {}) {
        if (this._closed) return { via: via === 'ntfy' || !this.brokers.length ? 'ntfy' : 'mqtt', ok: false, status: 0, error: new Error('relay closed') };
        this.start();
        if (via !== 'ntfy') {
            let n = 0;
            for (const c of this._clients) if (c.publish(envelope)) n++;
            if (n) return { via: 'mqtt', ok: true, count: n };
            if (via === 'mqtt-only') return { via: 'mqtt', ok: false, status: 0, error: new Error('no broker connected') };
        }
        return this._ntfyPublish(envelope);
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        clearTimeout(this._retryTimer);
        clearTimeout(this._graceTimer);
        this._retryTimer = null;
        for (const c of this._clients) c.close();
        if (this._es) {
            try { this._es.close(); } catch (e) { /* ignore */ }
        }
        this._es = null;
        this._esOpen = false;
        for (const w of this._waiters.slice()) w(false);
        this._waiters = [];
    }
}
