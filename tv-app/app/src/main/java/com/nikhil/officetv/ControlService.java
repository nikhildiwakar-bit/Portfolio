package com.nikhil.officetv;

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
import android.util.Log;

import java.io.IOException;

import fi.iki.elonen.NanoHTTPD;

/** Keeps the web server running in the background and the screen/Wi-Fi awake. */
public class ControlService extends Service {
    private static final String TAG = "OfficeTV";
    private static final String CHANNEL = "control";

    static volatile ControlService instance;

    private WebServer server;
    private PowerManager.WakeLock screenLock;
    private WifiManager.WifiLock wifiLock;

    static void start(Context c) {
        Intent i = new Intent(c, ControlService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    static boolean running() {
        ControlService s = instance;
        return s != null && s.server != null && s.server.isAlive();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        startForeground(1, notification());

        // Upload temp files go to the app cache.
        System.setProperty("java.io.tmpdir", getCacheDir().getAbsolutePath());
        startServer();

        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "officetv:wifi");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }
        applyKeepAwake();
    }

    private void startServer() {
        if (server != null && server.isAlive()) return;
        server = new WebServer(this);
        try {
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        } catch (IOException e) {
            Log.e(TAG, "server start failed", e);
        }
    }

    @SuppressWarnings("deprecation")
    void applyKeepAwake() {
        boolean on = Prefs.keepAwake(this);
        if (on && (screenLock == null || !screenLock.isHeld())) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            screenLock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                    | PowerManager.ACQUIRE_CAUSES_WAKEUP, "officetv:awake");
            screenLock.setReferenceCounted(false);
            screenLock.acquire();
        } else if (!on && screenLock != null && screenLock.isHeld()) {
            screenLock.release();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startServer();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (server != null) server.stop();
        if (screenLock != null && screenLock.isHeld()) screenLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification notification() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Office TV control",
                    NotificationManager.IMPORTANCE_LOW));
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), flags);
        return b.setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle("Office TV control chal raha hai")
                .setContentText("Phone se kholein: " + MainActivity.address())
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }
}
