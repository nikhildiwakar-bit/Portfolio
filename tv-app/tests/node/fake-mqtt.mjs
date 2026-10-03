// A small but real MQTT 3.1.1 broker over WebSocket for tests (node:http upgrade + hand-written RFC 6455
// framing, no packages). It speaks exactly what Office TV uses (PROTOCOL.md section 6): CONNECT / CONNACK,
// SUBSCRIBE / SUBACK (QoS 0), PUBLISH QoS 0 fan-out to every subscriber (the publisher included, as in MQTT
// 3.1.1), PINGREQ / PINGRESP and DISCONNECT. Its MQTT parser is written independently of tv/mqtt.js, so the
// tests do not check the client against itself.
//
//   const b = await startFakeMqtt();   // b.url = 'ws://127.0.0.1:<port>/mqtt'
//   b.subscribe(topic, text => ...)    // in-process listener (a fake TV)
//   b.publish(topic, text)             // in-process publish to every subscribed client
//   b.drop()                           // cut every client's socket (reconnect tests); b.close() stops it
//   await startFakeMqtt({ tls: { key, cert } })   // wss:// (pages whose CSP allows only wss:, browser tests)
//
// Knobs for edge cases: refuse (CONNACK return code, e.g. 5), refuseSubscribe, noPong (ignore PINGREQ),
// silent (accept the socket, never answer CONNECT), coalesce (several packets per WebSocket message),
// splitAt (every packet sent in WebSocket messages of at most n bytes), down (reject the upgrade with 503).
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encLen(n) {
    const out = [];
    do {
        let b = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) b |= 128;
        out.push(b);
    } while (n > 0);
    return Buffer.from(out);
}

function mqttPacket(first, body) {
    return Buffer.concat([Buffer.from([first]), encLen(body.length), body]);
}

function str(s) {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]);
}

/** An MQTT PUBLISH packet (QoS 0, or 1 with a packet id). Exported for tests that inject raw bytes. */
export function publishBytes(topic, text, { qos = 0, id = 1, retain = false } = {}) {
    const parts = [str(topic)];
    if (qos) parts.push(Buffer.from([id >> 8, id & 255]));
    parts.push(Buffer.from(text, 'utf8'));
    return mqttPacket(0x30 | (qos << 1) | (retain ? 1 : 0), Buffer.concat(parts));
}

function wsFrame(opcode, payload) {
    const n = payload.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | opcode, n]);
    else if (n < 65536) head = Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
    else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode;
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(n), 2);
    }
    return Buffer.concat([head, payload]);
}

