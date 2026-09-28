package com.nikhil.officetv.relay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.PrintStream;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/**
 * Stand-in TV for browser &lt;-&gt; relay &lt;-&gt; TV end-to-end tests. Usage:
 * <pre>E2EHarness &lt;relayUrl&gt; &lt;code&gt; [--trust cert.pem]</pre>
 * stdout, one line each (UTF-8):
 * <pre>
 *   READY {"topic":..,"relay":..}     first time the stream is open
 *   STATE {"state":..,"detail":..}    every state change
 *   CMD {"cmd":..,"args":..,"t":..}   every command that reached the handler
 * </pre>
 * Answers like Office TV 3.0 (screen sharing only): ping -&gt; status object; cast start (valid session) -&gt;
 * ok; cast stop -&gt; ok; every other command -&gt; ok=false "This feature is not available on this TV app version."
 */
public final class E2EHarness {
    private static final PrintStream OUT = utf8Out();
    private static volatile String name = "E2E Test TV";
    private static volatile String casting = "";

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: E2EHarness <relayUrl> <code> [--trust cert.pem]");
            System.exit(2);
        }
        SSLSocketFactory sf = null;
        for (int i = 2; i < args.length; i++) {
            if (args[i].equals("--trust")) sf = trusting(args[++i]);
        }
        String code = Pairing.normalize(args[1]);
        if (code == null) {
            System.err.println("invalid code: " + args[1]);
            System.exit(2);
        }
        final RelayClient[] holder = new RelayClient[1];
        final boolean[] ready = {false};
        RelayClient c = new RelayClient(args[0], code, new RelayClient.Handler() {
            @Override
            public JSONObject onCommand(String cmd, JSONObject a) {
                line("CMD", new JSONObject().put("cmd", cmd).put("args", a).put("t", System.currentTimeMillis()));
                try {
                    return answer(holder[0], cmd, a);
                } catch (Exception e) {
                    return new JSONObject().put("ok", false).put("msg", "Error: " + e.getMessage());
                }
            }

            @Override
            public void onState(RelayClient.State state, String detail) {
                line("STATE", new JSONObject().put("state", state.name()).put("detail", detail == null ? JSONObject.NULL : detail));
                if (state == RelayClient.State.CONNECTED && !ready[0]) {
                    ready[0] = true;
                    line("READY", new JSONObject().put("topic", holder[0].topic()).put("relay", holder[0].relayUrl()));
                }
            }
        }, sf);
        holder[0] = c;
        Runtime.getRuntime().addShutdownHook(new Thread(c::stop));
        c.start();
        Thread.currentThread().join();
    }

    static JSONObject answer(RelayClient c, String cmd, JSONObject a) throws Exception {
        switch (cmd) {
            case "ping":
                return ok("The TV is online.").put("data", status());
            case "cast": {
                String session = a.optString("session", "");
                if ("stop".equals(a.optString("action"))) {
                    boolean was = session.equals(casting) || session.isEmpty();
                    casting = "";
                    return ok(was ? "Screen sharing stopped on the TV." : "Screen sharing was not running on the TV.");
                }
                if (!session.matches("[a-z0-9]{12,32}")) {
                    return fail("Invalid screen sharing session. Please reload the page and try again.");
                }
                casting = session;
                return ok("The TV is ready to show your screen.").put("data", status());
            }
            default:
                return fail("This feature is not available on this TV app version.");
        }
    }

    static JSONObject status() {
        return new JSONObject().put("name", name).put("model", "Dahua t982_ar301").put("android", "11")
                .put("appVersion", "3.0").put("flavor", "full").put("features", new JSONArray().put("cast"))
                .put("accessibility", true).put("needsPermission", false).put("keepAwake", true)
                .put("webview", "120.0.6099.230").put("webviewOk", true).put("casting", !casting.isEmpty());
    }

    private static JSONObject ok(String msg) {
        return new JSONObject().put("ok", true).put("msg", msg);
    }

    private static JSONObject fail(String msg) {
        return new JSONObject().put("ok", false).put("msg", msg);
    }

    private static synchronized void line(String kind, JSONObject o) {
        OUT.println(kind + " " + o);
        OUT.flush();
    }

    private static PrintStream utf8Out() {
        try {
            return new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        } catch (Exception e) {
            return System.out;
        }
    }

    /** SSLSocketFactory trusting one PEM certificate (e.g. FakeNtfy --https --cert-out). */
    static SSLSocketFactory trusting(String pemPath) throws Exception {
        Certificate cert;
        try (InputStream in = new FileInputStream(pemPath)) {
            cert = CertificateFactory.getInstance("X.509").generateCertificate(in);
        }
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        ks.setCertificateEntry("relay", cert);
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(ks);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, tmf.getTrustManagers(), null);
        return ctx.getSocketFactory();
    }
}
