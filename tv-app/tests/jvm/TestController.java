package com.nikhil.officetv.relay;

import org.json.JSONObject;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;

/**
 * Plays the controller page in JVM tests: subscribes to the topic's /json stream, collects decrypted
 * t2c acks, and publishes c2t commands with plain HttpURLConnection (like the browser's simple POST).
 */
final class TestController implements Closeable {
    static final String UA = "otv-test-controller";

    final String relay;
    final RelayCrypto crypto;
    private final SSLSocketFactory sf;
    private final List<JSONObject> acks = new ArrayList<>();
    private final List<Integer> ackSizes = new ArrayList<>();
    private volatile HttpURLConnection conn;
    private volatile boolean opened;
    private volatile boolean closed;
    private volatile int subscribeStatus;
    private volatile Throwable subscribeError;

    TestController(String relay, String code, SSLSocketFactory sf) {
        this.relay = relay;
        this.crypto = new RelayCrypto(code);
        this.sf = sf;
    }

    String topic() {
        return crypto.topic();
    }

    /** Starts the subscriber and waits for ntfy's 'open' event. Throws with the HTTP status on failure. */
    void subscribe(long timeoutMs) throws IOException {
        Thread t = new Thread(this::readLoop, "test-controller");
        t.setDaemon(true);
        t.start();
        long end = System.currentTimeMillis() + timeoutMs;
        while (!opened && subscribeError == null && subscribeStatus <= 200 && System.currentTimeMillis() < end) {
            T.sleep(10);
        }
        if (opened) return;
        if (subscribeStatus == 429) throw new IOException("HTTP 429");
        if (subscribeError != null) throw new IOException("subscribe failed: " + subscribeError, subscribeError);
        throw new IOException("subscribe failed: HTTP " + subscribeStatus);
    }

    private void readLoop() {
        try {
            HttpURLConnection c = open(relay + "/" + topic() + "/json");
            c.setReadTimeout(120000);
            conn = c;
            subscribeStatus = c.getResponseCode();
            if (subscribeStatus != 200) return;
            RelayClient.LineReader in = new RelayClient.LineReader(c.getInputStream(), 1 << 20);
            String line;
            while (!closed && (line = in.readLine()) != null) {
                if (!line.isEmpty()) onLine(line);
            }
        } catch (Throwable t) {
            if (!closed) subscribeError = t;
        }
    }

    private void onLine(String line) {
        try {
            JSONObject ev = new JSONObject(line);
            String event = ev.optString("event");
            if (event.equals("open")) opened = true;
            if (!event.equals("message")) return;
            String body = ev.optString("message");
            String plain = crypto.open(body);
            if (plain == null) return;
            JSONObject m = new JSONObject(plain);
            if (!"t2c".equals(m.optString("dir"))) return;
            synchronized (acks) {
                acks.add(m);
                ackSizes.add(body.getBytes(StandardCharsets.UTF_8).length);
                acks.notifyAll();
            }
        } catch (Exception ignored) {
            // Garbage on the topic (tests inject some on purpose).
        }
    }

    boolean alive() {
        return opened && subscribeError == null && !closed;
    }

    /** Builds a c2t envelope. */
    String seal(String id, long ts, String cmd, JSONObject args) {
        JSONObject o = new JSONObject();
        o.put("v", 1);
        o.put("dir", "c2t");
        o.put("id", id);
        o.put("ts", ts);
        o.put("cmd", cmd);
        o.put("args", args == null ? new JSONObject() : args);
        return crypto.seal(o.toString());
    }

    /** Sends a fresh command and returns its id. Throws IOException("HTTP 429") when rate limited. */
    String send(String cmd, JSONObject args) throws IOException {
        String id = RelayClient.newId();
        int code = publishRaw(seal(id, System.currentTimeMillis(), cmd, args));
        if (code != 200) throw new IOException("HTTP " + code);
        return id;
    }

    /** POSTs any body to the topic like the browser does. Returns the HTTP status. */
    int publishRaw(String body) throws IOException {
        return post(relay + "/" + topic() + "?firebase=no", body.getBytes(StandardCharsets.UTF_8), null);
    }

    /** POSTs bytes and returns the parsed JSON reply (or throws with the status). */
    JSONObject upload(String url, byte[] body) throws IOException {
        StringBuilder reply = new StringBuilder();
        int code = post(url, body, reply);
        if (code != 200) throw new IOException("HTTP " + code);
        return new JSONObject(reply.toString());
    }

    private int post(String url, byte[] body, StringBuilder reply) throws IOException {
        HttpURLConnection c = open(url);
        c.setDoOutput(true);
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "text/plain;charset=UTF-8");
        c.setFixedLengthStreamingMode(body.length);
        try (OutputStream o = c.getOutputStream()) {
            o.write(body);
        }
        int code = c.getResponseCode();
        InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
        if (in != null) {
            byte[] b = FakeNtfy.readAll(in, 1 << 20);
            in.close();
            if (reply != null) reply.append(new String(b, StandardCharsets.UTF_8));
        }
        return code;
    }

    private HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        if (sf != null && c instanceof HttpsURLConnection) ((HttpsURLConnection) c).setSSLSocketFactory(sf);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept-Encoding", "identity");
        return c;
    }

    /** Acks for command id re received so far. */
    List<JSONObject> acksFor(String re) {
        List<JSONObject> out = new ArrayList<>();
        synchronized (acks) {
            for (JSONObject a : acks) if (re.equals(a.optString("re"))) out.add(a);
        }
        return out;
    }

    /** Waits for the first ack of a command, or null. */
    JSONObject awaitAck(String re, long timeoutMs) {
        List<JSONObject> l = awaitAcks(re, 1, timeoutMs);
        return l.isEmpty() ? null : l.get(0);
    }

    /** Waits until all parts of a (possibly split) ack arrived; returns them sorted by part. */
    List<JSONObject> awaitParts(String re, long timeoutMs) {
        long end = System.currentTimeMillis() + timeoutMs;
        while (true) {
            List<JSONObject> l = acksFor(re);
            if (!l.isEmpty() && l.size() >= l.get(0).optInt("parts", 1)) {
                l.sort((a, b) -> Integer.compare(a.optInt("part"), b.optInt("part")));
                return l;
            }
            if (System.currentTimeMillis() >= end) return l;
            waitAcks(end);
        }
    }

    List<JSONObject> awaitAcks(String re, int n, long timeoutMs) {
        long end = System.currentTimeMillis() + timeoutMs;
        while (true) {
            List<JSONObject> l = acksFor(re);
            if (l.size() >= n || System.currentTimeMillis() >= end) return l;
            waitAcks(end);
        }
    }

    private void waitAcks(long end) {
        synchronized (acks) {
            long left = end - System.currentTimeMillis();
            if (left <= 0) return;
            try {
                acks.wait(Math.min(left, 50));
            } catch (InterruptedException ignored) {
            }
        }
    }

    /** Envelope sizes (bytes) of every ack seen. */
    List<Integer> ackSizes() {
        synchronized (acks) {
            return new ArrayList<>(ackSizes);
        }
    }

    @Override
    public void close() {
        closed = true;
        HttpURLConnection c = conn;
        if (c != null) {
            Thread t = new Thread(c::disconnect, "test-controller-close");
            t.setDaemon(true);
            t.start();
        }
    }
}
