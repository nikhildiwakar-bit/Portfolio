package com.nikhil.officetv;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.Surface;
import android.view.WindowManager;

import com.nikhil.officetv.mirror.MirrorProtocol;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.NoRouteToHostException;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.util.ArrayDeque;

/**
 * Phone side of phone mirroring: a foreground service (type mediaProjection) that captures the screen into a
 * VirtualDisplay, encodes it with the hardware H.264 encoder and streams it to the TV over one TCP connection
 * (PROTOCOL.md section 10). The screen-capture consent is used once, for one session (Android 14 rules).
 */
public class PhoneSendService extends Service {
    static final String ACTION_START = "com.nikhil.officetv.phone.START";
    static final String ACTION_STOP = "com.nikhil.officetv.phone.STOP";
    static final String EXTRA_RESULT = "result";
    static final String EXTRA_DATA = "data";
    static final String EXTRA_LINK = "link";

    private static final String CHANNEL = "phone";
    private static final int NOTIFICATION_ID = 2;
    private static final int CONNECT_TIMEOUT_MS = 4000;
    private static final int MAX_LONG_SIDE = 1920;
    private static final int BITRATE = 8_000_000;
    /** Frames waiting for the network beyond this: the link is behind, drop until a key frame. */
    private static final int MAX_SEND_QUEUE = 3;

    enum State { IDLE, CONNECTING, STREAMING, ERROR }

    // ---------- state shown by PhoneSendActivity ----------

    private static volatile State state = State.IDLE;
    private static volatile String message = "";
    private static volatile String tvName = "";
    private static volatile Runnable listener;
    private static volatile PhoneSendService instance;

    static State state() {
        return state;
    }

    static String message() {
        return message;
    }

    static String tvName() {
        return tvName;
    }

    static void setListener(Runnable l) {
        listener = l;
    }

    private static void setState(State s, String msg) {
        state = s;
        message = msg == null ? "" : msg;
        DebugHooks.event("sender=" + s + (msg == null || msg.isEmpty() ? "" : " msg=" + msg));
        Runnable l = listener;
        if (l != null) new Handler(Looper.getMainLooper()).post(l);
    }

