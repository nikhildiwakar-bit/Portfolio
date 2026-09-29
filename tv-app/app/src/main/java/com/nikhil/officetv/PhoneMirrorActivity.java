package com.nikhil.officetv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.nikhil.officetv.mirror.MirrorProtocol;

import java.nio.ByteBuffer;

/**
 * Full-screen phone mirror: decodes the phone's H.264 stream with MediaCodec straight onto a SurfaceView.
 * Tuned for latency, not smoothness: every frame is queued as soon as it arrives and rendered as soon as it is
 * decoded (no presentation-time pacing); a backlog is dropped up to the next key frame (PhoneServer.Session).
 */
public class PhoneMirrorActivity extends Activity implements SurfaceHolder.Callback {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private UiKit kit;
    private FrameLayout root;
    private SurfaceView video;
    private View overlay;
    private TextView overlayTitle, overlayText;
    private PhoneServer.Session session;
    private Surface surface;
    private Thread decoder;
    private volatile boolean decoding;
    private boolean ending, visible;
    private int videoW, videoH;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        kit = new UiKit(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        video = new SurfaceView(this);
        video.getHolder().addCallback(this);
        root.addView(video, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        overlay = buildOverlay();
        root.addView(overlay, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            if (r - l != or - ol || b - t != ob - ot) layoutVideo();
        });
        setContentView(root);
        immersive();
        attach();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // A new phone replaced the old session: start over with the new one.
        PhoneServer.Session s = PhoneServer.current();
        if (s != null && s != session) {
            stopDecoder();
            session = null;
            ending = false;
            attach();
            startDecoderIfReady();
        }
    }

    private void attach() {
        PhoneServer.Session s = PhoneServer.current();
        if (s == null || s.ended) {
            ui.post(() -> end(false));
            return;
        }
        session = s;
        showOverlay("Connecting to the phone…", "The phone screen appears in a moment.");
        final PhoneServer.Session me = s;
        s.setListeners(() -> ui.post(() -> {
            MirrorProtocol.Config c = me.config();
            if (c != null && me == session) setVideoSize(c.width, c.height);
        }), () -> ui.post(() -> {
            if (me == session) end(true);
        }));
        MirrorProtocol.Config c = s.config();
        if (c != null) setVideoSize(c.width, c.height);
        DebugHooks.event("phone=screen opened");
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        immersive();
    }

    @Override
    protected void onPause() {
        visible = false;
        super.onPause();
    }

    /** Another app took the screen (Home, input switch): mirroring cannot be seen, so end it cleanly. */
    @Override
    protected void onStop() {
        super.onStop();
        if (!isFinishing() && !ending && !isChangingConfigurations()) {
            if (session != null) session.end("Mirroring ended on the TV.", false);
            end(false);
        }
    }

    @Override
    protected void onDestroy() {
        stopDecoder();
        PhoneServer.Session s = session;
        if (s != null && !s.ended) s.end("Mirroring ended on the TV.", false);
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int k = event.getKeyCode();
        if (k == KeyEvent.KEYCODE_BACK || k == KeyEvent.KEYCODE_ESCAPE) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) {
                if (session != null) session.end("Mirroring was stopped on the TV.", false);
                end(true);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private void end(boolean goHome) {
        if (ending) return;
        ending = true;
        stopDecoder();
        DebugHooks.event("phone=screen closed");
        if (goHome && visible) {
            try {
                startActivity(new Intent(this, MainActivity.class));
            } catch (RuntimeException e) {
                CrashLog.note(this, "Back to home screen: " + e);
            }
        }
        finish();
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
    }

    // ---------- surface and layout ----------

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        surface = holder.getSurface();
        startDecoderIfReady();
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        stopDecoder();
        surface = null;
    }

    private void setVideoSize(int w, int h) {
        if (w == videoW && h == videoH) return;
        videoW = w;
        videoH = h;
        layoutVideo();
    }

