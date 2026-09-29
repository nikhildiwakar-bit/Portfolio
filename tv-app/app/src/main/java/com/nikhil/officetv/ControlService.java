package com.nikhil.officetv;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

/**
 * Keeps Office TV ready for screen sharing in the background: a foreground service that holds the relay
 * connection, a Wi-Fi lock (so the connection survives Wi-Fi power saving) and, if "Keep screen on" is
 * enabled, a screen wake lock.
 */
public class ControlService extends Service {
    private static final String CHANNEL = "control";
    private static final int NOTIFICATION_ID = 1;

    static volatile ControlService instance;

    private PowerManager.WakeLock screenLock;
    private WifiManager.WifiLock wifiLock;
    private boolean foreground;

    /** Starts (or pokes) the service. Never throws; problems end up in CrashLog. */
    static void start(Context c) {
        Context app = c.getApplicationContext() != null ? c.getApplicationContext() : c;
        // On a phone the app only sends its screen (PhoneSendService); no receiver runs in the background.
        if (Device.isPhone(app)) return;
        Intent i = new Intent(app, ControlService.class);
        RuntimeException first;
        try {
            if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(i);
            else app.startService(i);
            return;
        } catch (RuntimeException e) {
            // Android 8+ refuses background starts; Android 12+ also refuses foreground-service starts.
            first = e;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                app.startService(i);
                return;
            } catch (RuntimeException ignored) {
                // Reported below.
            }
        }
        CrashLog.note(app, "Service failed to start: " + first);
    }

    static boolean running() {
        return instance != null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        // First, so Android 8+ sees startForeground() in time even if something below is slow.
        goForeground();
        acquireWifiLock();
        applyKeepAwake();
        RelayManager.start(this);
        PhoneServer.start(this);
        DebugHooks.start(this);
        ServiceJob.schedule(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground();
        RelayManager.start(this);
        PhoneServer.start(this);
        DebugHooks.start(this);
        return START_STICKY;
    }

    /** Swiping the app away from recents must not stop sharing: ask Android to start us again. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        try {
            Intent i = new Intent(getApplicationContext(), ControlService.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT
                    | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent pi = Build.VERSION.SDK_INT >= 26
                    ? PendingIntent.getForegroundService(this, 1, i, flags)
                    : PendingIntent.getService(this, 1, i, flags);
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + 2000, pi);
        } catch (Throwable t) {
            CrashLog.note(this, "Restart alarm: " + t);
        }
        ServiceJob.schedule(this);
        super.onTaskRemoved(rootIntent);
    }

    private void acquireWifiLock() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return;
            @SuppressWarnings("deprecation")
            WifiManager.WifiLock l = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "officetv:wifi");
            l.setReferenceCounted(false);
            l.acquire();
            wifiLock = l;
        } catch (Throwable t) {
            // TVs on Ethernet may have no Wi-Fi at all.
            CrashLog.note(this, "Wi-Fi lock: " + t);
        }
    }

    @SuppressWarnings("deprecation")
    synchronized void applyKeepAwake() {
        try {
            boolean on = Prefs.keepAwake(this);
            if (on && (screenLock == null || !screenLock.isHeld())) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                screenLock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP, "officetv:awake");
                screenLock.setReferenceCounted(false);
                screenLock.acquire();
            } else if (!on && screenLock != null && screenLock.isHeld()) {
                screenLock.release();
            }
        } catch (Throwable t) {
            CrashLog.note(this, "Screen-on lock: " + t);
        }
    }

    @Override
    public void onDestroy() {
        RelayManager.stop();
        PhoneServer.stop();
        DebugHooks.stop();
        synchronized (this) {
            try {
                if (screenLock != null && screenLock.isHeld()) screenLock.release();
            } catch (Throwable ignored) {
            }
        }
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Throwable ignored) {
        }
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** startForeground can throw (Android 12+ background start, broken notification setup); keep running anyway. */
    private void goForeground() {
        if (foreground) return;
        Throwable err = null;
        for (int attempt = 0; attempt < 2 && !foreground; attempt++) {
            try {
                startForeground(NOTIFICATION_ID, notification(attempt == 1));
                foreground = true;
            } catch (Throwable t) {
                err = t;
            }
        }
        if (!foreground) CrashLog.note(this, "Foreground service failed: " + err);
    }

    /** plain = the most basic notification possible, used if the normal one fails. */
    @SuppressWarnings("deprecation")
    private Notification notification(boolean plain) {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Office TV",
                            NotificationManager.IMPORTANCE_LOW));
                }
            } catch (RuntimeException e) {
                CrashLog.note(this, "Notification channel: " + e);
            }
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        b.setSmallIcon(plain ? android.R.drawable.stat_notify_sync : R.drawable.ic_launcher)
                .setContentTitle("Office TV is ready")
                .setOngoing(true);
        if (!plain) {
            b.setContentText("Laptops and phones can share their screen to this TV.");
            try {
                int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
                b.setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), flags));
            } catch (RuntimeException ignored) {
            }
        }
        return b.build();
    }
}
