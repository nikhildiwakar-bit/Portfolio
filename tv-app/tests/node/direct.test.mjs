// Direct video (tv/direct.js): framing, reassembly, encoder choice, and the laptop's sender with fake
// WebCodecs, a fake track processor and a fake data channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CHUNK_BYTES, DirectSender, FrameAssembler, HEADER_BYTES, PUSH_OUT, chooseConfig, directSupported, encodeSize, packFrame, toBase64,
} from '../../../tv/direct.js';
import { readControl } from '../../../tv/cast.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

test('packFrame / FrameAssembler: one or many chunks, key flag, order, incomplete frames counted', () => {
    const small = bytes(1000);
    const m1 = packFrame(7, true, small, 1234);
    assert.equal(m1.length, 1);
    assert.equal(m1[0].byteLength, HEADER_BYTES + 1000);
    const asm = new FrameAssembler();
    const f1 = asm.push(m1[0]);
    assert.equal(f1.id, 7);
    assert.equal(f1.key, true);
    assert.equal(f1.timeMs, 1234);
    assert.deepEqual([...f1.data], [...small]);
    const big = bytes(CHUNK_BYTES * 2 + 5, 9);
    const m2 = packFrame(8, false, big, 99);
    assert.equal(m2.length, 3);
    assert.equal(asm.push(m2[0]), null);
    assert.equal(asm.push(m2[1]), null);
    const f2 = asm.push(m2[2]);
    assert.equal(f2.key, false);
    assert.deepEqual([...f2.data], [...big]);
    // A frame that never completes is dropped when the next one starts.
    const m3 = packFrame(9, false, bytes(CHUNK_BYTES + 10), 1);
    asm.push(m3[0]);
    const m4 = packFrame(10, true, bytes(10), 1);
    assert.equal(asm.push(m4[0]).id, 10);
    assert.equal(asm.incomplete, 1);
    assert.equal(asm.push(new ArrayBuffer(3)), null, 'too short');
    assert.equal(asm.push('text'), null, 'not binary');
});

test('toBase64 matches Buffer for small and big frames', () => {
    for (const n of [0, 1, 2, 3, 1000, 100000]) {
        const b = bytes(n, n);
        assert.equal(toBase64(b), Buffer.from(b).toString('base64'));
    }
});

test('encodeSize: at most 1920 x 1080 (or the TV limit), aspect kept, even sides', () => {
    assert.deepEqual(encodeSize(1366, 768), { width: 1366, height: 768 });
    assert.deepEqual(encodeSize(2560, 1440), { width: 1920, height: 1080 });
    assert.deepEqual(encodeSize(2880, 1800), { width: 1728, height: 1080 });
    assert.deepEqual(encodeSize(1365, 767), { width: 1364, height: 766 });
    assert.deepEqual(encodeSize(2560, 1440, 1280, 720), { width: 1280, height: 720 });
    assert.deepEqual(encodeSize(0, 0), { width: 1920, height: 1080 });
});

test('chooseConfig: hardware in the TV\'s codec order first, then smaller software at 30 fps', async () => {
    const asked = [];
    const VE = { isConfigSupported: async c => { asked.push(c.codec + ' ' + c.hardwareAcceleration); return { supported: c.hardwareAcceleration === 'prefer-hardware' && c.codec === 'vp09.00.41.08' }; } };
    const p = await chooseConfig(VE, ['avc', 'vp9', 'vp8'], 1920, 1080, 60);
    assert.equal(p.codec, 'vp9');
    assert.equal(p.hardware, true);
    assert.equal(p.config.latencyMode, 'realtime');
    assert.equal(asked[0], 'avc1.42E02A prefer-hardware', 'H.264 tried first');
    // Linux Chrome without hardware encoding: software H.264 at 720p30.
    const sw = { isConfigSupported: async c => ({ supported: c.hardwareAcceleration === 'no-preference' && c.codec.startsWith('avc') }) };
    const q = await chooseConfig(sw, ['avc'], 1920, 1080, 60);
    assert.equal(q.hardware, false);
    assert.deepEqual([q.config.width, q.config.height, q.config.framerate], [1280, 720, 30]);
    assert.deepEqual(q.config.avc, { format: 'annexb' });
    assert.equal(await chooseConfig(sw, [], 1920, 1080, 60), null, 'nothing the TV can decode');
    assert.equal(await chooseConfig({ isConfigSupported: async () => { throw new Error('x'); } }, ['avc'], 1920, 1080, 60), null);
});

