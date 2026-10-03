// Local servers for the browser tests: a static file server for the repo (serves /tv/ like GitHub Pages),
// HTTP/HTTPS listeners for the mock relay and a local MQTT broker (ws:// or wss://) for 4-digit codes.
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { startFakeMqtt } from '../node/fake-mqtt.mjs';

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function listen(server) {
    return new Promise((res, rej) => {
        server.once('error', rej);
        server.listen(0, '127.0.0.1', () => res(server.address().port));
    });
}

export async function startStatic(root) {
    const base = resolve(root);
    const server = http.createServer((req, res) => {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (p.endsWith('/')) p += 'index.html';
        const file = normalize(join(base, p));
        if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(readFileSync(file));
    });
    const port = await listen(server);
    return { url: 'http://127.0.0.1:' + port, close: () => closeServer(server) };
}

function closeServer(server) {
    return new Promise(r => {
        server.closeAllConnections && server.closeAllConnections();
        server.close(() => r());
    });
}

/** Self-signed certificate for ntfy.sh (used with Chromium's host resolver rules). Null if openssl is missing. */
export function makeCert(host = 'ntfy.sh') {
    try {
        const dir = mkdtempSync(join(tmpdir(), 'otv-cert-'));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'),
            '-out', join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=' + host, '-addext', 'subjectAltName=DNS:' + host],
        { stdio: 'ignore' });
        return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
    } catch (e) {
        return null;
    }
}

export async function startRelayServers(relay, { tls = null } = {}) {
    const h = http.createServer(relay.handler);
    const out = { httpUrl: 'http://127.0.0.1:' + await listen(h), httpsPort: 0 };
    const servers = [h];
    if (tls) {
        const s = https.createServer(tls, relay.handler);
        out.httpsPort = await listen(s);
        servers.push(s);
    }
    out.close = async () => {
        relay.close();
        await Promise.all(servers.map(closeServer));
    };
    return out;
}

/**
 * A local MQTT 3.1.1 broker over WebSocket (tests/node/fake-mqtt.mjs) standing in for the public brokers:
 * {url, port, publish, subscribe, drop, published, close(), ...}. With tls (makeCert()) it is wss://, which the
 * pages' Content-Security-Policy needs (receive.html allows wss: only, phone.html only the three public brokers).
 * Two ways to point pages at it:
 *   - Chromium --host-resolver-rules 'MAP broker.emqx.io 127.0.0.1:<port>' (the page keeps its real broker list;
 *     contexts need ignoreHTTPSErrors for the self-signed certificate), or
 *   - window.__otvRelayConfig = {brokers: [url]} before the page's scripts run (page.addInitScript), which
 *     tv/relay.js reads for every new connection (index.html has no CSP, so ws:// works there too).
 */
export function startMqttBroker({ tls = null } = {}) {
    return startFakeMqtt({ tls });
}
