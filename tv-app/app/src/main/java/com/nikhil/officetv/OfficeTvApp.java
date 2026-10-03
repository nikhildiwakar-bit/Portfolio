package com.nikhil.officetv;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

/**
 * App start: installs the crash log, makes a new TV code (a new one every time Office TV starts), warms up the web
 * engine and tracks whether one of our screens is visible.
 */
public class OfficeTvApp extends Application {
    /** Warm-up of the web engine: this long after the start, and the page is dropped this long after that. */
    private static final long WARM_UP_AFTER_MS = 3000;
    private static final long WARM_UP_KEEP_MS = 5000;

    private static volatile int started;

    /** True while an Office TV screen is visible (Android then lets us open the cast screen at any time). */
    static boolean inForeground() {
        return started > 0;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        CrashLog.install(this);
        try {
            RelayManager.opened(this, "start");
        } catch (RuntimeException e) {
            CrashLog.note(this, "New code at start: " + e);
        }
        final Handler main = new Handler(Looper.getMainLooper());
        main.postDelayed(() -> warmUpWebEngine(main), WARM_UP_AFTER_MS);
        registerActivityLifecycleCallbacks(new ActivityLifecycleCallbacks() {
            @Override
            public void onActivityStarted(Activity a) {
                started++;
            }

            @Override
            public void onActivityStopped(Activity a) {
                if (started > 0) started--;
            }

            @Override
            public void onActivityCreated(Activity a, Bundle b) {}

            @Override
            public void onActivityResumed(Activity a) {}

            @Override
            public void onActivityPaused(Activity a) {}

            @Override
            public void onActivitySaveInstanceState(Activity a, Bundle b) {}

            @Override
            public void onActivityDestroyed(Activity a) {}
        });
    }

    /**
     * Loads the web engine once (an empty page, then the view is destroyed), so the first screen share does not
     * wait for it. TVs only: a phone never shows the cast screen.
     */
    private void warmUpWebEngine(Handler main) {
        if (Device.isPhone(this)) return;
        final WebView w;
        try {
            w = new WebView(this);
            w.loadUrl("about:blank");
        } catch (Throwable t) {
            // No engine, or it is being updated: the cast screen explains that when it is needed.
            return;
        }
        main.postDelayed(() -> {
            try {
                w.destroy();
            } catch (Throwable ignored) {
            }
        }, WARM_UP_KEEP_MS);
    }
}
