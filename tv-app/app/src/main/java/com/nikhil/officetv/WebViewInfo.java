package com.nikhil.officetv;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.WebView;

/**
 * Which web engine (Android System WebView, or Chrome on Android 7-9) the cast screen will use, and
 * whether it is new enough for the WebRTC receiver page. Cheap: never loads the engine itself.
 */
final class WebViewInfo {
    /** Oldest engine major version the receiver page is known to work with (WebRTC, ES modules). */
    static final int MIN_MAJOR = 72;
    static final String UPDATE_PACKAGE = "com.google.android.webview";

    private WebViewInfo() {}

    /** Version name of the engine package, e.g. "83.0.4103.106", or null if unknown or missing. */
    static String version(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                PackageInfo p = WebView.getCurrentWebViewPackage();
                return p == null ? null : p.versionName;
            } catch (Throwable t) {
                return null;
            }
        }
        // Android 5-7.1 cannot say which package is the engine. Chrome is the engine on 7.x when installed.
        String[] pkgs = Build.VERSION.SDK_INT >= 24
                ? new String[] {"com.android.chrome", UPDATE_PACKAGE, "com.android.webview"}
                : new String[] {UPDATE_PACKAGE, "com.android.webview"};
        PackageManager pm = c.getPackageManager();
        for (String pkg : pkgs) {
            try {
                PackageInfo p = pm.getPackageInfo(pkg, 0);
                if (p != null && p.applicationInfo != null && p.applicationInfo.enabled) return p.versionName;
            } catch (PackageManager.NameNotFoundException | RuntimeException ignored) {
            }
        }
        return null;
    }

    /** True when we know for sure there is no usable engine (Android 8+ reports it directly; errors are "not sure"). */
    static boolean missing(Context c) {
        if (Build.VERSION.SDK_INT < 26) return false;
        try {
            return WebView.getCurrentWebViewPackage() == null;
        } catch (Throwable t) {
            return false;
        }
    }

    /** Leading number of a version name ("83.0.4103.106" -> 83), or -1. */
    static int major(String version) {
        if (version == null) return -1;
        int n = 0;
        int i = 0;
        while (i < version.length() && i < 6 && Character.isDigit(version.charAt(i))) {
            n = n * 10 + (version.charAt(i) - '0');
            i++;
        }
        return i == 0 ? -1 : n;
    }

    /** Major version from a WebView user agent ("... Chrome/83.0.4103.106 ..."), or -1. */
    static int majorFromUserAgent(String ua) {
        if (ua == null) return -1;
        int i = ua.indexOf("Chrome/");
        return i < 0 ? -1 : major(ua.substring(i + 7));
    }

    /** True if the version is known and older than MIN_MAJOR. Unknown versions are given the benefit of the doubt. */
    static boolean tooOld(int major) {
        return major > 0 && major < MIN_MAJOR;
    }

    /** One actionable sentence for an old or missing engine, or null if it looks fine. */
    static String problem(Context c) {
        String v = version(c);
        if (v == null) {
            return missing(c) ? "Screen sharing needs Android System WebView, which is missing or turned off on this TV. "
                    + "Install or turn on “Android System WebView” in the TV's app store or app settings." : null;
        }
        return tooOld(major(v)) ? tooOldMessage(major(v)) : null;
    }

    static String tooOldMessage(int major) {
        return "This TV's web engine is too old for screen sharing (version " + major + ", needs " + MIN_MAJOR
                + " or newer). Please update “Android System WebView” (or Google Chrome) from the TV's app store.";
    }
}
