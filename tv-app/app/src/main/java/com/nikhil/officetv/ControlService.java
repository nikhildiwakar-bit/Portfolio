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
import android.util.Log;

import java.io.IOException;

/** Keeps the web server running in the background and the screen/Wi-Fi awake. */
public class ControlService extends Service {
    private static final String TAG = "OfficeTV";
    private static final String CHANNEL = "control";
    private static final int NOTIFICATION_ID = 1;
    /** Ports tried in order: WebServer.PORT, then the next ones up to this many. */
    private static final int EXTRA_PORTS = 10;
    private static final int READ_TIMEOUT_MS = 20000;

    static volatile ControlService instance;

    private volatile WebServer server;
    private PowerManager.WakeLock screenLock;
    private WifiManager.WifiLock wifiLock;
    private boolean foreground;

    /** Starts (or pokes) the service. Never throws; problems end up in CrashLog. */
    static void start(Context c) {
        Context app = c.getApplicationContext() != null ? c.getApplicationContext() : c;
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
        CrashLog.note(app, "Service start nahi hui: " + first);
    }

    static boolean running() {
        ControlService s = instance;
        WebServer w = s == null ? null : s.server;
        return w != null && w.isAlive();
    }

    /** The port the LAN server actually listens on, or 0 if it is not running. */
    static int port() {
        ControlService s = instance;
        WebServer w = s == null ? null : s.server;
        if (w == null || !w.isAlive()) return 0;
        int p = w.getListeningPort();
        return p > 0 ? p : 0;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        MainActivity.appContext = getApplicationContext();
        // First, so Android 8+ sees startForeground() in time even if something below is slow.
        goForeground();
        try {
            System.setProperty("java.io.tmpdir", getCacheDir().getAbsolutePath());
        } catch (RuntimeException ignored) {
        }
        startServer();
        acquireWifiLock();
        applyKeepAwake();
        RelayManager.start(this);
        ServiceJob.schedule(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground();
        startServer();
        return START_STICKY;
    }

    /** Swiping the app away from recents must not stop the remote: ask Android to start us again. */
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

    private synchronized void startServer() {
        if (server != null && server.isAlive()) return;
        if (server != null) {
            try {
                server.stop();
            } catch (Throwable ignored) {
            }
            server = null;
        }
        Throwable last = null;
        for (int p = WebServer.PORT; p <= WebServer.PORT + EXTRA_PORTS; p++) {
            WebServer s = new WebServer(this, p);
            try {
                s.start(READ_TIMEOUT_MS, false);
                server = s;
                if (p != WebServer.PORT) CrashLog.note(this, "Port " + WebServer.PORT + " busy tha, " + p + " use kiya.");
                if (BuildConfig.DEBUG) {
                    Log.i(TAG, "OTV_TEST pin=" + Prefs.pin(this) + " port=" + p + " code=" + Prefs.pairCode(this));
                }
                return;
            } catch (IOException | RuntimeException e) {
                last = e;
                try {
                    s.stop();
                } catch (Throwable ignored) {
                }
            }
        }
        Log.e(TAG, "server start failed", last);
        CrashLog.note(this, "Web server shuru nahi hua (ports " + WebServer.PORT + "-" + (WebServer.PORT + EXTRA_PORTS)
                + "): " + last);
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
        synchronized (this) {
            try {
                if (server != null) server.stop();
            } catch (Throwable ignored) {
            }
            server = null;
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
        if (!foreground) CrashLog.note(this, "Foreground service nahi bana: " + err);
    }

    /** plain = the most basic notification possible, used if the normal one fails. */
    private Notification notification(boolean plain) {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Office TV control",
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
                .setContentTitle("Office TV chal raha hai")
                .setOngoing(true);
        if (!plain) {
            b.setContentText("Laptop ya phone se TV chalane ke liye taiyaar.");
            try {
                int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
                b.setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), flags));
            } catch (RuntimeException ignored) {
            }
        }
        return b.build();
    }
}