    static void start(Context c, MirrorProtocol.Link link, int resultCode, Intent data) {
        Intent i = new Intent(c, PhoneSendService.class).setAction(ACTION_START)
                .putExtra(EXTRA_RESULT, resultCode).putExtra(EXTRA_DATA, data).putExtra(EXTRA_LINK, link.query());
        tvName = link.name;
        setState(State.CONNECTING, "Connecting to " + link.name + "…");
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    static void stop(Context c) {
        PhoneSendService s = instance;
        if (s != null) s.finish(State.IDLE, "Mirroring stopped.");
        else if (state != State.ERROR) setState(State.IDLE, "");
    }

    // ---------- the session ----------

    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread worker;
    private Handler work;
    private MediaProjection projection;
    private VirtualDisplay display;
    private Socket socket;
    private OutputStream out;
    private MirrorProtocol.Link link;
    private volatile boolean running;
    private Encoder encoder;
    private int fps;
    private final Sender sender = new Sender();
    private DisplayManager.DisplayListener displayListener;
    private MediaProjection.Callback projectionCallback;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            finish(State.IDLE, "Mirroring stopped.");
            return START_NOT_STICKY;
        }
        // Android requires startForeground() (type mediaProjection on 10+) before the projection is used.
        if (!goForeground()) {
            finish(State.ERROR, "Android did not allow screen sharing right now. Please try again.");
            return START_NOT_STICKY;
        }
        if (intent == null || !ACTION_START.equals(action) || running) {
            if (!running) stopSelf();
            return START_NOT_STICKY;
        }
        link = MirrorProtocol.Link.parse("officetvphone://connect?" + intent.getStringExtra(EXTRA_LINK));
        Intent data = intent.getParcelableExtra(EXTRA_DATA);
        int result = intent.getIntExtra(EXTRA_RESULT, 0);
        if (link == null || data == null) {
            finish(State.ERROR, "The TV details are missing. Scan the QR code on the TV again.");
            return START_NOT_STICKY;
        }
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            projection = mpm == null ? null : mpm.getMediaProjection(result, data);
        } catch (RuntimeException e) {
            projection = null;
        }
        if (projection == null) {
            finish(State.ERROR, "Screen sharing was not allowed. Tap Start mirroring to try again.");
            return START_NOT_STICKY;
        }
        // Android 14: register the callback before creating the display; stop when the user stops sharing.
        projectionCallback = new MediaProjection.Callback() {
            @Override
            public void onStop() {
                main.post(() -> finish(State.IDLE, "Mirroring stopped."));
            }
        };
        projection.registerCallback(projectionCallback, main);
        running = true;
        tvName = link.name;
        fps = weakDevice() ? 30 : 60;
        worker = new HandlerThread("otv-send-work");
        worker.start();
        work = new Handler(worker.getLooper());
        work.post(this::connectAndStart);
        return START_NOT_STICKY;
    }

    private void connectAndStart() {
        setState(State.CONNECTING, "Connecting to " + link.name + "…");
        Socket s = new Socket();
        try {
            s.setTcpNoDelay(true);
            s.setSendBufferSize(256 * 1024);
            s.connect(new InetSocketAddress(link.host, link.port), CONNECT_TIMEOUT_MS);
            s.setSoTimeout(CONNECT_TIMEOUT_MS);
            byte[] nonce = new byte[MirrorProtocol.NONCE_LEN];
            new SecureRandom().nextBytes(nonce);
            OutputStream o = s.getOutputStream();
            o.write(MirrorProtocol.clientHello(link.secret, nonce));
            o.flush();
            int r = MirrorProtocol.readReply(s.getInputStream(), link.secret, nonce);
            if (r != 0) {
                closeQuietly(s);
                String why;
                if (r == MirrorProtocol.REJECT_BUSY) {
                    why = "The TV is already showing another phone. Stop it there first, then try again.";
                } else if (r == MirrorProtocol.REJECT_AUTH) {
                    why = "This QR code is out of date (the TV code was changed). Scan the code on the TV again.";
                } else {
                    why = "This is not the TV from the QR code. Scan the code on the TV again.";
                }
                finish(State.ERROR, why);
                return;
            }
            s.setSoTimeout(15000);
            if (!running) {
                closeQuietly(s);
                return;
            }
            socket = s;
            out = s.getOutputStream();
        } catch (ConnectException | NoRouteToHostException | SocketTimeoutException e) {
            closeQuietly(s);
            if (!running) return;
            finish(State.ERROR, link.name + " was not found on this Wi-Fi. Connect the phone to the same network "
                    + "as the TV, and check that the TV is on.");
            return;
        } catch (IOException | RuntimeException e) {
            closeQuietly(s);
            if (!running) return;
            finish(State.ERROR, "Could not connect to " + link.name + ". Please try again. (" + e.getMessage() + ")");
            return;
        }
        Thread reader = new Thread(this::readLoop, "otv-send-read");
        reader.setDaemon(true);
        reader.start();
        sender.start();
        try {
            startCapture();
        } catch (Exception e) {
            if (!running) return;
            CrashLog.note(this, "Phone capture: " + e);
            finish(State.ERROR, "This phone could not start screen capture. (" + e.getMessage() + ")");
            return;
        }
        if (!running) return;
        watchRotation();
        setState(State.STREAMING, "Your screen is showing on " + link.name + ".");
    }

    /** Messages from the TV: PING, KEYREQ, BYE (with the reason as text). */
    private void readLoop() {
        try {
            DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
            while (running) {
                MirrorProtocol.Message m = MirrorProtocol.readMessage(in);
                if (m.type == MirrorProtocol.T_KEYREQ) {
                    Encoder e = encoder;
                    if (e != null) e.requestKeyFrame();
                } else if (m.type == MirrorProtocol.T_BYE) {
                    String why = MirrorProtocol.byeReason(m.payload);
                    boolean error = MirrorProtocol.byeIsError(m.payload);
                    main.post(() -> finish(error ? State.ERROR : State.IDLE,
                            why.isEmpty() ? "The TV ended mirroring." : why));
                    return;
                }
            }
        } catch (IOException e) {
            if (running) main.post(() -> finish(State.ERROR, "The connection to " + link.name + " was lost."));
        }
    }

    // ---------- capture and encoding ----------

    private void startCapture() throws IOException {
        int[] geo = screen();
        Encoder e = new Encoder(geo[0], geo[1], geo[2], geo[3]);
        encoder = e;
        display = projection.createVirtualDisplay("Office TV", e.width, e.height, geo[4],
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, e.surface, null, null);
        if (display == null) throw new IOException("no virtual display");
        e.startDrain();
    }

    /** Rotation or resolution change: new encoder, same VirtualDisplay (Android 14 allows only one). */
    private void restartEncoder() {
        if (!running || display == null) return;
        int[] geo = screen();
        Encoder old = encoder;
        if (old != null && old.srcW == geo[0] && old.srcH == geo[1] && old.rotation == geo[3]) return;
        Encoder e;
        try {
            e = new Encoder(geo[0], geo[1], geo[2], geo[3]);
        } catch (IOException ex) {
            CrashLog.note(this, "Phone encoder restart: " + ex);
            return;
        }
        if (old != null) old.retire();
        encoder = e;
        try {
            display.resize(e.width, e.height, geo[4]);
            display.setSurface(e.surface);
        } catch (RuntimeException ex) {
            CrashLog.note(this, "Phone display resize: " + ex);
        }
        e.startDrain();
        if (old != null) old.release();
    }

    private void watchRotation() {
        final DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        if (dm == null) return;
        displayListener = new DisplayManager.DisplayListener() {
            @Override
            public void onDisplayAdded(int id) {}

            @Override
            public void onDisplayRemoved(int id) {}

            @Override
            public void onDisplayChanged(int id) {
                if (id == Display.DEFAULT_DISPLAY && work != null) {
                    work.removeCallbacksAndMessages("rot");
                    work.postAtTime(PhoneSendService.this::restartEncoder, "rot", SystemClock.uptimeMillis() + 150);
                }
            }
        };
        main.post(() -> {
            try {
                dm.registerDisplayListener(displayListener, main);
            } catch (RuntimeException ignored) {
            }
        });
    }

    /** {real width, real height, (unused), rotation 0..3, densityDpi} of the phone's screen. */
    @SuppressWarnings("deprecation")
    private int[] screen() {
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        Display d = wm.getDefaultDisplay();
        DisplayMetrics dm = new DisplayMetrics();
        d.getRealMetrics(dm);
        return new int[] {dm.widthPixels, dm.heightPixels, 0, d.getRotation() & 3, dm.densityDpi};
    }

    private boolean weakDevice() {
        try {
            ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null && am.isLowRamDevice()) return true;
        } catch (RuntimeException ignored) {
        }
        return Build.VERSION.SDK_INT < 23 || Runtime.getRuntime().availableProcessors() < 4;
    }

    /** One hardware encoder (a new one after each rotation) and its output thread. */
    private final class Encoder {
        final int srcW, srcH, rotation;
        final int width, height;
        final MediaCodec codec;
        final Surface surface;
        private volatile boolean retired;
        private Thread drain;
        private boolean configSent;

        Encoder(int srcW, int srcH, int unused, int rotation) throws IOException {
            this.srcW = srcW;
            this.srcH = srcH;
            this.rotation = rotation;
            MediaCodec c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            MediaCodecInfo.VideoCapabilities caps = null;
            MediaCodecInfo.EncoderCapabilities ecaps = null;
            try {
                MediaCodecInfo.CodecCapabilities cc = c.getCodecInfo()
                        .getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC);
                caps = cc.getVideoCapabilities();
                ecaps = cc.getEncoderCapabilities();
            } catch (RuntimeException ignored) {
            }
            int[] size = pickSize(srcW, srcH, caps);
            width = size[0];
            height = size[1];
            int bitrate = Math.max(2_000_000, (int) ((long) BITRATE * width * height / (1920L * 1080L)));
            bitrate = Math.min(BITRATE, bitrate);
            Surface s = null;
            Exception last = null;
            for (int attempt = 0; attempt < 2 && s == null; attempt++) {
                try {
                    c.configure(format(bitrate, ecaps, attempt == 0), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                    s = c.createInputSurface();
                    c.start();
                } catch (Exception e) {
                    last = e;
                    s = null;
                    try {
                        c.reset();
                    } catch (RuntimeException ignored) {
                        c.release();
                        c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
                    }
                }
            }
            if (s == null) {
                c.release();
                throw new IOException("encoder: " + last);
            }
            codec = c;
            surface = s;
        }

        private MediaFormat format(int bitrate, MediaCodecInfo.EncoderCapabilities ecaps, boolean tuned) {
            MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
            f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            f.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
            f.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
            f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
            // A still screen produces no frames: repeat the last one so the TV never stalls or times out.
            f.setLong("repeat-previous-frame-after", 100_000L);
            if (!tuned) return f;
            if (ecaps != null) {
                if (ecaps.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)) {
                    f.setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR);
                } else if (ecaps.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)) {
                    f.setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR);
                }
            }
            if (Build.VERSION.SDK_INT >= 23) f.setInteger("priority", 0);
            if (Build.VERSION.SDK_INT >= 29) {
                f.setInteger("prepend-sps-pps-to-idr-frames", 1);
                f.setFloat("max-fps-to-encoder", fps);
            }
            if (Build.VERSION.SDK_INT >= 30) f.setInteger("latency", 1);
            return f;
        }

        void startDrain() {
            drain = new Thread(this::drainLoop, "otv-send-encode");
            drain.setPriority(Thread.MAX_PRIORITY);
            drain.start();
        }

        void requestKeyFrame() {
            try {
                Bundle b = new Bundle();
                b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
                codec.setParameters(b);
            } catch (RuntimeException ignored) {
            }
        }

        void retire() {
            retired = true;
        }

        void release() {
            retired = true;
            Thread t = drain;
            if (t != null) {
                try {
                    t.join(1000);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
            try {
                codec.stop();
            } catch (RuntimeException ignored) {
            }
            try {
                codec.release();
            } catch (RuntimeException ignored) {
            }
            surface.release();
        }

        private void drainLoop() {
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            byte[] buf = new byte[256 * 1024];
            try {
                while (running && !retired) {
                    int i = codec.dequeueOutputBuffer(info, 100_000);
                    if (i < 0) continue;
                    ByteBuffer b = codec.getOutputBuffer(i);
                    int len = info.size;
                    if (b != null && len > 0 && !retired) {
                        if (buf.length < len) buf = new byte[len + len / 2];
                        b.position(info.offset);
                        b.get(buf, 0, len);
                        if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                            byte[][] sp = MirrorProtocol.spsPps(buf, 0, len);
                            sender.config(new MirrorProtocol.Config(width, height, rotation, 0, sp[0], sp[1]).encode());
                            configSent = true;
                        } else if (configSent) {
                            boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                            byte[] data = new byte[len];
                            System.arraycopy(buf, 0, data, 0, len);
                            if (sender.frame(key, info.presentationTimeUs, data)) requestKeyFrame();
                        }
                    }
                    codec.releaseOutputBuffer(i, false);
                }
            } catch (IllegalStateException e) {
                if (running && !retired) {
                    CrashLog.note(PhoneSendService.this, "Phone encoder: " + e);
                    main.post(() -> finish(State.ERROR, "The phone's video encoder stopped. Please start again."));
                }
            }
        }
    }

    /** Picks an encoder size the codec supports: even sides first, then 16-aligned, then 1280 on the long side. */
    static int[] pickSize(int w, int h, MediaCodecInfo.VideoCapabilities caps) {
        int[][] tries = {
            MirrorProtocol.fitSize(w, h, MAX_LONG_SIDE, 2),
            MirrorProtocol.fitSize(w, h, MAX_LONG_SIDE, 16),
            MirrorProtocol.fitSize(w, h, 1280, 16),
            MirrorProtocol.fitSize(w, h, 960, 16),
        };
        if (caps == null) return tries[1];
        for (int[] t : tries) {
            try {
                if (caps.isSizeSupported(t[0], t[1])) return t;
            } catch (RuntimeException ignored) {
            }
        }
        return tries[2];
    }

    // ---------- network sender ----------

    /** Sends on its own thread so a slow network never blocks the encoder; drops frames when behind. */
    private final class Sender implements Runnable {
        private final ArrayDeque<Object[]> queue = new ArrayDeque<>();
        private Thread thread;
        private boolean waitKey;
        private long frames;

        void start() {
            thread = new Thread(this, "otv-send-net");
            thread.setPriority(Thread.MAX_PRIORITY);
            thread.start();
        }

        synchronized void config(byte[] payload) {
            // A new stream: frames of the old one are useless now.
            queue.clear();
            waitKey = false;
            queue.add(new Object[] {payload});
            notifyAll();
        }

        /** Queues a frame; true if the link is behind and a key frame should be requested. */
        synchronized boolean frame(boolean key, long pts, byte[] data) {
            boolean behind = false;
            if (key) {
                // Everything older than a key frame can go.
                java.util.Iterator<Object[]> it = queue.iterator();
                while (it.hasNext()) if (it.next().length > 1) it.remove();
                waitKey = false;
            } else if (waitKey) {
                return false;
            } else if (framesQueued() >= MAX_SEND_QUEUE) {
                java.util.Iterator<Object[]> it = queue.iterator();
                while (it.hasNext()) if (it.next().length > 1) it.remove();
                waitKey = true;
                behind = true;
            }
            if (!waitKey) queue.add(new Object[] {data, key, pts});
            notifyAll();
            return behind;
        }

        private int framesQueued() {
            int n = 0;
            for (Object[] o : queue) if (o.length > 1) n++;
            return n;
        }

        @Override
        public void run() {
            long lastSent = SystemClock.elapsedRealtime();
            try {
                while (running) {
                    Object[] item;
                    synchronized (this) {
                        if (queue.isEmpty()) wait(1000);
                        item = queue.poll();
                    }
                    OutputStream o = out;
                    if (o == null) continue;
                    if (item == null) {
                        if (SystemClock.elapsedRealtime() - lastSent > 1500) {
                            MirrorProtocol.writeMessage(o, MirrorProtocol.T_PING, null);
                            lastSent = SystemClock.elapsedRealtime();
                        }
                        continue;
                    }
                    if (item.length == 1) {
                        MirrorProtocol.writeMessage(o, MirrorProtocol.T_CONFIG, (byte[]) item[0]);
                    } else {
                        byte[] d = (byte[]) item[0];
                        MirrorProtocol.writeFrame(o, (Boolean) item[1], (Long) item[2], d, 0, d.length);
                        if (++frames == 1 || frames % 300 == 0) DebugHooks.event("sender=frames n=" + frames);
                    }
                    lastSent = SystemClock.elapsedRealtime();
                }
            } catch (InterruptedException ignored) {
                // finish()
            } catch (IOException e) {
                if (running) main.post(() -> finish(State.ERROR, "The connection to " + link.name + " was lost."));
            }
        }

        void stop() {
            Thread t = thread;
            if (t != null) t.interrupt();
        }
    }

    // ---------- ending ----------

    /** Ends the session (idempotent): BYE to the TV, stop capture, leave the foreground. */
    private void finish(State end, String msg) {
        boolean was = running;
        running = false;
        if (displayListener != null) {
            try {
                DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
                if (dm != null) dm.unregisterDisplayListener(displayListener);
            } catch (RuntimeException ignored) {
            }
            displayListener = null;
        }
        sender.stop();
        final Socket s = socket;
        final OutputStream o = out;
        socket = null;
        out = null;
        final Encoder e = encoder;
        encoder = null;
        final VirtualDisplay vd = display;
        display = null;
        final MediaProjection p = projection;
        projection = null;
        final HandlerThread w = worker;
        worker = null;
        work = null;
        // Network and codec teardown off the main thread.
        Thread t = new Thread(() -> {
            if (o != null) {
                try {
                    MirrorProtocol.writeMessage(o, MirrorProtocol.T_BYE, null);
                    o.flush();
                } catch (IOException ignored) {
                }
            }
            closeQuietly(s);
            if (vd != null) {
                try {
                    vd.release();
                } catch (RuntimeException ignored) {
                }
            }
            if (e != null) e.release();
            if (p != null) {
                try {
                    if (projectionCallback != null) p.unregisterCallback(projectionCallback);
                    p.stop();
                } catch (RuntimeException ignored) {
                }
            }
            if (w != null) w.quitSafely();
        }, "otv-send-stop");
        t.start();
        // Only the first reason counts (a stop during connecting must not turn into a later error).
        if (was || state == State.CONNECTING) setState(end, msg);
        main.post(() -> {
            try {
                stopForeground(true);
            } catch (RuntimeException ignored) {
            }
            stopSelf();
        });
    }

    @Override
    public void onDestroy() {
        if (running) finish(State.IDLE, "Mirroring stopped.");
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private boolean goForeground() {
        try {
            Notification n = notification();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            return true;
        } catch (RuntimeException e) {
            CrashLog.note(this, "Phone foreground service: " + e);
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    private Notification notification() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Screen mirroring",
                        NotificationManager.IMPORTANCE_LOW));
            }
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, PhoneSendActivity.class), flags);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, PhoneSendService.class).setAction(ACTION_STOP), flags);
        String name = tvName == null || tvName.isEmpty() ? "the TV" : tvName;
        b.setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle("Mirroring to " + name)
                .setContentText("Your screen is being shown on the TV.")
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(0, "Stop", stop).build());
        return b.build();
    }

    private static void closeQuietly(Socket s) {
        try {
            if (s != null) s.close();
        } catch (IOException ignored) {
        }
    }
}
