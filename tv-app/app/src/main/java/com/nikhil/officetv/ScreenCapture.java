package com.nikhil.officetv;

import android.annotation.TargetApi;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * "Live Screen": mirrors the TV's screen into a small JPEG that the LAN page polls.
 * Only the latest frame is kept; capture stops by itself after {@link #IDLE_MS} without viewers.
 */
final class ScreenCapture {
    static final int MAX_SIDE = 1280;
    static final int QUALITY = 60;
    static final long MIN_FRAME_MS = 200;   // at most ~5 fps
    static final long IDLE_MS = 60000;
    private static final long WAIT_MS = 120000;

    private static final Object LOCK = new Object();
    private static volatile byte[] jpeg;
    private static volatile long lastRequest;
    private static volatile long waitingSince;
    private static volatile String error;

    private static HandlerThread thread;
    private static Handler handler;
    private static Object projection;   // MediaProjection (typed Object so this class loads everywhere)
    private static VirtualDisplay display;
    private static ImageReader reader;
    private static Bitmap scratch;
    private static long lastEncode;
    private static boolean pendingGrab;

    private ScreenCapture() {
    }

    static boolean supported() {
        return Build.VERSION.SDK_INT >= 21;
    }

    static boolean running() {
        synchronized (LOCK) {
            return display != null;
        }
    }

    static boolean waiting() {
        return !running() && waitingSince > 0 && SystemClock.elapsedRealtime() - waitingSince < WAIT_MS;
    }

    /** Latest frame (or null) and marks that somebody is watching. */
    static byte[] frame() {
        lastRequest = SystemClock.elapsedRealtime();
        return running() ? jpeg : null;
    }

    static JSONObject status() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("supported", supported());
        o.put("running", running());
        o.put("waiting", waiting());
        o.put("hasFrame", running() && jpeg != null);
        if (error != null) o.put("error", error);
        return o;
    }

    /** Asks the TV for permission (the "Start now" dialog). */
    static JSONObject requestStart(Context c) throws JSONException {
        if (!supported()) return Actions.result(false, "Live Screen needs Android 5.0 or newer on the TV.");
        if (running()) {
            lastRequest = SystemClock.elapsedRealtime();
            JSONObject r = Actions.result(true, "Live Screen is already running.");
            r.put("running", true);
            return r;
        }
        try {
            Intent i = new Intent(c, ScreenCaptureActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
            c.startActivity(i);
        } catch (Throwable t) {
            CrashLog.note(c, "Live Screen start: " + t);
            error = "Could not ask the TV for screen sharing: " + t.getMessage();
            return Actions.result(false, error);
        }
        error = null;
        waitingSince = SystemClock.elapsedRealtime();
        JSONObject r = Actions.result(true, "Tap “Start now” on the TV to share its screen.");
        r.put("running", false);
        r.put("waiting", true);
        return r;
    }

    static JSONObject requestStop(Context c) throws JSONException {
        boolean was = running();
        stop(c, null);
        waitingSince = 0;
        return Actions.result(true, was ? "Live Screen stopped." : "Live Screen is not running.");
    }

    static void declined(Context c) {
        waitingSince = 0;
        error = "Screen sharing was not allowed on the TV. Press Start and choose “Start now”.";
    }

    static void failed(Context c, String why) {
        waitingSince = 0;
        error = why;
        CrashLog.note(c, "Live Screen: " + why);
    }

    /** Called by ScreenCaptureActivity with the permission result. */
    @TargetApi(21)
    static void onPermission(Context ctx, int resultCode, Intent data) {
        Context c = ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
        waitingSince = 0;
        if (Build.VERSION.SDK_INT < 21) return;
        stop(c, null);
        if (Build.VERSION.SDK_INT >= 29) {
            ControlService svc = ControlService.instance;
            String why = svc == null ? "The Office TV service is not running. Open Office TV on the TV and try again."
                    : svc.goForegroundForProjection();
            if (why != null) {
                failed(c, why);
                return;
            }
        }
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) c.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            MediaProjection mp = mpm == null ? null : mpm.getMediaProjection(resultCode, data);
            if (mp == null) {
                failed(c, "Android did not allow screen sharing on this TV.");
                return;
            }
            synchronized (LOCK) {
                thread = new HandlerThread("officetv-screen");
                thread.start();
                handler = new Handler(thread.getLooper());
                final Context app = c;
                mp.registerCallback(new MediaProjection.Callback() {
                    @Override
                    public void onStop() {
                        stop(app, null);
                    }
                }, handler);
                projection = mp;

                DisplayMetrics dm = new DisplayMetrics();
                WindowManager wm = (WindowManager) c.getSystemService(Context.WINDOW_SERVICE);
                if (wm != null) {
                    if (Build.VERSION.SDK_INT >= 17) wm.getDefaultDisplay().getRealMetrics(dm);
                    else wm.getDefaultDisplay().getMetrics(dm);
                }
                int sw = dm.widthPixels > 0 ? dm.widthPixels : 1920;
                int sh = dm.heightPixels > 0 ? dm.heightPixels : 1080;
                int[] size = scaled(sw, sh, MAX_SIDE);
                final ImageReader r = ImageReader.newInstance(size[0], size[1], PixelFormat.RGBA_8888, 2);
                r.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                    @Override
                    public void onImageAvailable(ImageReader ir) {
                        grab();
                    }
                }, handler);
                reader = r;
                int dpi = dm.densityDpi > 0 ? Math.max(1, dm.densityDpi * size[0] / sw) : 160;
                display = mp.createVirtualDisplay("officetv-live", size[0], size[1], dpi,
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.getSurface(), null, handler);
                lastRequest = SystemClock.elapsedRealtime();
                error = null;
                handler.postDelayed(IDLE_CHECK, 5000);
            }
        } catch (Throwable t) {
            stop(c, "Screen sharing failed on the TV: " + (t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName()));
            CrashLog.note(c, "Live Screen start: " + t);
        }
    }

    /** Keeps aspect; longest side at most max; even sizes. */
    static int[] scaled(int w, int h, int max) {
        int longest = Math.max(w, h);
        if (longest > max) {
            w = (int) Math.round(w * (double) max / longest);
            h = (int) Math.round(h * (double) max / longest);
        }
        w = Math.max(2, w & ~1);
        h = Math.max(2, h & ~1);
        return new int[] {w, h};
    }

    private static final Runnable IDLE_CHECK = new Runnable() {
        @Override
        public void run() {
            if (!running()) return;
            if (SystemClock.elapsedRealtime() - lastRequest > IDLE_MS) {
                stop(MainActivity.appContext, null);
                return;
            }
            Handler h = handler;
            if (h != null) h.postDelayed(this, 5000);
        }
    };

    private static final Runnable GRAB = new Runnable() {
        @Override
        public void run() {
            pendingGrab = false;
            grab();
        }
    };

    /** Runs on the capture thread. */
    @TargetApi(21)
    private static void grab() {
        ImageReader r;
        Handler h;
        synchronized (LOCK) {
            r = reader;
            h = handler;
        }
        if (r == null || h == null) return;
        long now = SystemClock.elapsedRealtime();
        long wait = MIN_FRAME_MS - (now - lastEncode);
        if (wait > 0) {
            // Leave the frame queued; take the newest one when the throttle allows.
            if (!pendingGrab) {
                pendingGrab = true;
                h.postDelayed(GRAB, wait);
            }
            return;
        }
        Image img = null;
        try {
            img = r.acquireLatestImage();
            if (img == null) return;
            lastEncode = now;
            // Nobody watching recently: skip the encoding work but keep the queue drained.
            if (now - lastRequest > 5000 && jpeg != null) return;
            jpeg = encode(img);
        } catch (Throwable t) {
            error = "Could not read the TV screen: " + t.getMessage();
        } finally {
            if (img != null) {
                try {
                    img.close();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    @TargetApi(21)
    private static byte[] encode(Image img) {
        int w = img.getWidth(), h = img.getHeight();
        Image.Plane p = img.getPlanes()[0];
        ByteBuffer buf = p.getBuffer();
        int pixelStride = p.getPixelStride();
        int rowStride = p.getRowStride();
        int padded = pixelStride > 0 ? rowStride / pixelStride : w;
        if (scratch == null || scratch.getWidth() != padded || scratch.getHeight() != h) {
            if (scratch != null) scratch.recycle();
            scratch = Bitmap.createBitmap(padded, h, Bitmap.Config.ARGB_8888);
        }
        buf.rewind();
        scratch.copyPixelsFromBuffer(buf);
        Bitmap out = padded == w ? scratch : Bitmap.createBitmap(scratch, 0, 0, w, h);
        ByteArrayOutputStream bos = new ByteArrayOutputStream(64 * 1024);
        out.compress(Bitmap.CompressFormat.JPEG, QUALITY, bos);
        if (out != scratch) out.recycle();
        return bos.toByteArray();
    }

    /** Stops everything; safe to call any time from any thread. */
    @TargetApi(21)
    static void stop(Context c, String why) {
        boolean had;
        synchronized (LOCK) {
            had = projection != null || display != null;
            try {
                if (display != null) display.release();
            } catch (Throwable ignored) {
            }
            display = null;
            try {
                if (reader != null) reader.close();
            } catch (Throwable ignored) {
            }
            reader = null;
            Object mp = projection;
            projection = null;
            try {
                if (mp != null) ((MediaProjection) mp).stop();
            } catch (Throwable ignored) {
            }
            final HandlerThread t = thread;
            final Handler h = handler;
            thread = null;
            handler = null;
            if (h != null) {
                h.removeCallbacksAndMessages(null);
                final Bitmap b = scratch;
                scratch = null;
                // Recycle on the capture thread so a running encode is never disturbed.
                h.post(new Runnable() {
                    @Override
                    public void run() {
                        if (b != null) b.recycle();
                        t.quit();
                    }
                });
            }
            pendingGrab = false;
            jpeg = null;
        }
        if (why != null) error = why;
        if (had) {
            ControlService svc = ControlService.instance;
            if (svc != null) svc.projectionEnded();
        }
    }
}