test('directSupported needs VideoEncoder, MediaStreamTrackProcessor, VideoFrame and RTCPeerConnection', () => {
    const f = function () {};
    assert.equal(directSupported({ VideoEncoder: f, MediaStreamTrackProcessor: f, VideoFrame: f, RTCPeerConnection: f }), true);
    assert.equal(directSupported({ MediaStreamTrackProcessor: f, VideoFrame: f, RTCPeerConnection: f }), false);
    assert.equal(directSupported(null), false);
});

test('readControl accepts only the control messages', () => {
    assert.deepEqual(readControl('{"type":"native","v":1,"codecs":["avc"]}'), { type: 'native', v: 1, codecs: ['avc'] });
    assert.equal(readControl('{"type":"keyframe"}').type, 'keyframe');
    assert.equal(readControl('{"type":"stats"}'), null);
    assert.equal(readControl('bye'), null);
    assert.equal(readControl('{bad'), null);
});

// ---------- the sender with fakes ----------

class FakeFrame {
    constructor(src, init) {
        this.displayWidth = src.displayWidth;
        this.displayHeight = src.displayHeight;
        this.timestamp = init && typeof init.timestamp === 'number' ? init.timestamp : src.timestamp;
        this.closed = false;
        FakeFrame.open++;
    }
    close() { if (!this.closed) { this.closed = true; FakeFrame.open--; } }
}
FakeFrame.open = 0;

function fakeWindow({ supported = true } = {}) {
    const encoders = [];
    class VideoEncoder {
        constructor({ output, error }) { this.output = output; this.error = error; this.state = 'unconfigured'; this.encodeQueueSize = 0; this.configs = []; this.encoded = []; encoders.push(this); }
        static async isConfigSupported(c) { return { supported: supported && c.hardwareAcceleration === 'prefer-hardware' && c.codec === 'avc1.42E02A' }; }
        configure(c) { this.configs.push(c); this.state = 'configured'; }
        encode(frame, opts) {
            this.encoded.push({ ts: frame.timestamp, key: !!(opts && opts.keyFrame) });
            const key = !!(opts && opts.keyFrame);
            const data = bytes(key ? 70000 : 2000);
            const chunk = { type: key ? 'key' : 'delta', timestamp: frame.timestamp, byteLength: data.length, copyTo: d => d.set(data) };
            setTimeout(() => this.output(chunk), 1);
        }
        close() { this.state = 'closed'; }
    }
    let push;
    const queue = [];
    class MediaStreamTrackProcessor {
        constructor() {
            this.readable = { getReader: () => ({
                read: () => new Promise(res => { if (queue.length) res({ value: queue.shift(), done: false }); else push = res; }),
                cancel: async () => { if (push) push({ done: true }); },
            }) };
        }
    }
    const worker = { posted: [], onmessage: null, postMessage(m) { this.posted.push(m); }, terminate() { this.terminated = true; } };
    const w = {
        VideoEncoder, MediaStreamTrackProcessor, VideoFrame: FakeFrame, RTCPeerConnection: function () {},
        Worker: function () { return worker; },
    };
    const capture = (width, height) => {
        const f = new FakeFrame({ displayWidth: width, displayHeight: height, timestamp: 0 });
        if (push) { const p = push; push = null; p({ value: f, done: false }); } else queue.push(f);
    };
    return { w, encoders, worker, capture };
}

function fakeChannel() {
    return { readyState: 'open', bufferedAmount: 0, sent: [], send(m) { this.sent.push(m); } };
}

