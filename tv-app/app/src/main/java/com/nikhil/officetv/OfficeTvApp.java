package com.nikhil.officetv;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;

/** App start: installs the crash log and tracks whether one of our screens is visible. */
public class OfficeTvApp extends Application {
    private static volatile int started;

    /** True while an Office TV screen is visible (Android then lets us open the cast screen at any time). */
    static boolean inForeground() {
        return started > 0;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        CrashLog.install(this);
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
}
