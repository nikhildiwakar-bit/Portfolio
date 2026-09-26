package com.nikhil.officetv.relay;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.MalformedURLException;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocketFactory;

/**
 * TV side of the relay protocol (PROTOCOL.md sections 4-6): subscribes to the ntfy topic, runs fresh c2t
 * commands through the {@link Handler} and posts encrypted acks. Pure Java, safe on Android API 21.
 */
public final class RelayClient {
    public enum State { STOPPED, CONNECTING, CONNECTED, OFFLINE, RATE_LIMITED }

    public interface Handler {
        /** Runs one decrypted, fresh, de-duplicated c2t command. Never throws; returns {"ok":bool,"msg":String,"data":JSONObject?}. */
        JSONObject onCommand(String cmd, JSONObject args);

        /** Connection state changes, for the TV UI. detail may be null. Called from background threads. */
        void onState(State state, String detail);
    }

    /** Every envelope must be strictly shorter than this (ntfy turns bigger bodies into attachments). */
    public static final int MAX_ENVELOPE = 3900;
    public static final long FRESH_WINDOW_MS = 300000L;
    public static final int MAX_FILE_BYTES = 16 * 1024 * 1024;

    private static final long[] BACKOFF_S = {1, 2, 4, 8, 16, 30, 60};
    private static final int SEEN_MAX = 256;
    private static final int MAX_LINE = 64 * 1024;
    private static final int PLACEHOLDER_PART = 99999;
    private static final String UA = "OfficeTV-relay/1";
    private static final String ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
    private static final SecureRandom RNG = new SecureRandom();

    // Timings; package-private so JVM tests can shorten them.
    volatile long backoffUnitMs = 1000;
    volatile long rateLimitMinMs = 60000;
    volatile long stableStreamMs = 15000;
    volatile int connectTimeoutMs = 15000;
    volatile int readTimeoutMs = 90000;
    volatile int fileReadTimeoutMs = 60000;

    private final String relay;
    private final URL relayUrl;
    private final RelayCrypto crypto;
    private final Handler handler;
    private final SSLSocketFactory ssl;

    private final Object lock = new Object();
    private volatile boolean running;
    private volatile int generation;
    private Thread reader;
    private Thread lastReader;
    private ExecutorService exec;
    private HttpURLConnection streamConn;
    private TrackingFactory streamSockets;

    private final Object stateLock = new Object();
    private volatile State state = State.STOPPED;
    private String stateDetail;
    private volatile boolean streamOpen;

