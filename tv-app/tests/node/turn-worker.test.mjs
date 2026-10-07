// The TURN credentials Worker (tv-app/turn-worker/worker.js) with a fake Cloudflare API.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../turn-worker/worker.js';

const ORIGIN = 'https://nikhildiwakar-bit.github.io';
const ENV = { TURN_KEY_ID: 'key1', TURN_KEY_API_TOKEN: 'secret-token' };
const req = (path = '/ice', origin = ORIGIN, method = 'GET') =>
    new Request('https://otv-turn.example.workers.dev' + path, { method, headers: origin ? { Origin: origin } : {} });

test('turn worker: refuses other paths, other sites and a missing key; never calls the API for them', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('no'); };
    assert.equal((await worker.fetch(req('/'), ENV)).status, 404);
    const evil = await worker.fetch(req('/ice', 'https://evil.example'), ENV);
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal((await worker.fetch(req('/ice'), {})).status, 500);
    const pre = await worker.fetch(req('/ice', ORIGIN, 'OPTIONS'), ENV);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(calls, 0);
});

test('turn worker: an API error is a 502, not a crash', async () => {
    globalThis.fetch = async () => new Response('nope', { status: 401 });
    assert.equal((await worker.fetch(req(), ENV)).status, 502);
});

test('turn worker: asks Cloudflare for 8-hour credentials with the secret token, returns only iceServers, caches them', async () => {
    const asked = [];
    globalThis.fetch = async (url, init) => {
        asked.push({ url, init });
        return new Response(JSON.stringify({ iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u', credential: 'c' },
        ] }), { status: 200 });
    };
    const r = await worker.fetch(req(), ENV);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const body = await r.json();
    assert.equal(body.iceServers.length, 2);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key1/credentials/generate-ice-servers');
    assert.equal(asked[0].init.headers.Authorization, 'Bearer secret-token');
    assert.deepEqual(JSON.parse(asked[0].init.body), { ttl: 28800 });
    assert.ok(!JSON.stringify(body).includes('secret-token'), 'the token never leaves the Worker');
    await worker.fetch(req(), ENV);
    assert.equal(asked.length, 1, 'cached for an hour');
});
