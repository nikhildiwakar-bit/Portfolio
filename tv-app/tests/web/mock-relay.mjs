// Tiny ntfy.sh imitation for browser tests: POST publish (text or ?filename= attachment), GET /<topic>/sse,
// GET /<topic>/json, GET /file/<id>, CORS (incl. preflight) and a switchable HTTP 429 mode. tvTransport() wires
// a fake TV to this relay and, for 4-digit codes, to the local MQTT broker (servers.mjs startMqttBroker).
import { randomBytes } from 'node:crypto';
import { MQTT_PREFIX } from '../../../tv/relay.js';

const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
const MESSAGE_LIMIT = 4096;

export function createRelay() {
    const subs = new Map();   // topic -> Set<fn(event)>
    const relay = {
        rateLimit: false,
        rateLimitCode: 42908, // 42908 = daily message quota, 42901 = too many requests right now
        requests: [],         // {method, path, tls, host, contentType}
        posts: [],            // {topic, query, headers, size, text}
        files: new Map(),     // id -> Uint8Array
        errors: [],
        streams: new Set(),
        cache: new Map(),     // topic -> recent message events (replayed for ?since=)
    };

    const newId = () => randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12);
    const now = () => Math.floor(Date.now() / 1000);

    relay.subscribe = (topic, fn) => {
        if (!subs.has(topic)) subs.set(topic, new Set());
        subs.get(topic).add(fn);
        return () => subs.get(topic).delete(fn);
    };

    relay.publish = (topic, message, extra, { cache = true } = {}) => {
        const ev = Object.assign({ id: newId(), time: now(), event: 'message', topic, message }, extra);
        if (cache) {
            if (!relay.cache.has(topic)) relay.cache.set(topic, []);
            const list = relay.cache.get(topic);
            list.push(ev);
            if (list.length > 200) list.shift();
        }
        for (const fn of Array.from(subs.get(topic) || [])) {
            try { fn(ev); } catch (e) { relay.errors.push(String(e)); }
        }
        return ev;
    };

    relay.sseCount = topic => Array.from(relay.streams).filter(s => s.topic === topic).length;

    /** Closes every open SSE stream (optionally one topic) to test reconnects. */
    relay.dropStreams = topic => {
        for (const s of Array.from(relay.streams)) if (!topic || s.topic === topic) s.res.destroy();
    };

    relay.attachmentBytes = url => {
        const m = /\/file\/([A-Za-z0-9]+)\.bin$/.exec(String(url));
        return m ? relay.files.get(m[1]) || null : null;
    };

    function cors(res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }

    function json(res, status, obj) {
        cors(res);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj) + '\n');
    }

    function readBody(req, limit) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', c => {
                size += c.length;
                if (size > limit) {
                    reject(new Error('too large'));
                    req.destroy();
                } else chunks.push(c);
            });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
        });
    }

    /** Cached events matching ntfy's since=: 'all', a duration like 30s / 5m / 1h, a unix time or a message id. */
    function sinceEvents(topic, since) {
        const list = relay.cache.get(topic) || [];
        if (!since) return [];
        if (since === 'all') return list.slice();
        const d = /^(\d+)([smh])$/.exec(since);
        if (d) {
            const from = now() - Number(d[1]) * { s: 1, m: 60, h: 3600 }[d[2]];
            return list.filter(e => e.time >= from);
        }
        if (/^\d+$/.test(since)) return list.filter(e => e.time >= Number(since));
        const i = list.findIndex(e => e.id === since);
        return i >= 0 ? list.slice(i + 1) : [];
    }

    function stream(req, res, topic, format, since) {
        cors(res);
        res.writeHead(200, {
            'Content-Type': format === 'sse' ? 'text/event-stream' : 'application/x-ndjson',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        const write = ev => {
            const data = JSON.stringify(ev);
            if (format === 'json') res.write(data + '\n');
            else if (ev.event === 'message') res.write('id: ' + ev.id + '\ndata: ' + data + '\n\n');
            else res.write('event: ' + ev.event + '\ndata: ' + data + '\n\n');
        };
        const entry = { topic, res };
        relay.streams.add(entry);
        const unsub = relay.subscribe(topic, write);
        write({ id: newId(), time: now(), event: 'open', topic });
        for (const ev of sinceEvents(topic, since)) write(ev);
        const ka = setInterval(() => write({ id: newId(), time: now(), event: 'keepalive', topic }), 25000);
        const done = () => {
            clearInterval(ka);
            unsub();
            relay.streams.delete(entry);
        };
        req.on('close', done);
        res.on('close', done);
    }

    relay.handler = async (req, res) => {
        const u = new URL(req.url, 'http://relay');
        relay.requests.push({
            method: req.method, path: u.pathname + u.search, tls: !!req.socket.encrypted,
            host: req.headers.host, contentType: req.headers['content-type'] || '',
        });
        const parts = u.pathname.split('/').filter(Boolean);
        try {
            if (req.method === 'OPTIONS') {
                cors(res);
                res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, PATCH, DELETE');
                res.setHeader('Access-Control-Allow-Headers', '*');
                res.writeHead(200);
                res.end();
                return;
            }
            if (req.method === 'GET' && parts[0] === 'file' && parts.length === 2) {
                const bytes = relay.files.get(parts[1].replace(/\.bin$/, ''));
                if (!bytes) return json(res, 404, { code: 40401, http: 404, error: 'not found' });
                cors(res);
                res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
                res.end(Buffer.from(bytes));
                return;
            }
            if (req.method === 'GET' && parts.length === 2 && TOPIC_RE.test(parts[0]) && (parts[1] === 'sse' || parts[1] === 'json')) {
                stream(req, res, parts[0], parts[1], u.searchParams.get('since'));
                return;
            }
            if ((req.method === 'POST' || req.method === 'PUT') && parts.length === 1 && TOPIC_RE.test(parts[0])) {
                const topic = parts[0];
                const body = await readBody(req, 20 * 1024 * 1024);
                const filename = u.searchParams.get('filename');
                const text = filename ? null : body.toString('utf8');
                relay.posts.push({ topic, query: u.search, headers: req.headers, size: body.length, text });
                if (relay.rateLimit) {
                    return json(res, 429, {
                        code: relay.rateLimitCode, http: 429,
                        error: relay.rateLimitCode === 42901 ? 'limit reached: too many requests' : 'limit reached: daily message quota reached',
                    });
                }
                if (filename || body.length > MESSAGE_LIMIT) {
                    if (!filename) relay.errors.push('message over ' + MESSAGE_LIMIT + ' bytes became an attachment');
                    if (body.length > 15 * 1024 * 1024) {
                        return json(res, 413, { code: 41301, http: 413, error: 'attachment too large' });
                    }
                    const id = newId();
                    relay.files.set(id, new Uint8Array(body));
                    const proto = req.socket.encrypted ? 'https' : 'http';
                    const ev = relay.publish(topic, 'You received a file: ' + (filename || 'attachment.bin'), {
                        attachment: {
                            name: filename || 'attachment.bin', type: 'application/octet-stream', size: body.length,
                            expires: now() + 3 * 3600, url: proto + '://' + req.headers.host + '/file/' + id + '.bin',
                        },
                    });
                    return json(res, 200, ev);
                }
                return json(res, 200, relay.publish(topic, text, undefined, { cache: u.searchParams.get('cache') !== 'no' }));
            }
            json(res, 404, { code: 40401, http: 404, error: 'page not found' });
        } catch (e) {
            relay.errors.push(String(e));
            if (!res.headersSent) json(res, 500, { code: 50001, http: 500, error: String(e) });
        }
    };

    relay.close = () => relay.dropStreams();
    return relay;
}

/**
 * How a fake TV (tests/node/fake-tv.mjs) talks, like the Office TV app: over this relay, and with a broker
 * (Office TV 3.6+, 4-digit codes) over MQTT too, acking on the transport each command came over.
 *   const t = tvTransport(relay, broker);
 *   const tv = await createFakeTv({ code, publish: t.publish });
 *   t.listen(tv);
 * The acks go to the relay with cache=no (never replayed), as the app sends them. broker may be null.
 */
export function tvTransport(relay, broker = null) {
    return {
        publish(topic, env, via) {
            if (via === 'mqtt' && broker) broker.publish(MQTT_PREFIX + topic, env);
            else relay.publish(topic, env, undefined, { cache: false });
        },
        listen(tv, { ntfy = true, mqtt = true } = {}) {
            const off = [];
            if (ntfy) off.push(relay.subscribe(tv.topic, ev => tv.handle(ev, 'ntfy')));
            if (mqtt && broker) {
                off.push(broker.subscribe(MQTT_PREFIX + tv.topic, text => tv.handle({ event: 'message', message: text, time: Date.now() / 1000 }, 'mqtt', 'broker')));
            }
            return () => { for (const f of off) f(); };
        },
    };
}
