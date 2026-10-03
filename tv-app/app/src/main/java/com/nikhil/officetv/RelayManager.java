package com.nikhil.officetv;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import com.nikhil.officetv.relay.RelayClient;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Owns the single relay connection that lets laptops reach this TV by its code, without its IP address, and
 * the TV code itself: a new 4-digit code every time Office TV is opened, and never one that another TV is
 * using right now (checked through the relay once connected, then every 30 minutes).
 */
final class RelayManager {
    private RelayManager() {}

    /** How often a connected TV checks again that no other TV has picked the same code. */
    private static final long CHECK_EVERY_MS = 30 * 60 * 1000L;
    /** How long a check waits for another TV to answer. */
    private static final int CHECK_WAIT_MS = 2500;
    /** Another TV has the code: pick a new one at most this many times in a row, then wait for the next check. */
    private static final int MAX_TRIES = 5;
    /** Opened twice this quickly (the process starts, then the home screen appears): one new code is enough. */
    private static final long SAME_OPENING_MS = 10000;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService CHECKS = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "otv-code-check");
        t.setDaemon(true);
        return t;
    });

    private static Context app;
    private static RelayClient client;
    private static volatile String code, relay;
    private static volatile RelayClient.State state = RelayClient.State.STOPPED;
    private static volatile String detail;
    private static volatile Runnable listener;
    /** Check the code for another TV as soon as the relay is connected. */
    private static boolean checkDue = true;
    private static boolean checking;
    private static int tries;
    private static long renewedAt = -SAME_OPENING_MS;

    private static final Runnable periodicCheck = () -> {
        synchronized (RelayManager.class) {
            checkDue = true;
            checkIfDue();
        }
    };
    private static final Runnable checkWhenConnected = () -> {
        synchronized (RelayManager.class) {
            checkIfDue();
        }
    };

    /** Starts (or keeps) the connection for the current pairing code and relay URL. */
    static synchronized void start(Context c) {
        app = c.getApplicationContext() != null ? c.getApplicationContext() : c;
        String newCode = Prefs.pairCode(app);
        String newRelay = Prefs.relayUrl(app);
        if (client != null && newCode.equals(code) && newRelay.equals(relay)) return;
        stop();
        code = newCode;
        relay = newRelay;
        try {
            client = new RelayClient(relay, code, new Commands(app, code), Tls.socketFactory(app));
            client.start();
        } catch (RuntimeException e) {
            client = null;
            setState(RelayClient.State.OFFLINE, e.getMessage());
            CrashLog.note(app, "Relay start failed: " + e);
        }
    }

    static synchronized void stop() {
        if (client != null) client.stop();
        client = null;
        setState(RelayClient.State.STOPPED, null);
    }

    /** Call after the pairing code changed. */
    static synchronized void restart(Context c) {
        stop();
        code = null;
        start(c);
    }

    /**
     * Office TV was opened (the process started, or the launcher opened the home screen): a new code, unless one
     * was made a moment ago for the same opening. Returns true if the code changed.
     */
    static synchronized boolean opened(Context c, String how) {
        if (SystemClock.elapsedRealtime() - renewedAt < SAME_OPENING_MS) return false;
        newCode(c, how);
        return true;
    }

    /**
     * A new 4-digit code right away. Reconnects with it if the relay is running (otherwise the next start uses
     * it); the home screen and its phone QR code update through the listener.
     */
    static synchronized String newCode(Context c, String why) {
        if (app == null) app = c.getApplicationContext() != null ? c.getApplicationContext() : c;
        if (!"taken".equals(why)) tries = 0;
        String v = Prefs.newPairCode(app);
        renewedAt = SystemClock.elapsedRealtime();
        checkDue = true;
        DebugHooks.codeChanged(v, why);
        if (client != null) restart(app);
        else notifyListener();
        return v;
    }

    static void setState(RelayClient.State s, String d) {
        RelayClient.State old = state;
        state = s;
        detail = d;
        if (old != s) DebugHooks.event("relay=" + s.name() + " code=" + code);
        // Called from the client's threads while it holds its own lock: never take ours here (deadlock).
        if (s == RelayClient.State.CONNECTED) MAIN.post(checkWhenConnected);
        notifyListener();
    }

    private static void notifyListener() {
        Runnable l = listener;
        if (l != null) MAIN.post(l);
    }

    /** Asks the relay, off the main thread, whether another TV answers on this code. Caller holds the lock. */
    private static void checkIfDue() {
        final RelayClient c = client;
        if (!checkDue || checking || c == null || state != RelayClient.State.CONNECTED) return;
        checkDue = false;
        checking = true;
        final String forCode = code;
        MAIN.removeCallbacks(periodicCheck);
        try {
            CHECKS.execute(() -> {
                boolean other = false;
                try {
                    other = c.probeForOtherTv(CHECK_WAIT_MS);
                } catch (Throwable t) {
                    CrashLog.note(app, "Code check failed: " + t);
                }
                checked(c, forCode, other);
            });
        } catch (RejectedExecutionException e) {
            checking = false;
        }
    }

    private static synchronized void checked(RelayClient c, String forCode, boolean other) {
        checking = false;
        MAIN.removeCallbacks(periodicCheck);
        MAIN.postDelayed(periodicCheck, CHECK_EVERY_MS);
        if (c != client) {
            // The code or relay changed meanwhile: check the new one.
            checkIfDue();
            return;
        }
        DebugHooks.event("code-check code=" + forCode + " other=" + other + " tries=" + tries);
        if (!other) {
            tries = 0;
        } else if (tries < MAX_TRIES) {
            tries++;
            CrashLog.note(app, "Another TV uses code " + forCode + ": picking a new one.");
            newCode(app, "taken");
        }
    }

    static RelayClient.State state() {
        return state;
    }

    static String detail() {
        return detail;
    }

    /** One UI callback (run on the main thread) for state and code changes; null to remove it. */
    static void setListener(Runnable r) {
        listener = r;
    }
}