    /** Letterbox / pillarbox: the largest centred rectangle with the phone's aspect ratio. */
    private void layoutVideo() {
        int W = root.getWidth(), H = root.getHeight();
        if (W <= 0 || H <= 0 || videoW <= 0 || videoH <= 0) return;
        int w, h;
        if ((long) W * videoH > (long) H * videoW) {
            h = H;
            w = (int) ((long) H * videoW / videoH);
        } else {
            w = W;
            h = (int) ((long) W * videoH / videoW);
        }
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) video.getLayoutParams();
        if (lp.width != w || lp.height != h) {
            lp.width = w;
            lp.height = h;
            lp.gravity = Gravity.CENTER;
            video.setLayoutParams(lp);
        }
    }

    // ---------- decoding ----------

    private void startDecoderIfReady() {
        if (decoder != null || surface == null || session == null || ending) return;
        final PhoneServer.Session s = session;
        final Surface out = surface;
        decoding = true;
        decoder = new Thread(() -> decodeLoop(s, out), "otv-phone-decode");
        decoder.setPriority(Thread.MAX_PRIORITY);
        decoder.start();
    }

    private void stopDecoder() {
        decoding = false;
        Thread t = decoder;
        decoder = null;
        if (t != null) {
            t.interrupt();
            try {
                t.join(1500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private void decodeLoop(PhoneServer.Session s, Surface out) {
        MediaCodec codec = null;
        MirrorProtocol.Config current = null;
        int seq = -1;
        boolean needKey = true;
        int rendered = 0, failures = 0;
        long lastLog = 0;
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        try {
            while (decoding && !s.ended) {
                MirrorProtocol.Config c = s.config();
                if (c == null) {
                    s.poll(50);
                    continue;
                }
                if (codec == null || s.configSeq() != seq) {
                    seq = s.configSeq();
                    if (codec == null || !c.sameStream(current)) {
                        release(codec);
                        codec = null;
                        try {
                            codec = createDecoder(c, out);
                        } catch (Exception e) {
                            CrashLog.note(this, "Phone decoder: " + e);
                            if (++failures >= 4) {
                                s.end("This TV could not play the phone's video.");
                                return;
                            }
                            SystemClock.sleep(300);
                            continue;
                        }
                        current = c;
                        needKey = true;
                        s.requestKeyFrame();
                    }
                }
                MirrorProtocol.Frame f = s.poll(10);
                try {
                    if (f != null && (!needKey || f.key)) {
                        int idx = codec.dequeueInputBuffer(20000);
                        if (idx >= 0) {
                            ByteBuffer b = codec.getInputBuffer(idx);
                            int len = f.dataLength();
                            if (b != null && b.capacity() >= len) {
                                b.clear();
                                b.put(f.payload, f.dataOffset(), len);
                                codec.queueInputBuffer(idx, 0, len, f.ptsUs, 0);
                                needKey = false;
                            } else {
                                codec.queueInputBuffer(idx, 0, 0, f.ptsUs, 0);
                                needKey = true;
                                s.resync();
                            }
                        } else {
                            // The decoder is full: this frame is lost, so the next ones cannot be decoded.
                            needKey = true;
                            s.resync();
                        }
                    } else if (f != null) {
                        s.requestKeyFrame();
                    }
                    // Render everything that is ready, at once: lowest latency, no pacing.
                    while (true) {
                        int o = codec.dequeueOutputBuffer(info, 0);
                        if (o >= 0) {
                            codec.releaseOutputBuffer(o, true);
                            if (rendered++ == 0) {
                                DebugHooks.event("phone=decoding first frame " + current.width + "x" + current.height);
                                ui.post(this::hideOverlay);
                            }
                        } else if (o == MediaCodec.INFO_TRY_AGAIN_LATER) {
                            break;
                        }
                        // INFO_OUTPUT_FORMAT_CHANGED / buffers changed: loop again.
                    }
                    long now = SystemClock.elapsedRealtime();
                    if (now - lastLog > 5000 && rendered > 0) {
                        lastLog = now;
                        DebugHooks.event("phone=decoding frames=" + rendered + " received=" + s.received
                                + " dropped=" + s.dropped);
                    }
                } catch (IllegalStateException e) {
                    // CodecException (API 21) extends IllegalStateException: start again with a fresh decoder.
                    CrashLog.note(this, "Phone decoder error: " + e);
                    release(codec);
                    codec = null;
                    if (++failures >= 4) {
                        s.end("This TV could not play the phone's video.");
                        return;
                    }
                }
            }
        } catch (InterruptedException ignored) {
            // stopDecoder()
        } catch (Throwable t) {
            CrashLog.note(this, "Phone decode loop: " + t);
            s.end("This TV could not play the phone's video.");
        } finally {
            release(codec);
        }
    }

    private MediaCodec createDecoder(MirrorProtocol.Config c, Surface out) throws Exception {
        try {
            return configure(c, out, true);
        } catch (Exception e) {
            // Some decoders refuse the latency hints: try once more without them.
            return configure(c, out, false);
        }
    }

    private static MediaCodec configure(MirrorProtocol.Config c, Surface out, boolean hints) throws Exception {
        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, c.width, c.height);
        if (c.pps.length > 0) {
            f.setByteBuffer("csd-0", ByteBuffer.wrap(c.sps));
            f.setByteBuffer("csd-1", ByteBuffer.wrap(c.pps));
        } else if (c.sps.length > 0) {
            f.setByteBuffer("csd-0", ByteBuffer.wrap(c.sps));
        }
        f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, Math.max(1 << 20, c.width * c.height));
        if (hints) {
            if (Build.VERSION.SDK_INT >= 30) f.setInteger("low-latency", 1);
            if (Build.VERSION.SDK_INT >= 23) {
                f.setInteger("priority", 0); // realtime
                f.setInteger("operating-rate", 120);
            }
            // Vendor low-latency switches found on TV chipsets; unknown keys are ignored.
            f.setInteger("vendor.qti-ext-dec-low-latency.enable", 1);
            f.setInteger("vendor.low-latency.enable", 1);
            f.setInteger("vdec-lowlatency", 1);
        }
        MediaCodec codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        try {
            codec.configure(f, out, null, 0);
            codec.start();
            return codec;
        } catch (Exception e) {
            codec.release();
            throw e;
        }
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

    // ---------- overlay ----------

    private View buildOverlay() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(UiKit.BG);
        box.setPadding(kit.dp(40), kit.dp(40), kit.dp(40), kit.dp(40));
        overlayTitle = kit.text("", 30, UiKit.FG, true);
        overlayTitle.setGravity(Gravity.CENTER);
        box.addView(overlayTitle);
        overlayText = kit.text("", 18, UiKit.MUTED, false);
        overlayText.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = kit.dp(10);
        box.addView(overlayText, lp);
        TextView hint = kit.text("Press Back on the remote to stop.", 15, UiKit.MUTED, false);
        hint.setGravity(Gravity.CENTER);
        hint.setAlpha(0.8f);
        LinearLayout.LayoutParams hl = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        hl.topMargin = kit.dp(22);
        box.addView(hint, hl);
        return box;
    }

    private void showOverlay(String title, String text) {
        overlayTitle.setText(title);
        overlayText.setText(text);
        overlay.setVisibility(View.VISIBLE);
    }

    private void hideOverlay() {
        overlay.setVisibility(View.GONE);
    }

    @SuppressWarnings("deprecation")
    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
}
