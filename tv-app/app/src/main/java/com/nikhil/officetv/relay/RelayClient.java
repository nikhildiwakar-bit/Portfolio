package com.nikhil.officetv.relay;

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
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
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
 * <p>
 * 10-symbol codes (Office TV 3.5 and older): ntfy only, exactly as before. 4-digit codes (3.6+,
 * {@link Pairing#isShort}): the three public MQTT brokers of {@link MqttBrokers#DEFAULT_URLS} as well, all at the
 * same time, next to the ntfy stream (topic {@code "officetv/" + topic()}, same envelopes). A command is handled
 * once, whichever transport brings it first, and its ack goes back the way it came: over MQTT to every connected
 * broker (or ntfy if none is connected any more), over ntfy to ntfy. MQTT has no server clock: a command that came
 * over MQTT must be within 300 s of the ntfy server's clock when that is known, otherwise only the id check applies.
 * The state is CONNECTED while any transport is, with a detail like "ntfy.sh + 2 of 3 brokers".
 * <p>
 * API for the app: {@link #start}, {@link #stop} (both return at once, safe on the main thread), {@link #state},
 * {@link #topic}, {@link #brokersConnected}, {@link #usesMqtt} and {@link #probeForOtherTv}, which blocks (call it on
 * a worker thread after {@link #start}) and tells whether another TV answers on this code's topic, i.e. whether a
 * new 4-digit code collides with a TV that is already using it.
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

    private static final long[] BACKOFF_S = {1, 2, 4, 8, 16, 30, 60};
    private static final int SEEN_MAX = 256;
    private static final int MAX_LINE = 64 * 1024;
    private static final String UA = "OfficeTV-relay/1";
    private static final String ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
    private static final SecureRandom RNG = new SecureRandom();

    // Timings; package-private so JVM tests can shorten them.
    volatile long backoffUnitMs = 1000;
    volatile long rateLimitMinMs = 60000;
    volatile long stableStreamMs = 15000;
    volatile int connectTimeoutMs = 15000;
    volatile int readTimeoutMs = 90000;

    /** Probe: how long to wait for a broker before a ping goes out over ntfy instead (ntfy costs daily quota). */
    static final long PROBE_GRACE_MS = 1500;

    // MQTT timings passed to the brokers at start(); package-private so JVM tests can shorten them.
    volatile long mqttBackoffUnitMs = 1000;
    volatile long mqttPingMs = 25000;
    volatile long mqttPongTimeoutMs = 10000;

    private final String relay;
    private final URL relayUrl;
    private final RelayCrypto crypto;
    private final Handler handler;
    private final SSLSocketFactory ssl;
    /** MQTT broker URLs; empty for 10-symbol codes (ntfy only). */
    private final String[] brokerUrls;
    private MqttBrokers brokers; // guarded by lock; the running generation's, null when stopped

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
    /** The ntfy stream's own state (for 10-symbol codes the same as state). Guarded by stateLock. */
    private volatile State ntfyState = State.STOPPED;
    private String ntfyDetail;
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
    /** Running probes: ping id -> answered by another TV. Guarded by itself. */
    private final Map<String, Boolean> probes = new HashMap<>();

    /** Commands accepted by the reader (fresh, new, valid). For tests. */
    final AtomicInteger accepted = new AtomicInteger();
    /** Stream connections attempted. For tests. */
    final AtomicInteger connects = new AtomicInteger();

    /** Commands accepted from MQTT (a subset of accepted). For tests. */
    final AtomicInteger acceptedMqtt = new AtomicInteger();

    /**
     * @param relayUrl relay base URL, e.g. https://ntfy.sh (null, empty or malformed -> default relay)
     * @param code     normalized pairing code (4-digit codes also use the MQTT brokers)
     */
    public RelayClient(String relayUrl, String code, Handler handler, SSLSocketFactory sslOrNull) {
        this(relayUrl, code, handler, sslOrNull, MqttBrokers.DEFAULT_URLS);
    }

    /** For tests: other MQTT broker URLs (ws:// allowed; null or empty = none). Ignored for 10-symbol codes. */
    RelayClient(String relayUrl, String code, Handler handler, SSLSocketFactory sslOrNull, String[] brokerUrls) {
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
        String n = Pairing.normalize(code);
        this.brokerUrls = Pairing.isShort(n) && brokerUrls != null ? brokerUrls.clone() : new String[0];
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

    /** True for 4-digit codes: the MQTT brokers are used next to ntfy. */
    public boolean usesMqtt() {
        return brokerUrls.length > 0;
    }

    /** MQTT brokers connected right now (0 for 10-symbol codes and while stopped). */
    public int brokersConnected() {
        MqttBrokers b = currentBrokers();
        return b == null ? 0 : b.connectedCount();
    }

    private MqttBrokers currentBrokers() {
        synchronized (lock) {
            return running ? brokers : null;
        }
    }

    // ---------------------------------------------------------------- lifecycle

    /** Starts the background reader. Safe to call repeatedly. */
    public void start() {
        synchronized (lock) {
            if (running) return;
            running = true;
            final int g = ++generation;
            synchronized (stateLock) {
                ntfyState = State.CONNECTING;
                ntfyDetail = relayUrl.getHost();
            }
            exec = Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "otv-relay-cmd-" + g);
                t.setDaemon(true);
                return t;
            });
            if (brokerUrls.length > 0) {
                brokers = new MqttBrokers(brokerUrls, MqttBrokers.TOPIC_PREFIX + topic(), ssl != null ? ssl
                        : HttpsURLConnection.getDefaultSSLSocketFactory(), new MqttBrokers.Listener() {
                    @Override
                    public void onMessage(String text, String brokerUrl) {
                        onMqttMessage(g, text);
                    }

                    @Override
                    public void onChange(int connected, int total) {
                        refreshState(g);
                    }
                });
                brokers.backoffUnitMs = mqttBackoffUnitMs;
                brokers.pingMs = mqttPingMs;
                brokers.pongTimeoutMs = mqttPongTimeoutMs;
                brokers.start();
            }
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
        MqttBrokers b;
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
            b = brokers;
            brokers = null;
            lock.notifyAll();
        }
        if (ex != null) ex.shutdownNow();
        if (b != null) b.stop();
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

    /** Sets the ntfy stream's state; the reported state also counts the MQTT brokers (4-digit codes). */
    private void setState(int g, State s, String detail) {
        synchronized (stateLock) {
            if (g != generation) return;
            ntfyState = s;
            ntfyDetail = detail;
            emitState();
        }
    }

    /** A broker connected or disconnected. */
    private void refreshState(int g) {
        synchronized (stateLock) {
            if (g != generation) return;
            emitState();
        }
    }

    /** Reports ntfy's state as is (10-symbol codes), or combined with the brokers. Holds stateLock. */
    private void emitState() {
        State s = ntfyState;
        String detail = ntfyDetail;
        MqttBrokers b = currentBrokers();
        if (b != null && s != State.STOPPED) {
            int n = b.connectedCount();
            String mq = n + " of " + b.size() + " brokers";
            String host = relayUrl.getHost();
            if (s == State.CONNECTED) {
                detail = host + " + " + mq;
            } else if (s == State.CONNECTING) {
                detail = mq + ", connecting to " + host;
            } else {
                detail = mq + ". " + (detail == null ? host + " offline." : detail);
            }
            if (n > 0) s = State.CONNECTED;
        }
        if (s == state && (detail == null ? stateDetail == null : detail.equals(stateDetail))) return;
        state = s;
        stateDetail = detail;
        try {
            handler.onState(s, detail);
        } catch (Throwable ignored) {
            // UI callbacks must never break the client.
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
                why = "The relay closed the connection.";
            } catch (RateLimitedException e) {
                limited = true;
                why = relayUrl.getHost() + " rate limit reached (HTTP 429).";
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
                setState(g, State.RATE_LIMITED, why + " Retrying in " + seconds(wait) + ".");
            } else if (stable) {
                setState(g, State.CONNECTING, relayUrl.getHost());
            } else {
                setState(g, State.OFFLINE, why + " Retrying in " + seconds(wait) + ".");
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
        // Our own acks and probes are sent with cache=no, so their ids are useless for ?since=.
        if (!"t2c".equals(dir) && !isProbe(msg) && !eventId.isEmpty() && eventId.length() <= 64) lastId = eventId;
        if (msg == null || msg.optInt("v", 0) != 1) return;
        if ("t2c".equals(dir)) {
            probeAnswered(msg);
            return;
        }
        if (!"c2t".equals(dir)) return;

        String id = msg.optString("id", "");
        String cmd = msg.optString("cmd", "");
        if (id.isEmpty() || id.length() > 64 || cmd.isEmpty()) return;
        if (!isFresh(msg.optLong("ts", 0), time, now)) return;
        // Also drop commands the relay received more than 300 s ago (backlog after a long outage).
        if (time > 0 && serverClockKnown && now + serverOffsetMs - time * 1000L > FRESH_WINDOW_MS + 1000) return;
        if (!markSeen(id)) return;
        JSONObject args = msg.optJSONObject("args");
        accepted.incrementAndGet();
        submit(g, id, cmd, args != null ? args : new JSONObject(), false);
    }

    /**
     * An envelope from an MQTT broker (4-digit codes). There is no server time: the command must be within 300 s
     * of the ntfy server's clock when that is known, otherwise only the id check applies. The same message from
     * several brokers and ntfy is handled once (the seen ids are shared).
     */
    private void onMqttMessage(int g, String envelope) {
        if (!alive(g) || envelope == null || !envelope.startsWith(RelayCrypto.PREFIX)) return;
        JSONObject msg = decode(envelope);
        if (msg == null || msg.optInt("v", 0) != 1) return;
        String dir = msg.optString("dir", "");
        if ("t2c".equals(dir)) {
            probeAnswered(msg);
            return;
        }
        if (!"c2t".equals(dir)) return;
        String id = msg.optString("id", "");
        String cmd = msg.optString("cmd", "");
        if (id.isEmpty() || id.length() > 64 || cmd.isEmpty()) return;
        long ts = msg.optLong("ts", 0);
        if (ts <= 0) return;
        if (serverClockKnown && !isFresh(ts, 0, System.currentTimeMillis() + serverOffsetMs)) return;
        if (!markSeen(id)) return;
        JSONObject args = msg.optJSONObject("args");
        accepted.incrementAndGet();
        acceptedMqtt.incrementAndGet();
        submit(g, id, cmd, args != null ? args : new JSONObject(), true);
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

    private void submit(final int g, final String id, final String cmd, final JSONObject args, final boolean viaMqtt) {
        ExecutorService ex;
        synchronized (lock) {
            ex = alive(g) ? exec : null;
        }
        if (ex == null) return;
        try {
            ex.execute(() -> runCommand(g, id, cmd, args, viaMqtt));
        } catch (RejectedExecutionException ignored) {
            // Stopped meanwhile.
        }
    }

    /** Runs a command; the ack goes back the way the command came (MQTT: every connected broker, else ntfy). */
    private void runCommand(int g, String id, String cmd, JSONObject args, boolean viaMqtt) {
        try {
            JSONObject result;
            try {
                result = handler.onCommand(cmd, args);
            } catch (Throwable t) {
                result = result(false, "Something went wrong on the TV: " + t);
            }
            if (result == null) result = result(false, "The TV did not respond.");
            if (!alive(g)) return;
            for (String env : buildAcks(crypto, id, result, System.currentTimeMillis())) {
                if (!alive(g)) return;
                if (viaMqtt && publishMqtt(g, env) > 0) continue;
                postAck(g, env);
            }
        } catch (Throwable ignored) {
            // Never let one command kill the executor thread.
        }
    }

    /** Publishes to every connected broker of generation g; returns how many it went to. */
    private int publishMqtt(int g, String envelope) {
        MqttBrokers b;
        synchronized (lock) {
            b = alive(g) ? brokers : null;
        }
        return b == null ? 0 : b.publish(envelope);
    }

    /** Posts to ntfy (retries once). Returns true when ntfy accepted it. */
    private boolean postAck(int g, String envelope) {
        for (int attempt = 0; attempt < 2 && alive(g); attempt++) {
            try {
                int code = post(relay + "/" + topic() + "?firebase=no&cache=no", envelope);
                if (code == 429) {
                    if (ntfyState == State.CONNECTED) {
                        setState(g, State.RATE_LIMITED,
                                relayUrl.getHost() + " rate limit reached (HTTP 429). Could not send the reply.");
                    }
                    return false;
                }
                if (code >= 200 && code < 300) {
                    if (ntfyState == State.RATE_LIMITED && streamOpen) setState(g, State.CONNECTED, relayUrl.getHost());
                    return true;
                }
                if (code < 500) return false;
            } catch (IOException e) {
                // Retry once below.
            }
            sleep(g, backoffUnitMs);
        }
        return false;
    }

    // ---------------------------------------------------------------- probe

    /**
     * Does another TV use this code right now? Publishes a c2t "ping" with a fresh id on this TV's own topic (to
     * every connected broker, or over ntfy when no broker came up within {@link #PROBE_GRACE_MS}) and waits up to
     * timeoutMs for an ack of that id. This TV never answers its own ping (its id is marked as seen first), so any
     * ack comes from another TV: a 4-digit code collision. Returns false when nobody answered, when nothing
     * could be sent (no transport connected within timeoutMs, ntfy refused it), when stopped meanwhile and when
     * interrupted. Blocks for up to about 2 * timeoutMs: call it from a worker thread, after {@link #start}.
     */
    public boolean probeForOtherTv(long timeoutMs) {
        int g;
        MqttBrokers b;
        synchronized (lock) {
            if (!running) return false;
            g = generation;
            b = brokers;
        }
        long start = System.currentTimeMillis();
        String id = newId();
        markSeen(id);
        synchronized (probes) {
            probes.put(id, Boolean.FALSE);
        }
        try {
            // A transport: a broker, or ntfy once the brokers had a moment (every ntfy message costs daily quota).
            long end = start + timeoutMs;
            while (true) {
                if (!alive(g)) return false;
                long now = System.currentTimeMillis();
                if (b != null && b.connectedCount() > 0) break;
                if (streamOpen && (b == null || now - start >= Math.min(PROBE_GRACE_MS, timeoutMs))) break;
                if (now >= end || !waitProbe(id, Math.min(50, end - now))) return false;
            }
            JSONObject o = new JSONObject();
            o.put("v", 1);
            o.put("dir", "c2t");
            o.put("id", id);
            // The other TV checks the time against the ntfy server's clock, so ours must not be off.
            o.put("ts", System.currentTimeMillis() + (serverClockKnown ? serverOffsetMs : 0));
            o.put("cmd", "ping");
            o.put("args", new JSONObject());
            String env = crypto.seal(o.toString());
            boolean sent = b != null && b.publish(env) > 0;
            if (!sent) {
                int code;
                try {
                    code = post(relay + "/" + topic() + "?firebase=no&cache=no", env);
                } catch (IOException e) {
                    code = 0;
                }
                if (code < 200 || code >= 300) return false;
            }
            long answerBy = System.currentTimeMillis() + timeoutMs;
            while (alive(g)) {
                synchronized (probes) {
                    if (Boolean.TRUE.equals(probes.get(id))) return true;
                }
                long left = answerBy - System.currentTimeMillis();
                if (left <= 0 || !waitProbe(id, Math.min(100, left))) return false;
            }
            return false;
        } catch (JSONException e) {
            return false;
        } finally {
            synchronized (probes) {
                probes.remove(id);
            }
        }
    }

    /** Waits up to ms for a probe answer; false if the thread was interrupted. */
    private boolean waitProbe(String id, long ms) {
        synchronized (probes) {
            if (ms <= 0 || Boolean.TRUE.equals(probes.get(id))) return true;
            try {
                probes.wait(ms);
                return true;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
    }

    private boolean isProbe(JSONObject msg) {
        if (msg == null) return false;
        synchronized (probes) {
            return probes.containsKey(msg.optString("id", ""));
        }
    }

    /** A t2c ack: if it answers one of our probes, another TV has this code. */
    private void probeAnswered(JSONObject ack) {
        String re = ack.optString("re", "");
        if (re.isEmpty()) return;
        synchronized (probes) {
            if (!probes.containsKey(re)) return;
            probes.put(re, Boolean.TRUE);
            probes.notifyAll();
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
     * Builds the encrypted ack for a handler result: one envelope shorter than MAX_ENVELOPE. An oversized
     * result keeps ok, drops data, then trims msg (acks in Office TV 3.0 are small; this is a safety net).
     * Returns a list so the protocol's part/parts can grow again without changing callers.
     */
    static List<String> buildAcks(RelayCrypto crypto, String re, JSONObject result, long now) {
        boolean ok = result.optBoolean("ok", false);
        String msg = result.isNull("msg") ? "" : result.optString("msg", "");
        JSONObject data = result.optJSONObject("data");
        if (data == null) data = new JSONObject();
        try {
            JSONObject one = ack(re, now, ok, msg, data);
            if (envLength(one) < MAX_ENVELOPE) return Collections.singletonList(crypto.seal(one.toString()));
            return Collections.singletonList(crypto.seal(shrink(re, now, ok, msg).toString()));
        } catch (JSONException e) {
            return Collections.singletonList(crypto.seal(result(ok, msg).toString()));
        }
    }

    private static JSONObject ack(String re, long now, boolean ok, String msg, JSONObject data) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("v", 1);
        o.put("dir", "t2c");
        o.put("id", newId());
        o.put("re", re);
        o.put("ts", now);
        o.put("ok", ok);
        o.put("msg", msg);
        o.put("data", data);
        o.put("part", 0);
        o.put("parts", 1);
        return o;
    }

    private static int envLength(JSONObject o) {
        return RelayCrypto.envelopeLength(o.toString().getBytes(Pairing.UTF8).length);
    }

    /** Oversized ack: drop data, then trim msg until the envelope fits. */
    private static JSONObject shrink(String re, long now, boolean ok, String msg) throws JSONException {
        for (int n = msg.length(); ; n = n * 3 / 4) {
            JSONObject o = ack(re, now, ok, cut(msg, n), new JSONObject());
            if (envLength(o) < MAX_ENVELOPE || n == 0) return o;
        }
    }

    /** First n chars of s plus an ellipsis (s itself if it is not longer than n). */
    private static String cut(String s, int n) {
        if (n >= s.length()) return s;
        if (n > 0 && Character.isHighSurrogate(s.charAt(n - 1))) n--;
        return n <= 0 ? "" : s.substring(0, n) + "\u2026";
    }

    static String newId() {
        char[] c = new char[12];
        for (int i = 0; i < c.length; i++) c[i] = ID_CHARS.charAt(RNG.nextInt(ID_CHARS.length()));
        return new String(c);
    }

    // ---------------------------------------------------------------- helpers

    private String describe(Throwable t) {
        String host = relayUrl.getHost();
        if (t instanceof HttpStatusException) return "The relay returned HTTP " + ((HttpStatusException) t).code + ".";
        if (t instanceof UnknownHostException) return "No internet connection (" + host + " not found).";
        if (t instanceof SocketTimeoutException) return "The relay did not respond (timeout).";
        if (t instanceof ConnectException) return "Could not connect to the relay (" + host + ").";
        if (t instanceof SSLException) {
            return "Secure connection failed (" + t.getClass().getSimpleName() + "). Check the TV's date and time.";
        }
        return "Lost connection to the relay (" + t.getClass().getSimpleName() + ").";
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
