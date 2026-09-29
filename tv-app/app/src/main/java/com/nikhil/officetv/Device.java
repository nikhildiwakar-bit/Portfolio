package com.nikhil.officetv;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.Surface;
import android.view.WindowManager;

/**
 * Which role this installation plays. The same APK is the receiver on a TV (home screen with the TV code and
 * the phone QR code, background service) and the sender on a phone (share this phone's screen to a TV).
 */
final class Device {
    private Device() {}

    /** True on a phone (touchscreen, not a TV, small screen). Debug builds default to TV so CI emulators test the TV. */
    static boolean isPhone(Context c) {
        String mode = Prefs.deviceMode(c);
        if ("phone".equals(mode)) return true;
        if ("tv".equals(mode)) return false;
        if (BuildConfig.DEBUG) return false;
        try {
            UiModeManager um = (UiModeManager) c.getSystemService(Context.UI_MODE_SERVICE);
            if (um != null && um.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) return false;
            PackageManager pm = c.getPackageManager();
            if (pm.hasSystemFeature("android.software.leanback")) return false;
            if (!pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)) return false;
            // Large touch panels (meeting-room displays) stay receivers; phones are below 600 dp.
            if (c.getResources().getConfiguration().smallestScreenWidthDp >= 600) return false;
            // A big panel running at a high density can still report less than 600 dp. Phones are portrait
            // when upright (rotation 0); panels and TVs are landscape and have no phone radio.
            return !(naturallyLandscape(c) && !pm.hasSystemFeature(PackageManager.FEATURE_TELEPHONY));
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** True if the screen is wider than tall in its natural (rotation 0) orientation. */
    @SuppressWarnings("deprecation")
    private static boolean naturallyLandscape(Context c) {
        WindowManager wm = (WindowManager) c.getSystemService(Context.WINDOW_SERVICE);
        if (wm == null) return false;
        Display d = wm.getDefaultDisplay();
        DisplayMetrics m = new DisplayMetrics();
        d.getRealMetrics(m);
        boolean wide = m.widthPixels > m.heightPixels;
        int r = d.getRotation();
        boolean turned = r == Surface.ROTATION_90 || r == Surface.ROTATION_270;
        return wide != turned;
    }
}
