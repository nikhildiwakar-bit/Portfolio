// Office TV steady frame rate for screen sharing (PROTOCOL.md section 8). Chrome sends a still screen at
// about one frame per second, and many TV hardware decoders hold each frame until the next one arrives,
// so every change reached the TV about a second late. steadyTrack() wraps the captured video track so the
// encoder always gets at least `fps` frames per second: each new frame goes out at once, and when no new
// frame came for one frame period the last one is sent again (a new VideoFrame on the same picture, so
// nothing is copied). The period comes from a worker (tick.js), because timers on a background tab's main
// thread are throttled and the shared window usually hides the Office TV tab.
// Needs MediaStreamTrackProcessor + MediaStreamTrackGenerator (Chrome, Edge); elsewhere steadyTrack()
// returns null and the caller sends the original track.

export const STEADY_FPS = 30;

/** True when this browser can wrap a video track (MediaStreamTrackProcessor/Generator, VideoFrame, Worker). */
export function steadySupported(w = globalThis) {
    return !!w && typeof w.MediaStreamTrackProcessor === 'function' && typeof w.MediaStreamTrackGenerator === 'function'
        && typeof w.VideoFrame === 'function' && typeof w.Worker === 'function';
}

/**
 * Wraps a live video track. Returns {track, stop, stats} or null (APIs missing, or the track is not a live
 * video track). track = the generated track to send (same contentHint), stop() ends it and frees the
 * processor, the worker and the frames it holds, stats = {frames: new frames sent, repeats: frames sent
 * again}. Every frame written gets a timestamp from this page's own clock, strictly increasing.
 */
export function steadyTrack(track, { fps = STEADY_FPS, workerUrl, window: w = globalThis } = {}) {
    if (!steadySupported(w) || !track || track.kind !== 'video' || track.readyState === 'ended' || !workerUrl) return null;
    const periodMs = 1000 / Math.max(1, Math.min(60, fps));
    const clock = () => (w.performance && typeof w.performance.now === 'function' ? w.performance.now() : Date.now());
    let processor = null;
    let generator = null;
    let reader = null;
    let writer = null;
    let worker = null;
    try {
        processor = new w.MediaStreamTrackProcessor({ track });
        generator = new w.MediaStreamTrackGenerator({ kind: 'video' });
        reader = processor.readable.getReader();
        writer = generator.writable.getWriter();
        worker = new w.Worker(workerUrl);
    } catch (e) {
        if (reader) { try { reader.cancel().catch(() => {}); } catch (e2) { /* ignore */ } }
        if (generator) { try { generator.stop(); } catch (e2) { /* ignore */ } }
        return null;
    }
    if ('contentHint' in generator) {
        try { generator.contentHint = track.contentHint || ''; } catch (e) { /* optional */ }
    }
    const stats = { frames: 0, repeats: 0 };
    let last = null;        // the newest captured frame, kept open so it can be sent again
    let lastSentAt = -Infinity;
    let lastTs = -1;
    let pending = 0;
    let stopped = false;

    /** Writes a new VideoFrame on `last` (the generator takes it; closed here too once written). */
    function send(repeat) {
        if (stopped || !last || pending > 1) return;
        const now = clock();
        const ts = Math.max(lastTs + 1, Math.round(now * 1000));
        let f;
        try { f = new w.VideoFrame(last, { timestamp: ts }); } catch (e) { return; }
        lastTs = ts;
        lastSentAt = now;
        pending++;
        if (repeat) stats.repeats++;
        else stats.frames++;
        const done = () => {
            pending--;
            try { f.close(); } catch (e) { /* already closed by the generator */ }
        };
        let p;
        try { p = writer.write(f); } catch (e) { done(); return; }
        Promise.resolve(p).then(done, done);
    }

    worker.onmessage = () => {
        if (!stopped && last && clock() - lastSentAt >= periodMs - 2) send(true);
    };
    worker.postMessage(Math.round(periodMs));

    (async () => {
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (stopped) { try { value.close(); } catch (e) { /* ignore */ } break; }
                if (last) { try { last.close(); } catch (e) { /* ignore */ } }
                last = value;
                send(false);
            }
        } catch (e) { /* the source ended or the reader was cancelled */ }
        stop();
    })();

    function stop() {
        if (stopped) return;
        stopped = true;
        try { worker.postMessage(0); } catch (e) { /* ignore */ }
        try { worker.terminate(); } catch (e) { /* ignore */ }
        try { reader.cancel().catch(() => {}); } catch (e) { /* ignore */ }
        try { writer.close().catch(() => {}); } catch (e) { /* ignore */ }
        try { generator.stop(); } catch (e) { /* ignore */ }
        if (last) { try { last.close(); } catch (e) { /* ignore */ } }
        last = null;
    }

    return { track: generator, stop, stats };
}
