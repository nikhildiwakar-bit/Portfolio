package com.nikhil.officetv;

import android.annotation.TargetApi;
import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.FrameLayout;

import com.nikhil.officetv.mirror.MirrorProtocol;

import java.nio.ByteBuffer;
import java.util.ArrayDeque;

/**
 * Low-latency video for screen sharing ("direct to the TV's video chip", PROTOCOL.md section 8): the laptop
 * encodes the screen itself (WebCodecs) and the receiver page hands each encoded frame to this class, which
 * decodes it with MediaCodec in low-latency mode straight onto a SurfaceView. This skips the WebView's own
 * video path, whose decoder runs without low-latency mode and draws every frame through the page at 4K.
 * The SurfaceView has the video's own size (setFixedSize), so the display hardware scales it to the panel.
 * Frames are queued by the page's bridge thread and decoded on one worker thread; nothing blocks the UI.
 */
final class NativeVideo implements SurfaceHolder.Callback {
    /** Things the page must know: "keyframe" (send a key frame), "error" (go back to the WebRTC picture). */
    interface Events {
        void onEvent(String name);
    }

    /** More frames than this waiting: the decoder is behind, drop to the next key frame. */
    private static final int MAX_QUEUE = 4;
    private static final int MAX_FAILURES = 3;
    /** While waiting for a key frame, ask the laptop again this often (a request can be lost or skipped). */
    private static final long ASK_KEY_MS = 500;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Context app;
    private final FrameLayout parent;
    private final SurfaceView view;
    private final Events events;
    private final ArrayDeque<byte[]> queue = new ArrayDeque<>();
    private final ArrayDeque<Long> queuedAt = new ArrayDeque<>();
    // Guarded by this.
    private String mime;
    private int width, height, generation;
    private boolean waitKey = true, running;
    private Surface surface;
    private Thread thread;
    // Statistics (guarded by this).
    private int decoded, dropped, failures;
    private int statFrames;
    private double statDecodeMs;
    private long statSince = SystemClock.elapsedRealtime();
    private String decoderName = "";
    private boolean lowLatency;
    private long lastAskAt;

    NativeVideo(Context c, FrameLayout parent, Events events) {
        this.app = c.getApplicationContext() != null ? c.getApplicationContext() : c;
        this.parent = parent;
        this.events = events;
        view = new SurfaceView(c);
        // Behind the window, like a normal video player: the WebView and the page turn see-through while it
        // plays. Amlogic decoders draw on the TV's video plane under the UI, so anything opaque on top hides it.
        view.getHolder().addCallback(this);
        view.setVisibility(View.GONE);
        parent.addView(view, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        parent.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> layout());
    }

    /** Codecs this TV can decode in hardware or software: a subset of "avc", "vp9", "vp8" (best first). */
    static String[] codecs() {
        String[][] all = {{"avc", MediaFormat.MIMETYPE_VIDEO_AVC}, {"vp9", "video/x-vnd.on2.vp9"}, {"vp8", "video/x-vnd.on2.vp8"}};
        String[] out = new String[all.length];
        int n = 0;
        for (String[] c : all) if (hasDecoder(c[1])) out[n++] = c[0];
        String[] r = new String[n];
        System.arraycopy(out, 0, r, 0, n);
        return r;
    }

    static String mimeOf(String codec) {
        if ("avc".equals(codec)) return MediaFormat.MIMETYPE_VIDEO_AVC;
        if ("vp9".equals(codec)) return "video/x-vnd.on2.vp9";
        if ("vp8".equals(codec)) return "video/x-vnd.on2.vp8";
        return null;
    }

    @SuppressWarnings("deprecation")
    private static boolean hasDecoder(String mime) {
        try {
            for (int i = 0; i < MediaCodecList.getCodecCount(); i++) {
                MediaCodecInfo info = MediaCodecList.getCodecInfoAt(i);
                if (info.isEncoder()) continue;
                for (String t : info.getSupportedTypes()) if (t.equalsIgnoreCase(mime)) return true;
            }
        } catch (RuntimeException e) {
            return false;
        }
        return false;
    }