export async function startFakeMqtt({ host = '127.0.0.1', port = 0, path = '/mqtt', tls = null } = {}) {
    const broker = {
        url: '', port: 0,
        clients: new Set(),   // connected sessions {id, keepAlive, subs:Set, sock, ...}
        connects: 0,          // CONNECTs accepted
        upgrades: 0,          // WebSocket handshakes
        published: [],        // {topic, text, clientId} of every client PUBLISH
        pings: 0,
        pubacks: [],          // packet ids a client acknowledged (QoS 1 tests)
        errors: [],           // protocol problems of clients (a test expects none)
        connectPackets: [],   // {protocol, level, flags, keepAlive, clientId} of every CONNECT
        refuse: 0, refuseSubscribe: false, noPong: false, silent: false, coalesce: false, splitAt: 0, down: false,
    };
    const listeners = new Map(); // topic -> Set<fn(text)>
    const conns = new Set();     // every WebSocket connection, connected to MQTT or not

    const subscribers = topic => Array.from(broker.clients).filter(c => c.subs.has(topic));

    function sendRaw(c, bytes) {
        if (c.closed) return;
        if (broker.splitAt > 0) {
            for (let i = 0; i < bytes.length; i += broker.splitAt) c.sock.write(wsFrame(2, bytes.subarray(i, i + broker.splitAt)));
        } else if (broker.coalesce) {
            c.queue.push(bytes);
            if (!c.flush) {
                c.flush = setImmediate(() => {
                    c.flush = null;
                    const all = Buffer.concat(c.queue);
                    c.queue = [];
                    if (!c.closed) c.sock.write(wsFrame(2, all));
                });
            }
        } else {
            c.sock.write(wsFrame(2, bytes));
        }
    }

    function fanOut(topic, text, from) {
        const pkt = publishBytes(topic, text);
        for (const c of subscribers(topic)) sendRaw(c, pkt);
        for (const fn of Array.from(listeners.get(topic) || [])) {
            try { fn(text, from); } catch (e) { broker.errors.push('listener: ' + e.message); }
        }
    }

    function kill(c) {
        if (c.closed) return;
        c.closed = true;
        broker.clients.delete(c);
        clearImmediate(c.flush);
        c.sock.destroy();
    }

    function onPacket(c, first, body) {
        const type = first >> 4;
        if (!c.connected && type !== 1) {
            broker.errors.push('packet ' + type + ' before CONNECT');
            kill(c);
            return;
        }
        switch (type) {
            case 1: { // CONNECT
                const pl = (body[0] << 8) | body[1];
                const protocol = body.subarray(2, 2 + pl).toString('utf8');
                let o = 2 + pl;
                const level = body[o], flags = body[o + 1], keepAlive = (body[o + 2] << 8) | body[o + 3];
                o += 4;
                const il = (body[o] << 8) | body[o + 1];
                const clientId = body.subarray(o + 2, o + 2 + il).toString('utf8');
                broker.connectPackets.push({ protocol, level, flags, keepAlive, clientId, rest: body.length - (o + 2 + il) });
                if (c.connected) { broker.errors.push('second CONNECT'); kill(c); return; }
                if (broker.silent) return;
                if (broker.refuse) {
                    c.sock.write(wsFrame(2, Buffer.from([0x20, 2, 0, broker.refuse])));
                    setTimeout(() => kill(c), 20);
                    return;
                }
                c.connected = true;
                c.id = clientId;
                c.keepAlive = keepAlive;
                broker.clients.add(c);
                broker.connects++;
                sendRaw(c, Buffer.from([0x20, 2, 0, 0]));
                return;
            }
            case 3: { // PUBLISH
                const qos = (first >> 1) & 3;
                const tl = (body[0] << 8) | body[1];
                const topic = body.subarray(2, 2 + tl).toString('utf8');
                let o = 2 + tl;
                if (qos) {
                    broker.errors.push('client published with QoS ' + qos);
                    o += 2;
                }
                if (first & 1) broker.errors.push('client published with retain');
                const text = body.subarray(o).toString('utf8');
                broker.published.push({ topic, text, clientId: c.id });
                fanOut(topic, text, c.id);
                return;
            }
            case 4: // PUBACK
                broker.pubacks.push((body[0] << 8) | body[1]);
                return;
            case 8: { // SUBSCRIBE
                if ((first & 15) !== 2) broker.errors.push('SUBSCRIBE flags ' + (first & 15));
                const id = (body[0] << 8) | body[1];
                let o = 2;
                const codes = [];
                while (o < body.length) {
                    const tl = (body[o] << 8) | body[o + 1];
                    const topic = body.subarray(o + 2, o + 2 + tl).toString('utf8');
                    const qos = body[o + 2 + tl];
                    o += 3 + tl;
                    if (qos !== 0) broker.errors.push('SUBSCRIBE QoS ' + qos);
                    if (!broker.refuseSubscribe) c.subs.add(topic);
                    codes.push(broker.refuseSubscribe ? 0x80 : 0);
                }
                sendRaw(c, mqttPacket(0x90, Buffer.from([id >> 8, id & 255].concat(codes))));
                return;
            }
            case 12: // PINGREQ
                broker.pings++;
                if (!broker.noPong) sendRaw(c, Buffer.from([0xd0, 0]));
                return;
            case 14: // DISCONNECT
                kill(c);
                return;
            default:
                broker.errors.push('unexpected packet type ' + type);
        }
    }

    function onMqttBytes(c, bytes) {
        c.mbuf = c.mbuf.length ? Buffer.concat([c.mbuf, bytes]) : bytes;
        for (;;) {
            if (c.mbuf.length < 2) return;
            let len = 0, mul = 1, i = 1, done = false;
            for (; i < 5 && i < c.mbuf.length; i++) {
                len += (c.mbuf[i] & 127) * mul;
                mul *= 128;
                if (!(c.mbuf[i] & 128)) { done = true; break; }
            }
            if (!done) {
                if (i >= 5) { broker.errors.push('malformed length'); kill(c); }
                return;
            }
            const start = i + 1;
            if (c.mbuf.length < start + len) return;
            const first = c.mbuf[0];
            const body = c.mbuf.subarray(start, start + len);
            c.mbuf = c.mbuf.subarray(start + len);
            onPacket(c, first, Buffer.from(body));
            if (c.closed) return;
        }
    }

    function onWsBytes(c, chunk) {
        c.wbuf = c.wbuf.length ? Buffer.concat([c.wbuf, chunk]) : chunk;
        for (;;) {
            const b = c.wbuf;
            if (b.length < 2) return;
            const fin = !!(b[0] & 0x80), opcode = b[0] & 15, masked = !!(b[1] & 0x80);
            let n = b[1] & 127, o = 2;
            if (n === 126) { if (b.length < 4) return; n = b.readUInt16BE(2); o = 4; }
            else if (n === 127) { if (b.length < 10) return; n = Number(b.readBigUInt64BE(2)); o = 10; }
            if (!masked) { broker.errors.push('unmasked client frame'); kill(c); return; }
            if (b.length < o + 4 + n) return;
            const mask = b.subarray(o, o + 4);
            const payload = Buffer.alloc(n);
            for (let i = 0; i < n; i++) payload[i] = b[o + 4 + i] ^ mask[i & 3];
            c.wbuf = b.subarray(o + 4 + n);
            if (opcode === 8) { // close
                if (!c.closed) c.sock.write(wsFrame(8, Buffer.alloc(0)));
                kill(c);
                return;
            }
            if (opcode === 9) { c.sock.write(wsFrame(10, payload)); continue; }
            if (opcode === 10) continue;
            if (opcode === 1) broker.errors.push('text frame from client');
            if (opcode === 0 || opcode === 1 || opcode === 2) {
                c.frag.push(payload);
                if (fin) {
                    const all = Buffer.concat(c.frag);
                    c.frag = [];
                    onMqttBytes(c, all);
                    if (c.closed) return;
                }
            }
        }
    }

    const plain = (req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('MQTT over WebSocket only');
    };
    const server = tls ? https.createServer(tls, plain) : http.createServer(plain);
    server.on('upgrade', (req, sock) => {
        const key = req.headers['sec-websocket-key'];
        const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
        if (broker.down || new URL(req.url, 'http://x').pathname !== path || !key || protos.indexOf('mqtt') < 0) {
            sock.end('HTTP/1.1 ' + (broker.down ? '503 Service Unavailable' : '400 Bad Request') + '\r\nConnection: close\r\n\r\n');
            return;
        }
        broker.upgrades++;
        const accept = createHash('sha1').update(key + GUID).digest('base64');
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            + 'Sec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n');
        sock.setNoDelay(true);
        const c = { sock, id: '', subs: new Set(), connected: false, closed: false, wbuf: Buffer.alloc(0), mbuf: Buffer.alloc(0), frag: [], queue: [], flush: null };
        conns.add(c);
        sock.on('data', d => onWsBytes(c, d));
        sock.on('error', () => kill(c));
        sock.on('close', () => { conns.delete(c); kill(c); });
    });

    await new Promise((res, rej) => {
        server.once('error', rej);
        server.listen(port, host, () => res());
    });
    broker.port = server.address().port;
    broker.url = (tls ? 'wss://' : 'ws://') + host + ':' + broker.port + path;

    broker.subscribe = (topic, fn) => {
        if (!listeners.has(topic)) listeners.set(topic, new Set());
        listeners.get(topic).add(fn);
        return () => listeners.get(topic).delete(fn);
    };
    broker.publish = (topic, text) => fanOut(topic, text, '');
    /** Raw MQTT bytes to every client subscribed to `topic` (or every client), for edge cases. */
    broker.sendRaw = (bytes, topic) => {
        for (const c of topic ? subscribers(topic) : Array.from(broker.clients)) sendRaw(c, Buffer.from(bytes));
    };
    /** Clients subscribed to `topic`. */
    broker.subscriberCount = topic => subscribers(topic).length;
    /** Cuts every connection (including ones that never sent CONNECT). */
    broker.drop = () => { for (const c of Array.from(conns)) kill(c); };
    broker.published.of = topic => broker.published.filter(p => p.topic === topic);
    broker.close = () => new Promise(r => {
        broker.drop();
        server.close(() => r());
    });
    return broker;
}
