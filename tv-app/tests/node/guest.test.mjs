// Guest sharing: a laptop on another network (4-digit code) waits for OK on the TV; TURN servers from the
// credentials service; the TV never shows (or starts direct video for) a laptop before it is allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CastReceiver, ICE_SERVERS, guestPin, hasTurn, loadIceServers, readControl, resetIceCache, validIceServers,
} from '../../../tv/cast.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

class FakeDC extends EventTarget {
    constructor() { super(); this.readyState = 'connecting'; this.sent = []; this.label = 'otv'; }
    send(d) { this.sent.push(d); }
    _open() { this.readyState = 'open'; this.dispatchEvent(new Event('open')); }
}

/** A receiver already connected to a laptop at `address` (as the selected candidate pair reports it). */
function connected({ address, approve, approveMs, video } = {}) {
    const rx = new CastReceiver({ code: '4711', relay: 'https://ntfy.example', session: 'sess-1', ip: '192.168.1.40',
        statsMs: 0, window: {}, approve, approveMs, video });
    const relaySent = [];
    rx.channel = { send: async (c, d) => { relaySent.push(c + ':' + d); }, close() {}, probe() {} };
    rx.state = 'connecting';
    rx.pc = {
        connectionState: 'connected', iceConnectionState: 'connected', close() {},
        getStats: async () => new Map([
            ['p', { id: 'p', type: 'candidate-pair', state: 'succeeded', nominated: true, selected: true, localCandidateId: 'l', remoteCandidateId: 'r' }],
            ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }],
            ['l', { id: 'l', type: 'local-candidate', address: '192.168.1.40', candidateType: 'host' }],
            ['r', { id: 'r', type: 'remote-candidate', address, candidateType: 'srflx' }],
        ]),
    };
    const shown = [];
    rx.ontrack = s => shown.push(s);
    rx._media = ['stream', 'track'];
    const dc = new FakeDC();
    rx._watchChannel(dc);
    return { rx, dc, relaySent, shown };
}

const controls = dc => dc.sent.map(m => readControl(m)).filter(Boolean);
const fakeVideo = () => ({ caps: () => JSON.stringify({ codecs: ['avc'], maxWidth: 1920, maxHeight: 1080, maxFps: 60 }), start: () => true, stop() {} });

test('guestPin: 3 digits, the same on both sides for a session, different sessions differ', async () => {
    const a = await guestPin('session-a');
    assert.match(a, /^\d{3}$/);
    assert.equal(await guestPin('session-a'), a);
    const all = new Set();
    for (let i = 0; i < 50; i++) all.add(await guestPin('s' + i));
    assert.ok(all.size > 30);
});

test('same network: no question, shown at once; direct video offered only after the check', async () => {
    let asked = 0;
    const { rx, dc, shown } = connected({ address: '192.168.1.77', approve: async () => { asked++; return true; }, video: fakeVideo() });
    dc._open();
    assert.deepEqual(controls(dc), [], 'no direct-video hello before the network check');
    rx._onConn();
    await sleep(30);
    assert.equal(asked, 0);
    assert.equal(rx.guest, false);
    assert.deepEqual(shown, ['stream']);
    assert.equal(controls(dc)[0].type, 'native', 'the hello after the check');
    rx.end('stopped');
});

test('guest allowed: the laptop is told to wait (with the number), nothing shown until OK, then allowed', async () => {
    let resolveOk;
    let pin = '';
    const { rx, dc, shown } = connected({ address: '203.0.113.5', video: fakeVideo(), approve: p => { pin = p; return new Promise(r => { resolveOk = r; }); } });
    rx._onConn();
    await sleep(30);
    assert.equal(rx.guest, true);
    assert.match(pin, /^\d{3}$/);
    assert.deepEqual(shown, [], 'nothing on the TV before the OK');
    assert.deepEqual(dc.sent, [], 'the channel is not open yet: the message waits');
    dc._open();
    assert.deepEqual(controls(dc), [{ type: 'guest', state: 'waiting', pin }]);
    // A laptop trying direct video now is ignored.
    let started = 0;
    rx.video.start = () => { started++; return true; };
    dc.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ type: 'video', v: 1, state: 'start', codec: 'avc', width: 1920, height: 1080 }) }));
    assert.equal(started, 0, 'no direct video before the OK');
    resolveOk(true);
    await sleep(10);
    assert.deepEqual(shown, ['stream']);
    const c = controls(dc);
    assert.deepEqual(c[1], { type: 'guest', state: 'allowed' });
    assert.equal(c[2].type, 'native', 'direct video offered after the OK');
    rx.end('stopped');
});

