package com.nikhil.officetv;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.Locale;

/**
 * Debug builds only (src/debug; release builds get the no-op version in src/release).
 *
 * <p>For the emulator smoke test (tv-app/ci/smoke.sh): logs "OTV_TEST ..." lines and serves a tiny JSON API
 * on 127.0.0.1 only (reach it with "adb forward"), protected by a random token that is printed in the log:
 * <pre>
 *   OTV_TEST port=8080 token=&lt;hex&gt; code=&lt;pairing code&gt;
 *   GET  /api/status   (header X-Token)      status object + relay state + cast state
 *   POST /api/cmd      {"cmd":..,"args":{}}  runs a command exactly like one that came through the relay
 * </pre>
 */
final class DebugHooks {
    private static final String TAG = "OfficeTV";
    private static final int FIRST_PORT = 8080;
    private static final int LAST_PORT = 8090;
    private static final int MAX_HEAD = 16 * 1024;
    private static final int MAX_BODY = 64 * 1024;

    private static ServerSocket server;
    private static String token;
    private static int port;
    private static volatile Context app;

    private DebugHooks() {}

    /** Starts the loopback API (idempotent) and logs the OTV_TEST line the smoke test waits for. */
    static synchronized void start(Context c) {
        app = c.getApplicationContext() != null ? c.getApplicationContext() : c;
        if (server != null && !server.isClosed()) return;
        if (token == null) token = randomHex(8);
        IOException last = null;
        for (int p = FIRST_PORT; p <= LAST_PORT; p++) {
            ServerSocket s = null;
            try {
                s = new ServerSocket();
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 8);
                server = s;
                port = p;
                break;
            } catch (IOException e) {
                last = e;
                closeQuietly(s);
            }
        }
        if (server == null) {
            Log.e(TAG, "OTV_TEST server failed: " + last);
            return;
        }
        final ServerSocket s = server;
        Thread t = new Thread(() -> acceptLoop(s), "otv-debug-api");
        t.setDaemon(true);
        t.start();
        Log.i(TAG, "OTV_TEST port=" + port + " token=" + token + " code=" + Prefs.pairCode(app));
        // Phone mirroring secret, so tv-app/ci/phone-smoke.sh can build the QR link (debug builds only).
        Log.i(TAG, "OTV_TEST phonekey=" + com.nikhil.officetv.mirror.MirrorProtocol.base64UrlEncode(Prefs.phoneSecret(app)));
    }

    static synchronized void stop() {
        closeQuietly(server);
        server = null;
    }

    /** One "OTV_TEST <what>" log line (relay state, cast screen, accessibility). */
    static void event(String what) {
        Log.i(TAG, "OTV_TEST " + what);
    }

    private static void acceptLoop(ServerSocket s) {
        while (!s.isClosed()) {
            final Socket c;
            try {
                c = s.accept();
            } catch (IOException e) {
                return;
            }
            Thread t = new Thread(() -> handle(c), "otv-debug-req");
            t.setDaemon(true);
            t.start();
        }
    }

    private static void handle(Socket sock) {
        try {
            sock.setSoTimeout(15000);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            String request = readLine(in);
            if (request == null) return;
            String[] parts = request.split(" ");
            String method = parts.length > 0 ? parts[0] : "";
            String path = parts.length > 1 ? parts[1] : "";
            int len = 0;
            String tok = null;
            int head = request.length();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                head += line.length();
                if (head > MAX_HEAD) break;
                int colon = line.indexOf(':');
                if (colon <= 0) continue;
                String k = line.substring(0, colon).trim().toLowerCase(Locale.US);
                String v = line.substring(colon + 1).trim();
                if (k.equals("content-length")) {
                    try {
                        len = Integer.parseInt(v);
                    } catch (NumberFormatException ignored) {
                    }
                } else if (k.equals("x-token")) {
                    tok = v;
                }
            }
            byte[] body = new byte[Math.max(0, Math.min(len, MAX_BODY))];
            int got = 0;
            while (got < body.length) {
                int n = in.read(body, got, body.length - got);
                if (n < 0) break;
                got += n;
            }
            int status;
            JSONObject out;
            if (!token.equals(tok)) {
                status = 401;
                out = Actions.result(false, "Wrong or missing X-Token.");
            } else if (method.equals("GET") && path.equals("/api/status")) {
                status = 200;
                out = status();
            } else if (method.equals("POST") && path.equals("/api/cmd")) {
                status = 200;
                JSONObject req = new JSONObject(new String(body, 0, got, "UTF-8"));
                JSONObject args = req.optJSONObject("args");
                out = new Commands(app).onCommand(req.optString("cmd", ""), args != null ? args : new JSONObject());
            } else {
                status = 404;
                out = Actions.result(false, "Not found.");
            }
            respond(sock.getOutputStream(), status, out);
        } catch (Throwable t) {
            try {
                respond(sock.getOutputStream(), 500, Actions.result(false, "Debug API error: " + t));
            } catch (Throwable ignored) {
            }
        } finally {
            closeQuietly(sock);
        }
    }

    private static JSONObject status() throws Exception {
        JSONObject s = Commands.status(app);
        s.put("code", Prefs.pairCode(app));
        s.put("relay", RelayManager.state().name());
        String d = RelayManager.detail();
        s.put("relayDetail", d == null ? "" : d);
        s.put("castSession", CastActivity.currentSession());
        s.put("canOpenFromBackground", Actions.canOpenFromBackground(app));
        s.put("inForeground", OfficeTvApp.inForeground());
        return s;
    }

    private static void respond(OutputStream os, int status, JSONObject body) throws IOException {
        byte[] b = body.toString().getBytes("UTF-8");
        String reason = status == 200 ? "OK" : status == 401 ? "Unauthorized" : status == 404 ? "Not Found" : "Error";
        String head = "HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + b.length + "\r\nConnection: close\r\n\r\n";
        os.write(head.getBytes("UTF-8"));
        os.write(b);
        os.flush();
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream(128);
        int b;
        boolean any = false;
        while ((b = in.read()) != -1) {
            any = true;
            if (b == '\n') break;
            if (b != '\r' && line.size() < MAX_HEAD) line.write(b);
        }
        return any ? line.toString("UTF-8") : null;
    }

    private static String randomHex(int bytes) {
        byte[] r = new byte[bytes];
        new SecureRandom().nextBytes(r);
        StringBuilder b = new StringBuilder(bytes * 2);
        for (byte x : r) b.append(String.format(Locale.US, "%02x", x & 0xff));
        return b.toString();
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (Throwable ignored) {
        }
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (Throwable ignored) {
        }
    }
}