    // ---------- called by the page's bridge (any thread) ----------

    /** A new stream: codec "avc" | "vp9" | "vp8" and its size. Shows the surface; decoding starts at a key frame. */
    boolean start(String codec, int w, int h) {
        String m = mimeOf(codec);
        if (m == null || w < 16 || h < 16 || w > 4096 || h > 4096) return false;
        synchronized (this) {
            mime = m;
            width = w;
            height = h;
            generation++;
            waitKey = true;
            failures = 0;
            queue.clear();
            queuedAt.clear();
            running = true;
            notifyAll();
        }
        // The laptop sends a key frame with every new stream, but it can arrive before this message: ask anyway.
        askKeySoon();
        ui.post(() -> {
            view.getHolder().setFixedSize(w, h);
            layout();
            view.setVisibility(View.VISIBLE);
            startThread();
        });
        DebugHooks.event("native=start " + codec + " " + w + "x" + h);
        return true;
    }

    /** One encoded frame (key frames carry their parameter sets). Never blocks. */
    void frame(byte[] data, boolean key) {
        if (data == null || data.length == 0) return;
        boolean ask = false;
        synchronized (this) {
            if (!running) return;
            if (waitKey && !key) {
                dropped++;
                ask = askDue();
            }
        }
        if (ask) {
            events.onEvent("keyframe");
            return;
        }
        synchronized (this) {
            if (!running || (waitKey && !key)) return;
            if (key) {
                queue.clear();
                queuedAt.clear();
                waitKey = false;
            } else if (queue.size() >= MAX_QUEUE) {
                // Behind: what waits is late anyway. Wait for a key frame and ask for one.
                dropped += queue.size() + 1;
                queue.clear();
                queuedAt.clear();
                waitKey = true;
                ask = askDue();
            }
            if (!waitKey) {
                queue.add(data);
                queuedAt.add(SystemClock.elapsedRealtime());
            }
            notifyAll();
        }
        if (ask) events.onEvent("keyframe");
    }

