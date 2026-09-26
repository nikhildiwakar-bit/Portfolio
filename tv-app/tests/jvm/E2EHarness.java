package com.nikhil.officetv.relay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.PrintStream;
import java.security.KeyStore;
import java.security.MessageDigest;
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
 * Answers: ping/rename -&gt; status object, apps -&gt; 120 fake apps, file -&gt; fetchFile then
 * msg "&lt;name&gt; TV par khul gaya. (&lt;bytes&gt; bytes, sha256 &lt;hex&gt;)", everything else ok=true.
 */
public final class E2EHarness {
    private static final PrintStream OUT = utf8Out();
    private static volatile String name = "E2E Test TV";

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
                return ok("TV online hai.").put("data", status());
            case "rename": {
                String n = a.optString("name", "").trim();
                if (n.isEmpty() || n.length() > 40) return fail("Naam 1 se 40 akshar ka rakhein.");
                name = n;
                return ok("Naam badal gaya.").put("data", status());
            }
            case "apps": {
                JSONArray apps = new JSONArray();
                for (int i = 1; i <= 120; i++) {
                    apps.put(new JSONObject().put("label", String.format("Office App %03d (Sample label)", i))
                            .put("pkg", "com.example.office.app" + i));
                }
                return ok(apps.length() + " apps mili.").put("data", new JSONObject().put("apps", apps));
            }
            case "file": {
                byte[] b = c.fetchFile(a);
                String sha = T.hex(MessageDigest.getInstance("SHA-256").digest(b));
                return ok(a.optString("name", "File") + " TV par khul gaya. (" + b.length + " bytes, sha256 " + sha + ")");
            }
            case "open":
                return a.optString("url", "").trim().isEmpty() ? fail("Link khaali hai.") : ok("Link TV par khul gaya.");
            case "youtube":
                return ok("Link TV par khul gaya.");
            case "key":
                return ok("Done");
            case "volume":
                return ok("Volume " + a.optInt("percent", 30) + "%");
            case "awake":
                return ok(a.optBoolean("on", true) ? "Screen hamesha on rahegi." : "Screen normal time par band hogi.");
            case "app":
                return ok("App TV par khul gaya.");
            default:
                return fail("Unknown: " + cmd);
        }
    }

    static JSONObject status() {
        return new JSONObject().put("name", name).put("model", "Dahua LPH65-ST420").put("android", "11")
                .put("appVersion", "1.2").put("flavor", "full").put("accessibility", true).put("needsPermission", false)
                .put("keepAwake", true).put("volume", 6).put("maxVolume", 15)
                .put("lanUrls", new JSONArray().put("http://192.168.1.50:8080"));
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