test('DirectSender: key frame first, push-out repeats on a still screen, chunks on the channel, key frames on request', async () => {
    const { w, encoders, worker, capture } = fakeWindow();
    const dc = fakeChannel();
    const starts = [];
    const track = { getSettings: () => ({ width: 2560, height: 1440 }) };
    const d = new DirectSender({ track, dc, caps: { codecs: ['avc'], maxWidth: 1920, maxHeight: 1080, maxFps: 60 }, tickUrl: 'tick.js',
        window: w, onstart: (c, wd, h) => starts.push([c, wd, h]) });
    assert.equal(await d.start(), true);
    assert.deepEqual(starts, [['avc', 1920, 1080]]);
    assert.deepEqual(worker.posted, [17], 'ticks every frame period at 60 fps');
    const enc = encoders[0];
    assert.equal(enc.configs[0].avc.format, 'annexb');
    capture(1920, 1080);
    await sleep(10);
    assert.equal(enc.encoded.length, 1);
    assert.equal(enc.encoded[0].key, true, 'the first frame is a key frame');
    // A still screen: a few repeats push the picture out of the TV decoder, then nothing.
    for (let i = 0; i < 10; i++) { d.lastSentAt -= 100; worker.onmessage(); }
    assert.equal(enc.encoded.length, 1 + PUSH_OUT);
    assert.ok(enc.encoded.every((e, i) => i === 0 || e.ts > enc.encoded[i - 1].ts), 'timestamps always increase');
    await sleep(10);
    // A 70 KB key frame goes out in two messages; the deltas in one each.
    assert.equal(dc.sent.length, 2 + PUSH_OUT);
    const asm = new FrameAssembler();
    const frames = dc.sent.map(m => asm.push(m)).filter(Boolean);
    assert.equal(frames.length, 1 + PUSH_OUT);
    assert.equal(frames[0].key, true);
    assert.equal(frames[0].data.length, 70000);
    // The TV asks for a key frame: the next frame is one.
    d.requestKey();
    d.lastSentAt -= 100;
    worker.onmessage();
    assert.equal(enc.encoded[enc.encoded.length - 1].key, true);
    // The shared window changed size: a new encoder size and a key frame.
    capture(1280, 720);
    await sleep(10);
    assert.deepEqual(starts[starts.length - 1], ['avc', 1280, 720]);
    assert.equal(enc.encoded[enc.encoded.length - 1].key, true);
    const st = d.stats();
    assert.equal(st.codec, 'avc');
    assert.equal(st.hardware, true);
    d.stop();
    assert.equal(worker.terminated, true);
    assert.equal(FakeFrame.open, 0, 'no frame left open');
});

test('DirectSender: frames are skipped (before encoding) when the channel is behind, and busy() reports it', async () => {
    const { w, encoders, capture } = fakeWindow();
    const dc = fakeChannel();
    const d = new DirectSender({ track: { getSettings: () => ({ width: 1920, height: 1080 }) }, dc, caps: { codecs: ['avc'] }, tickUrl: 'tick.js', window: w });
    assert.equal(await d.start(), true);
    capture(1920, 1080);
    await sleep(5);
    dc.bufferedAmount = 5e6;
    for (let i = 0; i < 12; i++) { capture(1920, 1080); await sleep(1); }
    assert.equal(encoders[0].encoded.length, 1, 'nothing encoded while the channel is full');
    assert.equal(d.busy(), true);
    assert.equal(d.busy(), false, 'the window starts again');
    d.stop();
});

test('DirectSender: no encoder for this TV -> start() is false; an encoder error falls back', async () => {
    const none = fakeWindow({ supported: false });
    const d = new DirectSender({ track: { getSettings: () => ({}) }, dc: fakeChannel(), caps: { codecs: ['avc'] }, window: none.w });
    assert.equal(await d.start(), false);
    const { w, encoders } = fakeWindow();
    const fails = [];
    const e = new DirectSender({ track: { getSettings: () => ({}) }, dc: fakeChannel(), caps: { codecs: ['avc'] }, window: w, onfail: r => fails.push(r) });
    assert.equal(await e.start(), true);
    encoders[0].error(new Error('GPU lost'));
    assert.equal(fails.length, 1);
    assert.match(fails[0], /GPU lost/);
    assert.equal(e.stopped, true);
});

test('DirectSender: a slide change skipped while the channel is busy is sent once the channel drains', async () => {
    const { w, encoders, worker, capture } = fakeWindow();
    const dc = fakeChannel();
    const d = new DirectSender({ track: { getSettings: () => ({ width: 1920, height: 1080 }) }, dc, caps: { codecs: ['avc'] }, tickUrl: 'tick.js', window: w });
    assert.equal(await d.start(), true);
    capture(1920, 1080);
    await sleep(5);
    for (let i = 0; i < 5; i++) { d.lastSentAt -= 100; worker.onmessage(); } // push-out done, screen still
    const before = encoders[0].encoded.length;
    dc.bufferedAmount = 5e6;
    capture(1920, 1080); // the next slide, while the channel is full
    await sleep(5);
    worker.onmessage();
    assert.equal(encoders[0].encoded.length, before, 'skipped while full');
    dc.bufferedAmount = 0;
    worker.onmessage(); // no new capture: the screen is still
    assert.equal(encoders[0].encoded.length, before + 1, 'the new slide goes out on the next tick');
    d.stop();
});