    /** True (and remembers it) when a key-frame request may go now. Caller holds the lock. */
    private boolean askDue() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastAskAt < ASK_KEY_MS) return false;
        lastAskAt = now;
        return true;
    }

    private void askKeySoon() {
        boolean ask;
        synchronized (this) {
            ask = askDue();
        }
        if (ask) events.onEvent("keyframe");
    }

    /** Back to the page's own picture: hides the surface and frees the decoder. */
    void stop() {
        synchronized (this) {
            running = false;
            generation++;
            queue.clear();
            queuedAt.clear();
            notifyAll();
        }
        ui.post(() -> view.setVisibility(View.GONE));
        stopThread();
    }

    /** {"fps","decodeMs","decoded","dropped","decoder","lowLatency","width","height"} for the laptop's info panel. */
    synchronized String stats() {
        long now = SystemClock.elapsedRealtime();
        double secs = Math.max(0.001, (now - statSince) / 1000.0);
        double fps = statFrames / secs;
        double ms = statFrames > 0 ? statDecodeMs / statFrames : 0;
        statFrames = 0;
        statDecodeMs = 0;
        statSince = now;
        return "{\"fps\":" + round1(fps) + ",\"decodeMs\":" + round1(ms) + ",\"decoded\":" + decoded + ",\"dropped\":" + dropped
                + ",\"decoder\":\"" + decoderName.replace("\"", "") + "\",\"lowLatency\":" + lowLatency
                + ",\"width\":" + width + ",\"height\":" + height + "}";
    }

    private static double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }

    // ---------- surface and layout (UI thread) ----------

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        synchronized (this) {
            surface = holder.getSurface();
            // A new surface (the cast screen came back): a new decoder, which must start at a key frame.
            waitKey = true;
            queue.clear();
            queuedAt.clear();
            notifyAll();
        }
        if (running) askKeySoon();
        startThread();
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int w, int h) {}

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        synchronized (this) {
            surface = null;
            generation++;
            notifyAll();
        }
        stopThread();
    }

    /** The largest centred rectangle with the video's aspect ratio. */
    private void layout() {
        int W = parent.getWidth(), H = parent.getHeight();
        int vw, vh;
        synchronized (this) {
            vw = width;
            vh = height;
        }
        if (W <= 0 || H <= 0 || vw <= 0 || vh <= 0) return;
        int w, h;
        if ((long) W * vh > (long) H * vw) {
            h = H;
            w = (int) ((long) H * vw / vh);
        } else {
            w = W;
            h = (int) ((long) W * vh / vw);
        }
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) view.getLayoutParams();
        if (lp.width != w || lp.height != h) {
            lp.width = w;
            lp.height = h;
            lp.gravity = Gravity.CENTER;
            view.setLayoutParams(lp);
        }
    }

    // ---------- decoding (worker thread) ----------

    private void startThread() {
        synchronized (this) {
            if (thread != null || !running || surface == null) return;
            final Surface out = surface;
            final int gen = generation;
            Thread t = new Thread(() -> loop(out, gen), "otv-native-video");
            t.setPriority(Thread.MAX_PRIORITY);
            thread = t;
            t.start();
        }
    }

    private void stopThread() {
        Thread t;
        synchronized (this) {
            t = thread;
            thread = null;
            notifyAll();
        }
        if (t != null && t != Thread.currentThread()) {
            t.interrupt();
            // Not on the UI thread for long: the loop checks the generation every 10 ms.
            try {
                t.join(500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private void loop(Surface out, int gen) {
        MediaCodec codec = null;
        String codecMime = null;
        int codecW = 0, codecH = 0;
        long pts = 0;
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        ArrayDeque<Long> inFlight = new ArrayDeque<>();
        try {
            while (true) {
                byte[] data;
                long at;
                String m;
                int w, h;
                synchronized (this) {
                    if (generation != gen && (!running || surface != out)) break;
                    if (generation != gen) {
                        gen = generation; // a new stream on the same surface: start the decoder again
                        release(codec);
                        codec = null;
                        inFlight.clear();
                    }
                    if (!running || surface != out) break;
                    data = queue.poll();
                    Long a = queuedAt.poll();
                    at = a == null ? SystemClock.elapsedRealtime() : a;
                    m = mime;
                    w = width;
                    h = height;
                    if (data == null && codec == null) {
                        wait(20);
                        continue;
                    }
                }
                if (data != null && (codec == null || !m.equals(codecMime) || w != codecW || h != codecH)) {
                    release(codec);
                    codec = null;
                    try {
                        codec = create(m, w, h, data, out);
                        codecMime = m;
                        codecW = w;
                        codecH = h;
                    } catch (Exception e) {
                        CrashLog.note(app, "Native video decoder: " + e);
                        if (failed()) return;
                        events.onEvent("keyframe");
                        continue;
                    }
                }
                try {
                    if (data != null) {
                        int idx = codec.dequeueInputBuffer(20000);
                        if (idx >= 0) {
                            ByteBuffer b = codec.getInputBuffer(idx);
                            if (b != null && b.capacity() >= data.length) {
                                b.clear();
                                b.put(data);
                                pts += 16666;
                                codec.queueInputBuffer(idx, 0, data.length, pts, 0);
                                inFlight.add(at);
                            } else {
                                codec.queueInputBuffer(idx, 0, 0, pts, 0);
                                askKey();
                            }
                        } else {
                            askKey(); // the decoder is full: this frame is lost
                        }
                    }
                    // Show everything that is ready at once: no pacing, lowest latency.
                    while (true) {
                        int o = codec.dequeueOutputBuffer(info, data == null ? 5000 : 0);
                        if (o >= 0) {
                            codec.releaseOutputBuffer(o, true);
                            Long q = inFlight.poll();
                            synchronized (this) {
                                decoded++;
                                if (decoded % 300 == 0) failures = 0; // a rate, not a lifetime budget
                                statFrames++;
                                if (q != null) statDecodeMs += SystemClock.elapsedRealtime() - q;
                            }
                            if (decoded == 1) DebugHooks.event("native=first frame " + codecW + "x" + codecH);
                        } else if (o == MediaCodec.INFO_TRY_AGAIN_LATER) {
                            break;
                        }
                    }
                } catch (IllegalStateException e) {
                    // CodecException extends IllegalStateException: a fresh decoder from the next key frame.
                    CrashLog.note(app, "Native video decode: " + e);
                    release(codec);
                    codec = null;
                    inFlight.clear();
                    if (failed()) return;
                    askKey();
                }
            }
        } catch (InterruptedException ignored) {
            // stop()
        } catch (Throwable t) {
            CrashLog.note(app, "Native video: " + t);
            events.onEvent("error");
        } finally {
            release(codec);
        }
    }

    private void askKey() {
        synchronized (this) {
            waitKey = true;
            queue.clear();
            queuedAt.clear();
        }
        events.onEvent("keyframe");
    }

    /** True (and tells the page to use its own picture again) after too many decoder failures. */
    private boolean failed() {
        int f;
        synchronized (this) {
            f = ++failures;
        }
        if (f < MAX_FAILURES) return false;
        events.onEvent("error");
        return true;
    }

    private MediaCodec create(String m, int w, int h, byte[] first, Surface out) throws Exception {
        MediaCodec c;
        try {
            c = configure(m, w, h, first, out, true);
        } catch (Exception e) {
            // Some decoders refuse the latency hints: once more without them.
            c = configure(m, w, h, first, out, false);
        }
        String name = "";
        try {
            name = c.getName();
        } catch (RuntimeException ignored) {
        }
        synchronized (this) {
            decoderName = name;
        }
        DebugHooks.event("native=decoder " + name + " lowLatency=" + lowLatency);
        return c;
    }

    private MediaCodec configure(String m, int w, int h, byte[] first, Surface out, boolean hints) throws Exception {
        MediaFormat f = MediaFormat.createVideoFormat(m, w, h);
        if (MediaFormat.MIMETYPE_VIDEO_AVC.equals(m)) {
            byte[][] sp = MirrorProtocol.spsPps(first, 0, first.length);
            if (sp[0].length > 0) f.setByteBuffer("csd-0", ByteBuffer.wrap(sp[0]));
            if (sp[1].length > 0) f.setByteBuffer("csd-1", ByteBuffer.wrap(sp[1]));
        }
        f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, Math.max(1 << 20, w * h));
        boolean ll = false;
        if (hints) {
            if (Build.VERSION.SDK_INT >= 30) {
                lowLatencyKey(f);
                ll = true;
            }
            if (Build.VERSION.SDK_INT >= 23) {
                f.setInteger("priority", 0); // realtime
                f.setInteger("operating-rate", 120);
            }
            // Vendor low-latency switches (Amlogic, Qualcomm, others); unknown keys are ignored.
            f.setInteger("vdec-lowlatency", 1);
            f.setInteger("vendor.low-latency.enable", 1);
            f.setInteger("vendor.qti-ext-dec-low-latency.enable", 1);
        }
        MediaCodec c = MediaCodec.createDecoderByType(m);
        try {
            c.configure(f, out, null, 0);
            c.start();
        } catch (Exception e) {
            c.release();
            throw e;
        }
        synchronized (this) {
            lowLatency = ll;
        }
        return c;
    }

    @TargetApi(30)
    private static void lowLatencyKey(MediaFormat f) {
        f.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
    }

    private static void release(MediaCodec c) {
        if (c == null) return;
        try {
            c.stop();
        } catch (RuntimeException ignored) {
        }
        try {
            c.release();
        } catch (RuntimeException ignored) {
        }
    }
}
