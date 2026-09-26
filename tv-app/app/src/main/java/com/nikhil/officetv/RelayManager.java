package com.nikhil.officetv;

import android.content.Context;

import com.nikhil.officetv.relay.RelayClient;

/** Owns the single relay connection that lets laptops control this TV without its IP address. */
final class RelayManager {
    private RelayManager() {}

    private static RelayClient client;
    private static String code, relay;
    private static volatile RelayClient.State state = RelayClient.State.STOPPED;
    private static volatile String detail;

    /** Starts (or keeps) the connection for the current pairing code and relay URL. */
    static synchronized void start(Context c) {
        Context app = c.getApplicationContext();
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
        state = RelayClient.State.STOPPED;
    }

    /** Call after the pairing code or relay URL changed. */
    static synchronized void restart(Context c) {
        stop();
        code = null;
        start(c);
    }

    static synchronized RelayClient client() {
        return client;
    }

    static void setState(RelayClient.State s, String d) {
        state = s;
        detail = d;
    }

    static RelayClient.State state() {
        return state;
    }

    static String detail() {
        return detail;
    }
}
