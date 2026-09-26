package com.nikhil.officetv.relay;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/**
 * A tiny ntfy-compatible relay for tests (com.sun.net.httpserver, in-memory):
 * <pre>
 *   GET  /&lt;topic&gt;/json[?since=id|all|latest|unix|10m][&amp;poll=1]   JSON lines: open, backlog, live messages, keepalives
 *   GET  /&lt;topic&gt;/sse  (same, as Server-Sent Events like ntfy: messages as "data:", others as named events)
 *   POST|PUT /&lt;topic&gt;[?filename=x][&amp;cache=no]                      publish; with filename (or body &gt; 4096 bytes)
 *                                                                  the body becomes an attachment at /file/&lt;id&gt;
 *   GET  /file/&lt;id&gt;                                              attachment bytes
 *   OPTIONS *                                                      CORS preflight; every response has ACAO: *
 *   POST /_admin/fail429?n=N[&amp;kind=subscribe|publish|file|any][&amp;ua=substring]   answer 429 for the next N requests
 *   POST /_admin/drop[?topic=t][&amp;ua=substring]                    end matching subscriber streams
 *   POST /_admin/keepalive?ms=N          GET /_admin/requests      GET /v1/health
 * </pre>
 * Run as a process: {@code FakeNtfy [port] [--https] [--host H] [--keepalive-ms N] [--fail429 N] [--cert-out file.pem]}.
 * It prints "READY &lt;base url&gt;" (and "CERT &lt;pem path&gt;" with --https) once listening. Port 0 = random.
 * Env fallbacks: FAKE_NTFY_429, FAKE_NTFY_KEEPALIVE_MS.
 */
public final class FakeNtfy implements Closeable {
    private static final int MAX_BODY = 20 * 1024 * 1024;
    private static final int MAX_MESSAGE = 4096;
    private static final SecureRandom RNG = new SecureRandom();
    private static final Ev DROP = new Ev("drop", "");

    private final HttpServer server;
    private final ExecutorService pool;
    private final String scheme;
    private final String host;
    private final SSLSocketFactory clientFactory;
    private final Path certPem;
    private volatile long keepaliveMs;

    private final Map<String, Topic> topics = new ConcurrentHashMap<>();
    private final Map<String, byte[]> files = new ConcurrentHashMap<>();
    private final List<Failure> failures = new ArrayList<>();
    private final List<String> requests = Collections.synchronizedList(new ArrayList<>());

    private static final class Ev {
        final String event;
        final String json;

        Ev(String event, String json) {
            this.event = event;
            this.json = json;
        }
    }

    private static final class Sub {
        final BlockingQueue<Ev> q = new LinkedBlockingQueue<>();
        final String ua;

        Sub(String ua) {
            this.ua = ua == null ? "" : ua;
        }
    }

    private static final class Topic {
        final List<JSONObject> history = new ArrayList<>();
        final List<Sub> subs = new ArrayList<>();
    }

    private static final class Failure {
        int left;
        final String kind;
        final String ua;

        Failure(int n, String kind, String ua) {
            this.left = n;
            this.kind = kind == null ? "any" : kind;
            this.ua = ua;
        }
    }

