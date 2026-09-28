package com.nikhil.officetv;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import com.nikhil.officetv.relay.RelayClient;

/** Owns the single relay connection that lets laptops reach this TV by its code, without its IP address. */
final class RelayManager {
    private RelayManager() {}

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static RelayClient client;
    private static volatile String code, relay;
    private static volatile RelayClient.State state = RelayClient.State.STOPPED;
    private static volatile String detail;
    private static volatile Runnable listener;

    /** Starts (or keeps) the connection for the current pairing code and relay URL. */
    static synchronized void start(Context c) {
        Context app = c.getApplicationContext() != null ? c.getApplicationContext() : c;
        String newCode = Prefs.pairCode(app);
        String newRelay = Prefs.relayUrl(app);
        if (client != null && newCode.equals(code) && newRelay.equals(relay)) return;
        stop();
        code = newCode;
        relay = newRelay;
        try {
            client = new RelayClient(relay, code, new Commands(app), Tls.socketFactory(app));
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

    static void setState(RelayClient.State s, String d) {
        RelayClient.State old = state;
        state = s;
        detail = d;
        if (old != s) DebugHooks.event("relay=" + s.name() + " code=" + code);
        Runnable l = listener;
        if (l != null) MAIN.post(l);
    }

    static RelayClient.State state() {
        return state;
    }

    static String detail() {
        return detail;
    }

    /** One UI callback (run on the main thread) for state changes; null to remove it. */
    static void setListener(Runnable r) {
        listener = r;
    }
}
