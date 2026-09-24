package com.nikhil.officetv;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Path;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.accessibility.AccessibilityEvent;

/**
 * Lets the phone press Back/Home and swipe slides. While it is enabled,
 * Android also allows this app to open other apps from the background.
 */
public class RemoteA11yService extends AccessibilityService {
    static volatile RemoteA11yService instance;

    @Override
    protected void onServiceConnected() {
        instance = this;
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

    /** Swipe between two points given as fractions of the screen size. */
    boolean swipe(float x1, float y1, float x2, float y2) {
        if (Build.VERSION.SDK_INT < 24) return false;
        DisplayMetrics dm = getResources().getDisplayMetrics();
        Path path = new Path();
        path.moveTo(x1 * dm.widthPixels, y1 * dm.heightPixels);
        path.lineTo(x2 * dm.widthPixels, y2 * dm.heightPixels);
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 250))
                .build();
        return dispatchGesture(g, null, null);
    }
}