    private FakeNtfy(String host, int port, boolean https, long keepaliveMs) throws Exception {
        this.host = host;
        this.keepaliveMs = keepaliveMs;
        this.scheme = https ? "https" : "http";
        InetSocketAddress addr = new InetSocketAddress(host, port);
        if (https) {
            Path dir = Files.createTempDirectory("fake-ntfy");
            File ks = dir.resolve("fake.p12").toFile();
            String keytool = System.getProperty("java.home") + File.separator + "bin" + File.separator + "keytool";
            Process p = new ProcessBuilder(keytool, "-genkeypair", "-alias", "fake", "-keyalg", "EC", "-groupname", "secp256r1",
                    "-validity", "30", "-dname", "CN=localhost", "-ext", "SAN=dns:localhost,ip:127.0.0.1,ip:::1",
                    "-keystore", ks.getPath(), "-storetype", "PKCS12", "-storepass", "changeit", "-keypass", "changeit",
                    "-noprompt").redirectErrorStream(true).start();
            String out = new String(readAll(p.getInputStream(), 1 << 20), StandardCharsets.UTF_8);
            if (p.waitFor() != 0) throw new IOException("keytool failed: " + out);
            KeyStore store = KeyStore.getInstance("PKCS12");
            try (InputStream in = new FileInputStream(ks)) {
                store.load(in, "changeit".toCharArray());
            }
            KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            kmf.init(store, "changeit".toCharArray());
            SSLContext serverCtx = SSLContext.getInstance("TLS");
            serverCtx.init(kmf.getKeyManagers(), null, null);
            Certificate cert = store.getCertificate("fake");
            KeyStore trust = KeyStore.getInstance(KeyStore.getDefaultType());
            trust.load(null, null);
            trust.setCertificateEntry("fake", cert);
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(trust);
            SSLContext clientCtx = SSLContext.getInstance("TLS");
            clientCtx.init(null, tmf.getTrustManagers(), null);
            clientFactory = clientCtx.getSocketFactory();
            certPem = dir.resolve("fake-ntfy.pem");
            String pem = "-----BEGIN CERTIFICATE-----\n"
                    + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(cert.getEncoded())
                    + "\n-----END CERTIFICATE-----\n";
            Files.write(certPem, pem.getBytes(StandardCharsets.US_ASCII));
            HttpsServer s = HttpsServer.create(addr, 64);
            s.setHttpsConfigurator(new HttpsConfigurator(serverCtx));
            server = s;
        } else {
            clientFactory = null;
            certPem = null;
            server = HttpServer.create(addr, 64);
        }
        pool = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "fake-ntfy");
            t.setDaemon(true);
            return t;
        });
        server.setExecutor(pool);
        server.createContext("/", this::handle);
        server.start();
    }

    /** Starts a relay on 127.0.0.1 (port 0 = random). */
    public static FakeNtfy start(int port, boolean https, long keepaliveMs) throws Exception {
        return new FakeNtfy("127.0.0.1", port, https, keepaliveMs);
    }

    public static void main(String[] args) throws Exception {
        int port = 0;
        boolean https = false;
        String host = "127.0.0.1";
        String certOut = null;
        long keepalive = envLong("FAKE_NTFY_KEEPALIVE_MS", 45000);
        int fail = (int) envLong("FAKE_NTFY_429", 0);
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--https": https = true; break;
                case "--host": host = args[++i]; break;
                case "--keepalive-ms": keepalive = Long.parseLong(args[++i]); break;
                case "--fail429": fail = Integer.parseInt(args[++i]); break;
                case "--cert-out": certOut = args[++i]; break;
                default: port = Integer.parseInt(args[i]);
            }
        }
        FakeNtfy f = new FakeNtfy(host, port, https, keepalive);
        if (fail > 0) f.fail429(fail, "any", null);
        Runtime.getRuntime().addShutdownHook(new Thread(f::close));
        System.out.println("READY " + f.baseUrl());
        if (f.certPem != null) {
            Path pem = f.certPem;
            if (certOut != null) {
                pem = new File(certOut).toPath();
                Files.copy(f.certPem, pem, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            System.out.println("CERT " + pem.toAbsolutePath());
        }
        System.out.flush();
        Thread.currentThread().join();
    }

    private static long envLong(String name, long def) {
        String v = System.getenv(name);
        if (v == null || v.trim().isEmpty()) return def;
        return Long.parseLong(v.trim());
    }

    public String baseUrl() {
        String h = host.contains(":") ? "[" + host + "]" : host;
        if ("0.0.0.0".equals(host)) h = "127.0.0.1";
        return scheme + "://" + h + ":" + server.getAddress().getPort();
    }

    public int port() {
        return server.getAddress().getPort();
    }

    /** Socket factory that trusts this relay's self-signed certificate (https mode), else null. */
    public SSLSocketFactory clientSocketFactory() {
        return clientFactory;
    }

    public Path certPem() {
        return certPem;
    }

    public void setKeepaliveMs(long ms) {
        keepaliveMs = ms;
    }

    /** Answer the next n matching requests with HTTP 429. kind: subscribe, publish, file or any. */
    public void fail429(int n, String kind, String uaContains) {
        synchronized (failures) {
            failures.add(new Failure(n, kind, uaContains));
        }
    }

    /** Ends the streams of matching subscribers (topic null = all, ua null = any) like a server-side close. */
    public int dropSubscribers(String topic, String uaContains) {
        int n = 0;
        for (Map.Entry<String, Topic> e : topics.entrySet()) {
            if (topic != null && !topic.equals(e.getKey())) continue;
            Topic t = e.getValue();
            synchronized (t) {
                for (Sub s : new ArrayList<>(t.subs)) {
                    if (uaContains != null && !s.ua.contains(uaContains)) continue;
                    t.subs.remove(s);
                    s.q.add(DROP);
                    n++;
                }
            }
        }
        return n;
    }

    public int subscriberCount(String topic, String uaContains) {
        Topic t = topics.get(topic);
        if (t == null) return 0;
        int n = 0;
        synchronized (t) {
            for (Sub s : t.subs) if (uaContains == null || s.ua.contains(uaContains)) n++;
        }
        return n;
    }

    /** Request log lines: "<millis> <METHOD> <path?query> <status> ua=<user agent>". */
    public List<String> requests() {
        synchronized (requests) {
            return new ArrayList<>(requests);
        }
    }

    /** Publishes a message from inside the process (no HTTP). */
    public JSONObject publish(String topic, String message) {
        return publishAt(topic, message, System.currentTimeMillis() / 1000);
    }

    /** Like publish(), but with a chosen server receive time (unix seconds), e.g. to fake an old backlog. */
    public JSONObject publishAt(String topic, String message, long timeSec) {
        JSONObject m = event("message", topic);
        m.put("time", timeSec);
        m.put("expires", m.getLong("time") + 43200);
        m.put("message", message);
        deliver(topic, m, true);
        return m;
    }

    /** Sends a raw line (not necessarily JSON) to every current subscriber of the topic. */
    public void injectRaw(String topic, String line) {
        Topic t = topic(topic);
        synchronized (t) {
            for (Sub s : t.subs) s.q.add(new Ev("raw", line));
        }
    }

    @Override
    public void close() {
        dropSubscribers(null, null);
        server.stop(0);
        pool.shutdownNow();
    }

    // ---------------------------------------------------------------- HTTP

    private void handle(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod().toUpperCase();
        URI uri = ex.getRequestURI();
        String path = uri.getRawPath();
        Map<String, String> q = query(uri.getRawQuery());
        String ua = ex.getRequestHeaders().getFirst("User-Agent");
        Headers h = ex.getResponseHeaders();
        h.set("Access-Control-Allow-Origin", "*");
        int status = 200;
        try {
            if ("OPTIONS".equals(method)) {
                h.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
                h.set("Access-Control-Allow-Headers", "*");
                h.set("Access-Control-Max-Age", "3600");
                status = send(ex, 200, "text/plain", new byte[0]);
                return;
            }
            String[] seg = segments(path);
            if (seg.length >= 1 && seg[0].equals("_admin")) {
                status = admin(ex, seg.length > 1 ? seg[1] : "", q);
                return;
            }
            if (seg.length == 2 && seg[0].equals("v1") && seg[1].equals("health")) {
                status = sendJson(ex, 200, new JSONObject().put("healthy", true));
                return;
            }
            if (seg.length == 2 && seg[0].equals("file") && "GET".equals(method)) {
                if (limited("file", ua)) {
                    status = tooMany(ex);
                    return;
                }
                String id = seg[1].contains(".") ? seg[1].substring(0, seg[1].indexOf('.')) : seg[1];
                byte[] b = files.get(id);
                status = b == null ? sendError(ex, 404, 40401, "page not found")
                        : send(ex, 200, "application/octet-stream", b);
                return;
            }
            if (seg.length == 1 && validTopic(seg[0]) && ("POST".equals(method) || "PUT".equals(method))) {
                if (limited("publish", ua)) {
                    status = tooMany(ex);
                    return;
                }
                status = publish(ex, seg[0], q);
                return;
            }
            if (seg.length == 2 && validTopic(seg[0]) && "GET".equals(method)
                    && (seg[1].equals("json") || seg[1].equals("sse"))) {
                if (limited("subscribe", ua)) {
                    status = tooMany(ex);
                    return;
                }
                log(method, uri, 200, ua);
                subscribe(ex, seg[0], seg[1].equals("sse"), q, ua);
                status = -1;
                return;
            }
            if (seg.length == 1 && validTopic(seg[0]) && "GET".equals(method)) {
                status = send(ex, 200, "text/html; charset=utf-8",
                        "<!doctype html><title>fake ntfy</title>".getBytes(StandardCharsets.UTF_8));
                return;
            }
            status = sendError(ex, 404, 40401, "page not found");
        } catch (Throwable t) {
            status = 500;
            try {
                sendError(ex, 500, 50001, String.valueOf(t));
            } catch (Throwable ignored) {
            }
        } finally {
            if (status >= 0) log(method, uri, status, ua);
        }
    }

    private void log(String method, URI uri, int status, String ua) {
        String pq = uri.getRawPath() + (uri.getRawQuery() != null ? "?" + uri.getRawQuery() : "");
        requests.add(System.currentTimeMillis() + " " + method + " " + pq + " " + status + " ua=" + ua);
    }

    private int admin(HttpExchange ex, String what, Map<String, String> q) throws IOException {
        switch (what) {
            case "fail429": {
                int n = Integer.parseInt(q.getOrDefault("n", "1"));
                fail429(n, q.getOrDefault("kind", "any"), q.get("ua"));
                return sendJson(ex, 200, new JSONObject().put("ok", true).put("n", n));
            }
            case "drop":
                return sendJson(ex, 200, new JSONObject().put("dropped", dropSubscribers(q.get("topic"), q.get("ua"))));
            case "keepalive":
                keepaliveMs = Long.parseLong(q.getOrDefault("ms", "45000"));
                return sendJson(ex, 200, new JSONObject().put("keepaliveMs", keepaliveMs));
            case "requests":
                return sendJson(ex, 200, new JSONObject().put("requests", new JSONArray(requests())));
            default:
                return sendError(ex, 404, 40401, "page not found");
        }
    }

    private boolean limited(String kind, String ua) {
        synchronized (failures) {
            for (Failure f : failures) {
                if (f.left <= 0) continue;
                if (!f.kind.equals("any") && !f.kind.equals(kind)) continue;
                if (f.ua != null && (ua == null || !ua.contains(f.ua))) continue;
                f.left--;
                return true;
            }
        }
        return false;
    }

    private int tooMany(HttpExchange ex) throws IOException {
        return sendError(ex, 429, 42901, "limit reached: too many requests; increase your limits with a paid plan, see https://ntfy.sh");
    }

    private int publish(HttpExchange ex, String topic, Map<String, String> q) throws IOException {
        byte[] body = readAll(ex.getRequestBody(), MAX_BODY + 1);
        if (body.length > MAX_BODY) return sendError(ex, 413, 41301, "attachment too large, or bandwidth limit reached");
        Headers rh = ex.getRequestHeaders();
        String filename = first(q.get("filename"), rh.getFirst("Filename"), rh.getFirst("X-Filename"));
        String cache = first(q.get("cache"), rh.getFirst("Cache"), rh.getFirst("X-Cache"));
        String text = first(q.get("message"), rh.getFirst("Message"), rh.getFirst("X-Message"));
        JSONObject m = event("message", topic);
        m.put("expires", m.getLong("time") + 43200);
        if (filename != null || body.length > MAX_MESSAGE || !utf8(body)) {
            // Like ntfy: explicit uploads and oversized/binary bodies become attachments.
            String name = filename != null ? filename : "attachment.txt";
            String id = m.getString("id");
            files.put(id, body);
            JSONObject att = new JSONObject();
            att.put("name", name);
            att.put("type", "application/octet-stream");
            att.put("size", body.length);
            att.put("expires", m.getLong("time") + 10800);
            att.put("url", base(ex) + "/file/" + id);
            m.put("attachment", att);
            m.put("message", text != null ? text : "You received a file: " + name);
        } else {
            m.put("message", text != null && body.length == 0 ? text : new String(body, StandardCharsets.UTF_8));
        }
        deliver(topic, m, !"no".equalsIgnoreCase(cache));
        return sendJson(ex, 200, m);
    }

    private void deliver(String topic, JSONObject m, boolean cache) {
        Topic t = topic(topic);
        synchronized (t) {
            if (cache) {
                t.history.add(m);
                if (t.history.size() > 2000) t.history.remove(0);
            }
            for (Sub s : t.subs) s.q.add(new Ev("message", m.toString()));
        }
    }

    private void subscribe(HttpExchange ex, String topic, boolean sse, Map<String, String> q, String ua) throws IOException {
        boolean poll = "1".equals(q.get("poll")) || "true".equalsIgnoreCase(q.get("poll"));
        String since = q.get("since");
        if (poll && since == null) since = "all";
        Topic t = topic(topic);
        List<JSONObject> backlog;
        Sub sub = poll ? null : new Sub(ua);
        synchronized (t) {
            backlog = since(t, since);
            if (sub != null) t.subs.add(sub);
        }
        Headers h = ex.getResponseHeaders();
        h.set("Content-Type", sse ? "text/event-stream; charset=utf-8" : "application/x-ndjson; charset=utf-8");
        h.set("Cache-Control", "no-cache");
        OutputStream os = null;
        try {
            ex.sendResponseHeaders(200, 0);
            os = ex.getResponseBody();
            if (!poll) write(os, sse, new Ev("open", event("open", topic).toString()));
            for (JSONObject m : backlog) write(os, sse, new Ev("message", m.toString()));
            os.flush();
            if (poll) return;
            while (true) {
                Ev e = sub.q.poll(keepaliveMs, TimeUnit.MILLISECONDS);
                if (e == DROP) break;
                if (e == null) e = new Ev("keepalive", event("keepalive", topic).toString());
                write(os, sse, e);
                os.flush();
            }
        } catch (IOException | InterruptedException ignored) {
            // Client went away.
        } finally {
            if (sub != null) {
                synchronized (t) {
                    t.subs.remove(sub);
                }
            }
            ex.close();
        }
    }

    private static void write(OutputStream os, boolean sse, Ev e) throws IOException {
        String s;
        if (!sse) s = e.json + "\n";
        else if (e.event.equals("message") || e.event.equals("raw")) s = "data: " + e.json + "\n\n";
        else s = "event: " + e.event + "\ndata: " + e.json + "\n\n";
        os.write(s.getBytes(StandardCharsets.UTF_8));
    }

    private static List<JSONObject> since(Topic t, String since) {
        List<JSONObject> h = t.history;
        if (since == null || since.isEmpty() || since.equals("none")) return new ArrayList<>();
        if (since.equals("all")) return new ArrayList<>(h);
        if (since.equals("latest")) return h.isEmpty() ? new ArrayList<>() : new ArrayList<>(h.subList(h.size() - 1, h.size()));
        long minTime = -1;
        if (since.matches("\\d+")) {
            minTime = Long.parseLong(since);
        } else if (since.matches("\\d+[smhd]")) {
            long n = Long.parseLong(since.substring(0, since.length() - 1));
            long mul = "smhd".indexOf(since.charAt(since.length() - 1));
            long[] secs = {1, 60, 3600, 86400};
            minTime = System.currentTimeMillis() / 1000 - n * secs[(int) mul];
        }
        List<JSONObject> out = new ArrayList<>();
        if (minTime >= 0) {
            for (JSONObject m : h) if (m.getLong("time") >= minTime) out.add(m);
            return out;
        }
        for (int i = 0; i < h.size(); i++) {
            if (h.get(i).getString("id").equals(since)) return new ArrayList<>(h.subList(i + 1, h.size()));
        }
        return new ArrayList<>(h); // Unknown id: ntfy returns everything it has.
    }

    private Topic topic(String name) {
        Topic t = topics.get(name);
        if (t == null) {
            topics.putIfAbsent(name, new Topic());
            t = topics.get(name);
        }
        return t;
    }

    private static JSONObject event(String type, String topic) {
        JSONObject o = new JSONObject();
        o.put("id", id());
        o.put("time", System.currentTimeMillis() / 1000);
        o.put("event", type);
        o.put("topic", topic);
        return o;
    }

    private static String id() {
        String a = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        char[] c = new char[12];
        for (int i = 0; i < c.length; i++) c[i] = a.charAt(RNG.nextInt(a.length()));
        return new String(c);
    }

    private String base(HttpExchange ex) {
        String hostHeader = ex.getRequestHeaders().getFirst("Host");
        if (hostHeader == null || hostHeader.isEmpty()) return baseUrl();
        return scheme + "://" + hostHeader;
    }

    private static boolean validTopic(String s) {
        return s.matches("[-_A-Za-z0-9]{1,64}") && !s.equals("file") && !s.equals("v1") && !s.equals("_admin");
    }

    private static String[] segments(String path) {
        List<String> out = new ArrayList<>();
        for (String s : path.split("/")) if (!s.isEmpty()) out.add(s);
        return out.toArray(new String[0]);
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> m = new HashMap<>();
        if (raw == null || raw.isEmpty()) return m;
        for (String kv : raw.split("&")) {
            int eq = kv.indexOf('=');
            try {
                String k = URLDecoder.decode(eq < 0 ? kv : kv.substring(0, eq), "UTF-8");
                String v = eq < 0 ? "" : URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
                m.put(k, v);
            } catch (Exception ignored) {
            }
        }
        return m;
    }

    private static String first(String... v) {
        for (String s : v) if (s != null && !s.isEmpty()) return s;
        return null;
    }

    private static boolean utf8(byte[] b) {
        try {
            StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(b));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static byte[] readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > max) break;
        }
        return out.toByteArray();
    }

    private static int send(HttpExchange ex, int status, String type, byte[] body) throws IOException {
        ex.getResponseHeaders().set("Content-Type", type);
        ex.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
        if (body.length > 0) {
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        }
        ex.close();
        return status;
    }

    private static int sendJson(HttpExchange ex, int status, JSONObject o) throws IOException {
        return send(ex, status, "application/json", (o.toString() + "\n").getBytes(StandardCharsets.UTF_8));
    }

    private static int sendError(HttpExchange ex, int status, int code, String error) throws IOException {
        JSONObject o = new JSONObject();
        o.put("code", code);
        o.put("http", status);
        o.put("error", error);
        o.put("link", "https://ntfy.sh/docs/publish/#limitations");
        return sendJson(ex, status, o);
    }
}
