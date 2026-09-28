package com.nikhil.officetv;

import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import org.json.JSONException;
import org.json.JSONObject;

/** Small helpers shared by the relay commands and the screens. */
final class Actions {
    private Actions() {}

    /** {ok, msg}: the shape of every command answer (PROTOCOL.md section 5). */
    static JSONObject result(boolean ok, String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            o.put("msg", msg);
        } catch (JSONException ignored) {
        }
        return o;
    }

    /** True if the Accessibility service of the full flavor is bound (it is absent in lite). */
    static boolean accessibilityOn() {
        return RemoteA11yService.instance != null;
    }

    /** True if "Display over other apps" is allowed (always true before Android 6, where it is a normal permission). */
    static boolean overlayAllowed(Context c) {
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            return Settings.canDrawOverlays(c);
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * Android 10+ lets a background app open a screen only with a bound Accessibility service or
     * "Display over other apps". Without either, the cast screen can open only while Office TV is visible.
     */
    static boolean canOpenFromBackground(Context c) {
        if (Build.VERSION.SDK_INT < 29) return true;
        return accessibilityOn() || overlayAllowed(c);
    }

    /** Turns the screen on (for a few seconds) if the TV is in standby, so a new cast is seen. */
    static void wake(Context c) {
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            if (pm == null || pm.isInteractive()) return;
            @SuppressWarnings("deprecation")
            PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                    | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE, "officetv:wake");
            wl.acquire(5000);
        } catch (RuntimeException e) {
            CrashLog.note(c, "Wake screen: " + e);
        }
    }
}