    private volatile String lastId;
    private volatile long lastServerTime;
    private volatile long serverOffsetMs;
    private volatile boolean serverClockKnown;
    private int rateFailures;
    private final Map<String, Boolean> seen = new LinkedHashMap<String, Boolean>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Boolean> e) {
            return size() > SEEN_MAX;
        }
    };

    /** Commands accepted by the reader (fresh, new, valid). For tests. */
    final AtomicInteger accepted = new AtomicInteger();
    /** Stream connections attempted. For tests. */
    final AtomicInteger connects = new AtomicInteger();

    /**
     * @param relayUrl relay base URL, e.g. https://ntfy.sh (null, empty or malformed -> default relay)
     * @param code     normalized pairing code
     */
    public RelayClient(String relayUrl, String code, Handler handler, SSLSocketFactory sslOrNull) {
        if (handler == null) throw new IllegalArgumentException("handler");
        String base = normalizeRelay(relayUrl);
        URL u;
        try {
            u = new URL(base);
        } catch (MalformedURLException e) {
            base = Pairing.DEFAULT_RELAY;
            try {
                u = new URL(base);
            } catch (MalformedURLException impossible) {
                throw new IllegalStateException(impossible);
            }
        }
        this.relay = base;
        this.relayUrl = u;
        this.crypto = new RelayCrypto(code);
        this.handler = handler;
        this.ssl = sslOrNull;
    }

    static String normalizeRelay(String r) {
        if (r == null || r.trim().isEmpty()) return Pairing.DEFAULT_RELAY;
        r = Pairing.stripSlashes(r.trim());
        if (!r.matches("(?i)^https?://.+")) r = "https://" + r;
        return r;
    }

    public String topic() {
        return crypto.topic();
    }

    /** The relay base URL in use (no trailing slash). */
    public String relayUrl() {
        return relay;
    }

    public State state() {
        return state;
    }

    // ---------------------------------------------------------------- lifecycle

    /** Starts the background reader. Safe to call repeatedly. */
    public void start() {
        synchronized (lock) {
            if (running) return;
            running = true;
            final int g = ++generation;
            exec = Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "otv-relay-cmd-" + g);
                t.setDaemon(true);
                return t;
            });
            reader = new Thread(() -> readLoop(g), "otv-relay-read-" + g);
            reader.setDaemon(true);
            reader.start();
            lastReader = reader;
        }
    }

    /** Stops reading and drops queued commands. Returns at once; the stream is closed on a helper thread. */
    public void stop() {
        HttpURLConnection conn;
        TrackingFactory socks;
        ExecutorService ex;
        int g;
        synchronized (lock) {
            if (!running) return;
            running = false;
            g = ++generation;
            conn = streamConn;
            socks = streamSockets;
            streamConn = null;
            streamSockets = null;
            ex = exec;
            exec = null;
            reader = null;
            lock.notifyAll();
        }
        if (ex != null) ex.shutdownNow();
        closeAsync(conn, socks);
        streamOpen = false;
        setState(g, State.STOPPED, null);
    }

    /** For tests: the most recently started reader thread (kept after stop). */
    Thread readerThread() {
        synchronized (lock) {
            return lastReader;
        }
    }

    private boolean alive(int g) {
        return running && generation == g;
    }

    private void sleep(int g, long ms) {
        long end = System.currentTimeMillis() + ms;
        synchronized (lock) {
            while (alive(g)) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) return;
                try {
                    lock.wait(left);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }
    }

    private void setState(int g, State s, String detail) {
        synchronized (stateLock) {
            if (g != generation) return;
            if (s == state && (detail == null ? stateDetail == null : detail.equals(stateDetail))) return;
            state = s;
            stateDetail = detail;
            try {
                handler.onState(s, detail);
            } catch (Throwable ignored) {
                // UI callbacks must never break the client.
            }
        }
    }

    // ---------------------------------------------------------------- reader

    private void readLoop(int g) {
        int failures = 0;
        while (alive(g)) {
            long[] opened = {0};
            boolean limited = false;
            String why;
            try {
                setState(g, State.CONNECTING, relayUrl.getHost());
                stream(g, opened);
                why = "Relay ne connection band kar diya.";
            } catch (RateLimitedException e) {
                limited = true;
                why = relayUrl.getHost() + " ki limit poori ho gayi (HTTP 429).";
            } catch (Throwable t) {
                why = describe(t);
            } finally {
                streamOpen = false;
                clearStream(g);
            }
            if (!alive(g)) break;

            boolean stable = opened[0] > 0 && System.currentTimeMillis() - opened[0] >= stableStreamMs;
            failures = stable ? 1 : failures + 1;
            long wait = BACKOFF_S[Math.min(failures, BACKOFF_S.length) - 1] * backoffUnitMs;
            if (limited) {
                rateFailures = Math.min(rateFailures + 1, 5);
                wait = Math.max(wait, rateLimitMinMs * rateFailures);
                setState(g, State.RATE_LIMITED, why + " " + seconds(wait) + " baad dobara try.");
            } else if (stable) {
                setState(g, State.CONNECTING, relayUrl.getHost());
            } else {
                setState(g, State.OFFLINE, why + " " + seconds(wait) + " baad dobara try.");
            }
            sleep(g, wait);
        }
    }

    private static String seconds(long ms) {
        return Math.max(1, (ms + 500) / 1000) + " sec";
    }

    private void clearStream(int g) {
        synchronized (lock) {
            if (generation == g) {
                streamConn = null;
                streamSockets = null;
            }
        }
    }

    private void stream(int g, long[] opened) throws IOException {
        connects.incrementAndGet();
        URL url = new URL(relay + "/" + topic() + "/json" + sinceParam());
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        // A private socket factory per stream: sockets can be closed from stop(), and are never pooled.
        TrackingFactory tf = new TrackingFactory(ssl != null ? ssl : HttpsURLConnection.getDefaultSSLSocketFactory());
        if (c instanceof HttpsURLConnection) ((HttpsURLConnection) c).setSSLSocketFactory(tf);
        c.setConnectTimeout(connectTimeoutMs);
        c.setReadTimeout(readTimeoutMs);
        c.setUseCaches(false);
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("User-Agent", UA);
        synchronized (lock) {
            if (!alive(g)) return;
            streamConn = c;
            streamSockets = tf;
        }
        try {
            int code = c.getResponseCode();
            if (code == 429) throw new RateLimitedException();
            if (code != 200) throw new HttpStatusException(code);
            LineReader in = new LineReader(c.getInputStream(), MAX_LINE);
            String line;
            while (alive(g) && (line = in.readLine()) != null) {
                if (line.isEmpty()) continue;
                try {
                    handleLine(g, line, opened);
                } catch (Throwable t) {
                    // One bad line must not end the stream.
                }
            }
        } finally {
            try {
                c.disconnect();
            } catch (Throwable ignored) {
            }
        }
    }

    private String sinceParam() {
        String id = lastId;
        if (id != null) return "?since=" + Pairing.encode(id);
        long t = lastServerTime;
        return t > 0 ? "?since=" + (t - 1) : "";
    }

    private void handleLine(int g, String line, long[] opened) {
        JSONObject ev;
        try {
            ev = new JSONObject(line);
        } catch (Exception e) {
            return;
        }
        String event = ev.optString("event", "");
        long time = ev.optLong("time", 0);
        long now = System.currentTimeMillis();
        if (time > 0) lastServerTime = time;
        if (time > 0 && ("open".equals(event) || "keepalive".equals(event))) {
            serverOffsetMs = time * 1000L - now;
            serverClockKnown = true;
        }
        if ("open".equals(event)) {
            opened[0] = System.currentTimeMillis();
            streamOpen = true;
            rateFailures = 0;
            setState(g, State.CONNECTED, relayUrl.getHost());
            return;
        }
        if (!"message".equals(event)) return;

        String eventId = ev.optString("id", "");
        JSONObject msg = decode(ev.optString("message", ""));
        String dir = msg == null ? "" : msg.optString("dir", "");
        // Our own acks are sent with cache=no, so their ids are useless for ?since=.
        if (!"t2c".equals(dir) && !eventId.isEmpty() && eventId.length() <= 64) lastId = eventId;
        if (msg == null || !"c2t".equals(dir) || msg.optInt("v", 0) != 1) return;

        String id = msg.optString("id", "");
        String cmd = msg.optString("cmd", "");
        if (id.isEmpty() || id.length() > 64 || cmd.isEmpty()) return;
        if (!isFresh(msg.optLong("ts", 0), time, now)) return;
        // Also drop commands the relay received more than 300 s ago (backlog after a long outage).
        if (time > 0 && serverClockKnown && now + serverOffsetMs - time * 1000L > FRESH_WINDOW_MS + 1000) return;
        if (!markSeen(id)) return;
        JSONObject args = msg.optJSONObject("args");
        accepted.incrementAndGet();
        submit(g, id, cmd, args != null ? args : new JSONObject());
    }

    private JSONObject decode(String body) {
        String plain = crypto.open(body);
        if (plain == null) return null;
        try {
            return new JSONObject(plain);
        } catch (Exception e) {
            return null;
        }
    }

    private boolean markSeen(String id) {
        synchronized (seen) {
            if (seen.containsKey(id)) return false;
            seen.put(id, Boolean.TRUE);
            return true;
        }
    }

    /** PROTOCOL.md section 4: |ts/1000 - serverTime| <= 300 s, or against the local clock when serverTime is 0. */
    public static boolean isFresh(long tsMillis, long serverTimeSecOrZero, long nowMillis) {
        if (tsMillis <= 0) return false;
        long ref = serverTimeSecOrZero > 0 ? serverTimeSecOrZero * 1000L : nowMillis;
        long d = tsMillis - ref;
        return d <= FRESH_WINDOW_MS && d >= -FRESH_WINDOW_MS;
    }

    // ---------------------------------------------------------------- commands and acks

    private void submit(final int g, final String id, final String cmd, final JSONObject args) {
        ExecutorService ex;
        synchronized (lock) {
            ex = alive(g) ? exec : null;
        }
        if (ex == null) return;
        try {
            ex.execute(() -> runCommand(g, id, cmd, args));
        } catch (RejectedExecutionException ignored) {
            // Stopped meanwhile.
        }
    }

    private void runCommand(int g, String id, String cmd, JSONObject args) {
        try {
            JSONObject result;
            try {
                result = handler.onCommand(cmd, args);
            } catch (Throwable t) {
                result = result(false, "TV par error: " + t);
            }
            if (result == null) result = result(false, "TV se jawab nahi mila.");
            if (!alive(g)) return;
            for (String env : buildAcks(crypto, id, result, System.currentTimeMillis())) {
                if (!alive(g)) return;
                postAck(g, env);
            }
        } catch (Throwable ignored) {
            // Never let one command kill the executor thread.
        }
    }

    private void postAck(int g, String envelope) {
        for (int attempt = 0; attempt < 2 && alive(g); attempt++) {
            try {
                int code = post(relay + "/" + topic() + "?firebase=no&cache=no", envelope);
                if (code == 429) {
                    if (state == State.CONNECTED) {
                        setState(g, State.RATE_LIMITED,
                                relayUrl.getHost() + " ki limit poori ho gayi (HTTP 429). Jawab nahi bhej paaye.");
                    }
                    return;
                }
                if (code >= 200 && code < 300) {
                    if (state == State.RATE_LIMITED && streamOpen) setState(g, State.CONNECTED, relayUrl.getHost());
                    return;
                }
                if (code < 500) return;
            } catch (IOException e) {
                // Retry once below.
            }
            sleep(g, backoffUnitMs);
        }
    }

    private int post(String url, String body) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        if (ssl != null && c instanceof HttpsURLConnection) ((HttpsURLConnection) c).setSSLSocketFactory(ssl);
        c.setConnectTimeout(connectTimeoutMs);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setDoOutput(true);
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "text/plain");
        c.setRequestProperty("User-Agent", UA);
        byte[] b = body.getBytes(Pairing.UTF8);
        c.setFixedLengthStreamingMode(b.length);
        OutputStream out = c.getOutputStream();
        try {
            out.write(b);
        } finally {
            out.close();
        }
        int code = c.getResponseCode();
        InputStream in = null;
        try {
            in = code < 400 ? c.getInputStream() : c.getErrorStream();
            if (in != null) {
                byte[] buf = new byte[1024];
                while (in.read(buf) > 0) { /* drain so the connection can be reused */ }
            }
        } catch (IOException ignored) {
        } finally {
            closeQuietly(in);
        }
        return code;
    }

    static JSONObject result(boolean ok, String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            o.put("msg", msg);
        } catch (JSONException ignored) {
        }
        return o;
    }

    /**
     * Builds the encrypted ack(s) for a handler result. Each envelope is shorter than MAX_ENVELOPE:
     * a big data.apps array is split over part/parts; anything else oversized drops data, then trims msg.
     */
    static List<String> buildAcks(RelayCrypto crypto, String re, JSONObject result, long now) {
        boolean ok = result.optBoolean("ok", false);
        String msg = result.isNull("msg") ? "" : result.optString("msg", "");
        JSONObject data = result.optJSONObject("data");
        if (data == null) data = new JSONObject();
        try {
            JSONObject one = ack(re, now, ok, msg, data, 0, 1);
            if (envLength(one) < MAX_ENVELOPE) return Collections.singletonList(crypto.seal(one.toString()));
            JSONArray apps = data.optJSONArray("apps");
            if (apps != null) {
                List<String> parts = splitApps(crypto, re, now, ok, msg, data, apps);
                if (parts != null) return parts;
            }
            return Collections.singletonList(crypto.seal(shrink(re, now, ok, msg).toString()));
        } catch (JSONException e) {
            return Collections.singletonList(crypto.seal(result(ok, msg).toString()));
        }
    }

    private static JSONObject ack(String re, long now, boolean ok, String msg, JSONObject data, int part, int parts)
            throws JSONException {
        JSONObject o = new JSONObject();
        o.put("v", 1);
        o.put("dir", "t2c");
        o.put("id", newId());
        o.put("re", re);
        o.put("ts", now);
        o.put("ok", ok);
        o.put("msg", msg);
        o.put("data", data);
        o.put("part", part);
        o.put("parts", parts);
        return o;
    }

    private static int envLength(JSONObject o) {
        return RelayCrypto.envelopeLength(o.toString().getBytes(Pairing.UTF8).length);
    }

    private static List<String> splitApps(RelayCrypto crypto, String re, long now, boolean ok, String msg,
                                          JSONObject data, JSONArray apps) throws JSONException {
        JSONObject base = new JSONObject();
        Iterator<String> keys = data.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            if (!"apps".equals(k)) base.put(k, data.get(k));
        }
        if (partLength(re, now, ok, msg, base, new ArrayList<Object>()) >= MAX_ENVELOPE) return null;

        List<List<Object>> chunks = new ArrayList<>();
        List<Object> cur = new ArrayList<>();
        for (int i = 0; i < apps.length(); i++) {
            Object item = apps.opt(i);
            if (item == null) continue;
            cur.add(item);
            if (partLength(re, now, ok, msg, base, cur) < MAX_ENVELOPE) continue;
            cur.remove(cur.size() - 1);
            if (!cur.isEmpty()) {
                chunks.add(cur);
                cur = new ArrayList<>();
            }
            cur.add(item);
            if (partLength(re, now, ok, msg, base, cur) >= MAX_ENVELOPE) {
                cur.clear();
                Object small = shrinkApp(item, re, now, ok, msg, base);
                if (small != null) cur.add(small);
            }
        }
        if (!cur.isEmpty() || chunks.isEmpty()) chunks.add(cur);

        List<String> out = new ArrayList<>(chunks.size());
        for (int i = 0; i < chunks.size(); i++) {
            JSONObject d = copy(base);
            d.put("apps", new JSONArray(chunks.get(i)));
            out.add(crypto.seal(ack(re, now, ok, msg, d, i, chunks.size()).toString()));
        }
        return out;
    }

    private static int partLength(String re, long now, boolean ok, String msg, JSONObject base, List<Object> items)
            throws JSONException {
        JSONObject d = copy(base);
        d.put("apps", new JSONArray(items));
        return envLength(ack(re, now, ok, msg, d, PLACEHOLDER_PART, PLACEHOLDER_PART));
    }

    /** An app entry too big for one envelope: cut its label until it fits, or drop it (null). */
    private static Object shrinkApp(Object item, String re, long now, boolean ok, String msg, JSONObject base)
            throws JSONException {
        if (!(item instanceof JSONObject)) return null;
        JSONObject app = (JSONObject) item;
        String label = app.optString("label", "");
        List<Object> one = new ArrayList<>(1);
        for (int n = label.length() / 2; ; n /= 2) {
            JSONObject small = copy(app);
            small.put("label", cut(label, n));
            one.clear();
            one.add(small);
            if (partLength(re, now, ok, msg, base, one) < MAX_ENVELOPE) return small;
            if (n == 0) return null;
        }
    }

    /** Generic oversized ack: drop data, then trim msg until the envelope fits. */
    private static JSONObject shrink(String re, long now, boolean ok, String msg) throws JSONException {
        for (int n = msg.length(); ; n = n * 3 / 4) {
            JSONObject o = ack(re, now, ok, cut(msg, n), new JSONObject(), 0, 1);
            if (envLength(o) < MAX_ENVELOPE || n == 0) return o;
        }
    }

    /** First n chars of s plus an ellipsis (s itself if it is not longer than n). */
    private static String cut(String s, int n) {
        if (n >= s.length()) return s;
        if (n > 0 && Character.isHighSurrogate(s.charAt(n - 1))) n--;
        return n <= 0 ? "" : s.substring(0, n) + "\u2026";
    }

    private static JSONObject copy(JSONObject o) throws JSONException {
        JSONObject c = new JSONObject();
        Iterator<String> keys = o.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            c.put(k, o.get(k));
        }
        return c;
    }

    static String newId() {
        char[] c = new char[12];
        for (int i = 0; i < c.length; i++) c[i] = ID_CHARS.charAt(RNG.nextInt(ID_CHARS.length()));
        return new String(c);
    }

    // ---------------------------------------------------------------- files

    /**
     * Downloads (https only, host must equal the relay host, max 16 MiB) and decrypts a 'file' command's
     * attachment. args: {url, iv, size, name}. Plain http is accepted only when the relay itself is http
     * (local test relay), and then only from the same host and port.
     */
    public byte[] fetchFile(JSONObject fileArgs) throws IOException, GeneralSecurityException {
        if (fileArgs == null) throw new IOException("File ki details nahi mili.");
        byte[] iv;
        try {
            iv = RelayCrypto.unb64url(fileArgs.optString("iv", ""));
        } catch (IllegalArgumentException e) {
            throw new GeneralSecurityException("File ka IV galat hai.");
        }
        if (iv.length != RelayCrypto.IV_BYTES) throw new GeneralSecurityException("File ka IV galat hai.");
        long size = fileArgs.optLong("size", -1);
        if (size > MAX_FILE_BYTES) throw new IOException("File 16 MB se badi hai.");
        URL url = checkFileUrl(fileArgs.optString("url", ""));
        Buf ct = download(url, MAX_FILE_BYTES + RelayCrypto.TAG_BYTES);
        return crypto.openFile(ct.b, 0, ct.n, iv);
    }

    URL checkFileUrl(String raw) throws IOException {
        URL u;
        try {
            u = new URL(raw == null ? "" : raw.trim());
        } catch (MalformedURLException e) {
            throw new IOException("File ka link galat hai.");
        }
        String scheme = u.getProtocol().toLowerCase(Locale.ROOT);
        String relayScheme = relayUrl.getProtocol().toLowerCase(Locale.ROOT);
        if (!"https".equals(scheme) && !("http".equals(scheme) && "http".equals(relayScheme))) {
            throw new IOException("File sirf https link se aa sakti hai.");
        }
        if (u.getUserInfo() != null || !u.getHost().equalsIgnoreCase(relayUrl.getHost())
                || port(u) != port(relayUrl)) {
            throw new IOException("File sirf relay server (" + relayUrl.getHost() + ") se aa sakti hai.");
        }
        return u;
    }

    private static int port(URL u) {
        return u.getPort() >= 0 ? u.getPort() : u.getDefaultPort();
    }

    private Buf download(URL url, int max) throws IOException {
        URL cur = url;
        for (int hop = 0; hop < 4; hop++) {
            HttpURLConnection c = (HttpURLConnection) cur.openConnection();
            if (ssl != null && c instanceof HttpsURLConnection) ((HttpsURLConnection) c).setSSLSocketFactory(ssl);
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(connectTimeoutMs);
            c.setReadTimeout(fileReadTimeoutMs);
            c.setUseCaches(false);
            c.setRequestProperty("Accept-Encoding", "identity");
            c.setRequestProperty("User-Agent", UA);
            try {
                int code = c.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String loc = c.getHeaderField("Location");
                    if (loc == null) throw new IOException("File download nahi hui (HTTP " + code + ").");
                    cur = checkFileUrl(new URL(cur, loc).toString());
                    continue;
                }
                if (code == 429) {
                    throw new IOException(relayUrl.getHost()
                            + " ki limit poori ho gayi (HTTP 429). Thodi der baad try karein.");
                }
                if (code == 404) throw new IOException("File relay par nahi mili (shayad purani ho kar hat gayi).");
                if (code != 200) throw new IOException("File download nahi hui (HTTP " + code + ").");
                long len = -1;
                String cl = c.getHeaderField("Content-Length");
                if (cl != null) {
                    try {
                        len = Long.parseLong(cl.trim());
                    } catch (NumberFormatException ignored) {
                    }
                }
                if (len > max) throw new IOException("File 16 MB se badi hai.");
                InputStream in = c.getInputStream();
                try {
                    return readAll(in, len, max);
                } finally {
                    closeQuietly(in);
                }
            } finally {
                c.disconnect();
            }
        }
        throw new IOException("File download nahi hui (bahut redirects).");
    }

    private static Buf readAll(InputStream in, long len, int max) throws IOException {
        Buf b = new Buf(len >= 0 ? (int) len : 64 * 1024);
        byte[] tmp = new byte[64 * 1024];
        int n;
        while ((n = in.read(tmp)) != -1) {
            if (b.n + n > max) throw new IOException("File 16 MB se badi hai.");
            b.append(tmp, n);
        }
        return b;
    }

    private static final class Buf {
        byte[] b;
        int n;

        Buf(int cap) {
            b = new byte[Math.max(cap, 16)];
        }

        void append(byte[] src, int len) {
            if (n + len > b.length) {
                byte[] bigger = new byte[Math.max(n + len, b.length * 2)];
                System.arraycopy(b, 0, bigger, 0, n);
                b = bigger;
            }
            System.arraycopy(src, 0, b, n, len);
            n += len;
        }
    }

    // ---------------------------------------------------------------- helpers

    private String describe(Throwable t) {
        String host = relayUrl.getHost();
        if (t instanceof HttpStatusException) return "Relay ne HTTP " + ((HttpStatusException) t).code + " diya.";
        if (t instanceof UnknownHostException) return "Internet nahi mil raha (" + host + " nahi mila).";
        if (t instanceof SocketTimeoutException) return "Relay se jawab nahi aaya (timeout).";
        if (t instanceof ConnectException) return "Relay (" + host + ") se connection nahi hua.";
        if (t instanceof SSLException) {
            return "Secure connection nahi bana (" + t.getClass().getSimpleName() + "). TV ki date/time check karein.";
        }
        return "Relay se connection toot gaya (" + t.getClass().getSimpleName() + ").";
    }

    private static void closeAsync(final HttpURLConnection c, final TrackingFactory f) {
        if (c == null && f == null) return;
        Thread t = new Thread(() -> {
            if (f != null) f.closeAll();
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }, "otv-relay-close");
        t.setDaemon(true);
        t.start();
    }

    static void closeQuietly(Closeable c) {
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

    private static final class RateLimitedException extends IOException {
        private static final long serialVersionUID = 1L;

        RateLimitedException() {
            super("HTTP 429");
        }
    }

    private static final class HttpStatusException extends IOException {
        private static final long serialVersionUID = 1L;
        final int code;

        HttpStatusException(int code) {
            super("HTTP " + code);
            this.code = code;
        }
    }

    /** Reads '\n'-terminated UTF-8 lines; lines longer than max are returned as "" (ignored). */
    static final class LineReader {
        private final InputStream in;
        private final int max;
        private final byte[] buf = new byte[8192];
        private int pos;
        private int lim;
        private final ByteArrayOutputStream line = new ByteArrayOutputStream(512);

        LineReader(InputStream in, int max) {
            this.in = in;
            this.max = max;
        }

        String readLine() throws IOException {
            line.reset();
            boolean any = false;
            boolean overflow = false;
            while (true) {
                if (pos >= lim) {
                    int n = in.read(buf);
                    if (n < 0) {
                        if (!any) return null;
                        break;
                    }
                    pos = 0;
                    lim = n;
                    continue;
                }
                byte b = buf[pos++];
                any = true;
                if (b == '\n') break;
                if (b == '\r') continue;
                if (line.size() < max) line.write(b);
                else overflow = true;
            }
            if (overflow) return "";
            try {
                return line.toString("UTF-8");
            } catch (java.io.UnsupportedEncodingException e) {
                return "";
            }
        }
    }

    /** Wraps an SSLSocketFactory and remembers its sockets so stop() can close a blocked stream at once. */
    static final class TrackingFactory extends SSLSocketFactory {
        private final SSLSocketFactory d;
        private final List<Socket> raw = new ArrayList<>();
        private final List<Socket> tls = new ArrayList<>();
        private boolean closed;

        TrackingFactory(SSLSocketFactory delegate) {
            d = delegate;
        }

        private Socket track(Socket rawSocket, Socket s) throws IOException {
            synchronized (this) {
                if (!closed) {
                    if (rawSocket != null) raw.add(rawSocket);
                    tls.add(s);
                    return s;
                }
            }
            closeQuietly(s);
            throw new SocketException("Relay client stopped");
        }

        void closeAll() {
            List<Socket> all = new ArrayList<>();
            synchronized (this) {
                closed = true;
                all.addAll(raw);
                all.addAll(tls);
                raw.clear();
                tls.clear();
            }
            // Raw sockets first: that wakes up a blocked TLS read even if the TLS close would wait for it.
            for (Socket s : all) closeQuietly(s);
        }

        @Override
        public String[] getDefaultCipherSuites() {
            return d.getDefaultCipherSuites();
        }

        @Override
        public String[] getSupportedCipherSuites() {
            return d.getSupportedCipherSuites();
        }

        @Override
        public Socket createSocket() throws IOException {
            return track(null, d.createSocket());
        }

        @Override
        public Socket createSocket(Socket s, String host, int port, boolean autoClose) throws IOException {
            return track(s, d.createSocket(s, host, port, autoClose));
        }

        @Override
        public Socket createSocket(String host, int port) throws IOException {
            return track(null, d.createSocket(host, port));
        }

        @Override
        public Socket createSocket(String host, int port, InetAddress local, int localPort) throws IOException {
            return track(null, d.createSocket(host, port, local, localPort));
        }

        @Override
        public Socket createSocket(InetAddress host, int port) throws IOException {
            return track(null, d.createSocket(host, port));
        }

        @Override
        public Socket createSocket(InetAddress host, int port, InetAddress local, int localPort) throws IOException {
            return track(null, d.createSocket(host, port, local, localPort));
        }
    }
}
