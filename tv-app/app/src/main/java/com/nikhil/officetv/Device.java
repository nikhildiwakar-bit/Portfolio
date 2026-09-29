package com.nikhil.officetv;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;

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
            return c.getResources().getConfiguration().smallestScreenWidthDp < 600;
        } catch (RuntimeException e) {
            return false;
        }
    }
}
