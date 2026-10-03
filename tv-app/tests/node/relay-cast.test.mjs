// tv-app/ci/relay-cast.mjs (the CI's real-relay check) against local stand-ins: the fake MQTT broker for the public
// brokers (via globalThis.__otvRelayConfig, set by a preload) and the browser tests' mock ntfy over HTTP
// (its NDJSON stream), with a fake TV that acks on the transport each command came over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeTv } from './fake-tv.mjs';
import { startFakeMqtt } from './fake-mqtt.mjs';
import { createRelay, tvTransport } from '../web/mock-relay.mjs';
import { startRelayServers } from '../web/servers.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../ci/relay-cast.mjs');
const PRELOAD = 'data:text/javascript,globalThis.__otvRelayConfig={brokers:JSON.parse(process.env.OTV_TEST_BROKERS||"[]")}';

function run(argv, brokers) {
    return new Promise(res => {
        execFile(process.execPath, ['--import', PRELOAD, SCRIPT].concat(argv), {
            env: Object.assign({}, process.env, { OTV_TEST_BROKERS: JSON.stringify(brokers) }), timeout: 60000,
        }, (err, stdout, stderr) => {
            const line = String(stdout).split('\n').find(l => l.startsWith('RESULT '));
            res({ code: err ? err.code : 0, result: line ? JSON.parse(line.slice(7)) : null, stdout, stderr });
        });
    });
}

async function rig() {
    const broker = await startFakeMqtt();
    const relay = createRelay();
    const srv = await startRelayServers(relay);
    const t = tvTransport(relay, broker);
    const tvs = [];
    const tv = async (code, opts = {}) => {
        const x = await createFakeTv({ code, name: 'CI TV', publish: t.publish });
        t.listen(x, opts);
        tvs.push(x);
        return x;
    };
    const close = async () => { await srv.close(); await broker.close(); };
    return { broker, relay, url: srv.httpUrl, tv, close };
}

test('relay-cast: a 4-digit code answers over MQTT (auto), over ntfy (--transport ntfy); a 10-symbol code over ntfy', async () => {
    const { broker, relay, url, tv, close } = await rig();
    try {
        const a = await tv('0427');
        const r = await run(['--code', '0427', '--step', 'ping', '--relay', url, '--timeout', '20'], [broker.url]);
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.deepEqual([r.result.step, r.result.exit, r.result.ok, r.result.via, r.result.transport], ['ping', 0, true, 'mqtt', 'auto']);
        assert.equal(r.result.data.name, 'CI TV');
        assert.equal(r.result.brokers, 1);
        assert.equal(relay.posts.length, 0, 'no ntfy message');
        const s = await run(['--code', '0427', '--step', 'start', '--session', 'abcdefghij012345', '--relay', url, '--transport', 'ntfy'], [broker.url]);
        assert.equal(s.code, 0, s.stdout + s.stderr);
        assert.equal(s.result.via, 'ntfy');
        assert.equal(s.result.msg, 'The TV is ready to show your screen.');
        const m = await run(['--code', '0427', '--step', 'stop', '--session', 'abcdefghij012345', '--relay', url, '--transport', 'mqtt'], [broker.url]);
        assert.equal(m.code, 0, m.stdout + m.stderr);
        assert.equal(m.result.via, 'mqtt');
        assert.deepEqual(a.vias, ['mqtt', 'ntfy', 'mqtt']);
        await tv('7K3M9QX2TD');
        const old = await run(['--code', '7K3M9-QX2TD', '--step', 'ping', '--relay', url], [broker.url]);
        assert.equal(old.code, 0, old.stdout + old.stderr);
        assert.equal(old.result.via, 'ntfy');
        assert.deepEqual(a.errors, []);
    } finally {
        await close();
    }
});

test('relay-cast: the ntfy copy reaches a TV without MQTT; no broker with --transport mqtt is a warning; bad input fails', async () => {
    const { broker, url, tv, close } = await rig();
    try {
        const a = await tv('5810', { mqtt: false });
        const r = await run(['--code', '5810', '--step', 'ping', '--relay', url, '--timeout', '20'], [broker.url]);
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.equal(r.result.via, 'ntfy', 'answered after the 2.5 s ntfy copy');
        assert.ok(r.result.ms >= 2400);
        assert.deepEqual(a.vias, ['ntfy']);
        broker.down = true;
        broker.drop();
        const w = await run(['--code', '5810', '--step', 'ping', '--relay', url, '--transport', 'mqtt', '--timeout', '8'], [broker.url]);
        assert.equal(w.code, 2, w.stdout + w.stderr);
        assert.match(w.result.error, /MQTT/);
        const bad = await run(['--code', '7K3M9QX2TD', '--transport', 'mqtt'], []);
        assert.equal(bad.code, 1);
        assert.match(bad.result.error, /4-digit/);
        const nocode = await run(['--code', 'nope'], []);
        assert.equal(nocode.code, 1);
    } finally {
        await close();
    }
});