test('guest refused, or no answer in time: "denied" on both sides, nothing shown', async () => {
    for (const approve of [async () => false, () => new Promise(() => {})]) {
        const { rx, dc, relaySent, shown } = connected({ address: '203.0.113.5', approve, approveMs: 50 });
        dc._open();
        let ended = '';
        rx.onend = r => { ended = r; };
        rx._onConn();
        await sleep(800);
        assert.equal(ended, 'denied');
        assert.ok(dc.sent.includes('bye:denied'));
        assert.ok(relaySent.includes('bye:denied'));
        assert.deepEqual(shown, []);
    }
});

test('no approve callback (an older receiver page): a laptop on another network is refused as before', async () => {
    const { rx, dc, relaySent } = connected({ address: '203.0.113.5' });
    dc._open();
    let ended = '';
    rx.onend = r => { ended = r; };
    rx._onConn();
    await sleep(800);
    assert.equal(ended, 'network');
    assert.ok(dc.sent.includes('bye:network'));
    assert.ok(relaySent.includes('bye:network'));
});

test('validIceServers / hasTurn: only STUN/TURN urls; TURN needs string credentials; at most 8', () => {
    const v = validIceServers([
        { urls: 'stun:stun.example:3478' },
        { urls: ['turn:t.example:3478?transport=udp', 'turns:t.example:5349?transport=tcp'], username: 'u', credential: 'c' },
        { urls: 'turn:no-credentials.example' },
        { urls: 'javascript:alert(1)' },
        null, 'x',
    ]);
    assert.deepEqual(v, [
        { urls: ['stun:stun.example:3478'] },
        { urls: ['turn:t.example:3478?transport=udp', 'turns:t.example:5349?transport=tcp'], username: 'u', credential: 'c' },
    ]);
    assert.equal(hasTurn(v), true);
    assert.equal(hasTurn(ICE_SERVERS), false);
    assert.equal(validIceServers(Array.from({ length: 20 }, () => ({ urls: 'stun:a.example' }))).length, 8);
});

test('loadIceServers: STUN only without a URL, on errors and on timeout; TURN added and cached on success', async () => {
    resetIceCache();
    assert.deepEqual(await loadIceServers({ url: '' }), ICE_SERVERS);
    assert.deepEqual(await loadIceServers({ url: 'https://ice.example/ice', fetch: async () => { throw new Error('down'); } }), ICE_SERVERS);
    assert.deepEqual(await loadIceServers({ url: 'https://ice.example/ice', fetch: async () => ({ ok: false }) }), ICE_SERVERS);
    const t0 = Date.now();
    assert.deepEqual(await loadIceServers({ url: 'https://ice.example/ice', fetch: () => new Promise(() => {}), timeoutMs: 100 }), ICE_SERVERS);
    assert.ok(Date.now() - t0 < 1000, 'never waits long');
    let calls = 0;
    const ok = async () => { calls++; return { ok: true, json: async () => ({ iceServers: [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'c' }] }) }; };
    const a = await loadIceServers({ url: 'https://ice.example/ice', fetch: ok });
    assert.equal(a.length, 2);
    assert.equal(hasTurn(a), true);
    await loadIceServers({ url: 'https://ice.example/ice', fetch: ok });
    assert.equal(calls, 1, 'cached');
    resetIceCache();
});

test('guest: a connection blip while the question is on screen does not ask again or refuse', async () => {
    let asks = 0;
    let resolveOk;
    const { rx, dc, shown } = connected({ address: '203.0.113.5', approve: () => { asks++; return new Promise(r => { resolveOk = r; }); } });
    dc._open();
    rx._onConn();
    await sleep(30);
    rx.pc.connectionState = 'disconnected';
    rx._onConn();
    rx.pc.connectionState = 'connected';
    rx._onConn();
    await sleep(30);
    assert.equal(asks, 1, 'asked once');
    assert.notEqual(rx.state, 'ended');
    resolveOk(true);
    await sleep(10);
    assert.deepEqual(shown, ['stream']);
    clearTimeout(rx._graceTimer);
    rx.end('stopped');
});
