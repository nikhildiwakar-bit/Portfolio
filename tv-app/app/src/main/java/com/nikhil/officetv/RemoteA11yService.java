package com.nikhil.officetv;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.annotation.TargetApi;
import android.content.Context;
import android.content.Intent;
import android.graphics.Path;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;

/**
 * Lets the phone press Back/Home and swipe slides. While it is enabled,
 * Android also allows this app to open other apps from the background.
 * (Not included in the "lite" APK.)
 */
public class RemoteA11yService extends AccessibilityService {
    static volatile RemoteA11yService instance;

    @Override
    protected void onServiceConnected() {
        instance = this;
        // Android binds this service at boot, sometimes before BOOT_COMPLETED: a good moment to start the server.
        ControlService.start(this);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    /** performGlobalAction that never throws. */
    boolean global(int action) {
        try {
            return performGlobalAction(action);
        } catch (RuntimeException e) {
            CrashLog.note(this, "Global action " + action + ": " + e);
            return false;
        }
    }

    /** Swipe between two points given as fractions of the screen size (Android 7+). */
    boolean swipe(float x1, float y1, float x2, float y2) {
        if (Build.VERSION.SDK_INT < 24) return false;
        try {
            return Gestures.swipe(this, screen(), x1, y1, x2, y2);
        } catch (RuntimeException e) {
            CrashLog.note(this, "Swipe: " + e);
            return false;
        }
    }

    /** D-pad press via Accessibility (Android 13+ only). dir: "up", "down", "left", "right" or "center". */
    boolean dpad(String dir) {
        if (Build.VERSION.SDK_INT < 33) return false;
        int action;
        switch (dir) {
            case "up": action = AccessibilityService.GLOBAL_ACTION_DPAD_UP; break;
            case "down": action = AccessibilityService.GLOBAL_ACTION_DPAD_DOWN; break;
            case "left": action = AccessibilityService.GLOBAL_ACTION_DPAD_LEFT; break;
            case "right": action = AccessibilityService.GLOBAL_ACTION_DPAD_RIGHT; break;
            case "center": action = AccessibilityService.GLOBAL_ACTION_DPAD_CENTER; break;
            default: return false;
        }
        return global(action);
    }

    /** Full screen size including system bars. */
    private DisplayMetrics screen() {
        DisplayMetrics dm = new DisplayMetrics();
        try {
            WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            Display d = wm == null ? null : wm.getDefaultDisplay();
            if (d != null) d.getRealMetrics(dm);
        } catch (RuntimeException ignored) {
        }
        if (dm.widthPixels <= 0 || dm.heightPixels <= 0) dm = getResources().getDisplayMetrics();
        return dm;
    }

    @TargetApi(24)
    private static final class Gestures {
        static boolean swipe(AccessibilityService s, DisplayMetrics dm, float x1, float y1, float x2, float y2) {
            int w = Math.max(1, dm.widthPixels - 1), h = Math.max(1, dm.heightPixels - 1);
            Path path = new Path();
            path.moveTo(x1 * w, y1 * h);
            path.lineTo(x2 * w, y2 * h);
            GestureDescription g = new GestureDescription.Builder()
                    .addStroke(new GestureDescription.StrokeDescription(path, 0, 250))
                    .build();
            return s.dispatchGesture(g, null, null);
        }
    }
}
