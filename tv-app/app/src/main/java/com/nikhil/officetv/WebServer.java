package com.nikhil.officetv;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.os.Build;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;

/** Tiny web server on the TV: serves the phone remote page and its JSON API. */
public class WebServer extends NanoHTTPD {
    /** Default port; ControlService tries the next ones if it is busy (see ControlService.port()). */
    static final int PORT = 8080;
    /** Largest upload we accept (NanoHTTPD memory-maps the request body). */
    static final long MAX_UPLOAD = 1024L * 1024 * 1024;
    private static final int MAX_JSON = 256 * 1024;
    private static final long SPACE_MARGIN = 50L * 1024 * 1024;
    private static final String JSON = "application/json; charset=utf-8";

    private final Context ctx;

    WebServer(Context ctx) {
        this(ctx, PORT);
    }

    WebServer(Context ctx, int port) {
        super(port);
        this.ctx = ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
    }

    @Override
    public Response serve(IHTTPSession s) {
        String uri = s.getUri() == null ? "" : s.getUri();
        Method m = s.getMethod();
        try {
            if (m == Method.OPTIONS) return cors(newFixedLengthResponse(Response.Status.OK, MIME_PLAINTEXT, ""));
            if (uri.equals("/") || uri.equals("/index.html")) {
                return newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", asset("index.html"));
            }
            if (!uri.startsWith("/api/")) {
                return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found");
            }
            // NanoHTTPD lower-cases header names.
            if (!Prefs.pin(ctx).equals(s.getHeaders().get("x-pin"))) {
                return json(Response.Status.UNAUTHORIZED, Actions.result(false, "PIN galat hai."));
            }
            if (m == Method.GET) return json(Response.Status.OK, get(uri));
            if (uri.equals("/api/upload")) {
                String problem = uploadProblem(s);
                if (problem != null) {
                    // The body was not read, so this connection cannot be reused.
                    Response r = json(Response.Status.OK, Actions.result(false, problem));
                    r.setKeepAlive(false);
                    r.closeConnection(true);
                    return r;
                }
                return json(Response.Status.OK, upload(s));
            }
            String raw = readBody(s);
            JSONObject in = raw.trim().isEmpty() ? new JSONObject() : new JSONObject(raw);
            return json(Response.Status.OK, post(uri, in));
        } catch (Throwable e) {
            // Throwable: an Error escaping here would kill the whole app (NanoHTTPD only catches Exception).
            CrashLog.note(ctx, "API " + uri + ": " + e);
            String why = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            return json(Response.Status.INTERNAL_ERROR, Actions.result(false, "TV par error: " + why));
        }
    }

    private Object get(String uri) throws Exception {
        switch (uri) {
            case "/api/status": return Actions.status(ctx);
            case "/api/apps": return Actions.apps(ctx);
            case "/api/files": return Actions.files(ctx);
            default: return Actions.result(false, "Unknown: " + uri);
        }
    }

    private JSONObject post(String uri, JSONObject in) throws Exception {
        switch (uri) {
            case "/api/open": return Actions.openUrl(ctx, in.optString("url"));
            case "/api/youtube": return Actions.youtube(ctx, in.optString("q"));
            case "/api/key": return Actions.key(ctx, in.optString("key"));
            case "/api/volume": return Actions.volume(ctx, in.optInt("percent", 30));
            case "/api/app": return Actions.openApp(ctx, in.optString("pkg"));
            case "/api/awake": {
                boolean on = in.optBoolean("on", true);
                Prefs.setKeepAwake(ctx, on);
                ControlService svc = ControlService.instance;
                if (svc != null) svc.applyKeepAwake();
                return Actions.result(true, on ? "Screen hamesha on rahegi." : "Screen normal time par band hogi.");
            }
            case "/api/file/open": return Actions.openFile(ctx, FilesProvider.fileFor(ctx, in.optString("name")));
            case "/api/file/delete": {
                boolean ok = FilesProvider.fileFor(ctx, in.optString("name")).delete();
                return Actions.result(ok, ok ? "File hata di." : "File nahi mili.");
            }
            default: return Actions.result(false, "Unknown: " + uri);
        }
    }

    /** Refuses uploads that are too big for NanoHTTPD or for the TV's free space, before reading them. */
    private String uploadProblem(IHTTPSession s) {
        long len = contentLength(s);
        if (len > MAX_UPLOAD) return "File 1 GB se badi hai. Chhoti file bhejein, ya Google Drive ka link bhejein.";
        if (len <= 0) return null;
        long free = Math.min(ctx.getCacheDir().getUsableSpace(), FilesProvider.dir(ctx).getUsableSpace());
        // NanoHTTPD keeps the whole request plus the extracted file, so about twice the size is needed.
        if (free < 2 * len + SPACE_MARGIN) {
            return "TV mein jagah kam hai (" + free / (1024 * 1024) + " MB khaali). "
                    + "Files list se purani files hata kar dobara bhejein.";
        }
        return null;
    }

    private JSONObject upload(IHTTPSession s) throws Exception {
        Map<String, String> files = new HashMap<>();
        s.parseBody(files);
        String tmp = files.get("file");
        List<String> names = s.getParameters().get("file");
        if (tmp == null || names == null || names.isEmpty()) return Actions.result(false, "File nahi mili.");
        // NanoHTTPD deletes its temp file after the response, so move or copy it now.
        File dest = FilesProvider.store(ctx, names.get(0), new File(tmp));
        JSONObject r = Actions.openFile(ctx, dest);
        r.put("name", dest.getName());
        return r;
    }

    /** JSON bodies are always decoded as UTF-8 (NanoHTTPD would use ASCII when no charset is sent). */
    private static String readBody(IHTTPSession s) throws IOException {
        long len = contentLength(s);
        if (len <= 0) return "";
        if (len > MAX_JSON) throw new IOException("Request bahut badi hai.");
        byte[] buf = new byte[(int) len];
        InputStream in = s.getInputStream();
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) break;
            off += n;
        }
        return new String(buf, 0, off, "UTF-8");
    }

    private static long contentLength(IHTTPSession s) {
        String v = s.getHeaders().get("content-length");
        if (v == null) return 0;
        try {
            return Long.parseLong(v.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private String asset(String name) throws IOException {
        try (InputStream in = ctx.getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private static Response json(Response.Status status, Object body) {
        return cors(newFixedLengthResponse(status, JSON, String.valueOf(body)));
    }

    private static Response cors(Response r) {
        r.addHeader("Access-Control-Allow-Origin", "*");
        r.addHeader("Access-Control-Allow-Headers", "Content-Type, X-Pin");
        r.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        return r;
    }

    // ---------------------------------------------------------------- LAN addresses

    /** "http://<ip>:<port>" for every IPv4 of the TV, office network first, TV hotspot last. */
    static List<String> lanUrls(Context c) {
        int port = ControlService.port();
        if (port <= 0) port = PORT;
        List<String> out = new ArrayList<>();
        for (String ip : ips(c)) out.add("http://" + ip + ":" + port);
        return out;
    }

    /** Every IPv4 on the TV: the internet-facing network first, TV hotspot/screen-share interfaces last. */
    static List<String> ips(Context c) {
        List<String> out = new ArrayList<>();
        String active = activeIp(c);
        if (active != null) out.add(active);
        List<String> hotspot = new ArrayList<>();
        try {
            List<NetworkInterface> all = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface ni : all) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String name = ni.getName() == null ? "" : ni.getName().toLowerCase(Locale.US);
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    String ip = a.getHostAddress();
                    if (out.contains(ip) || hotspot.contains(ip)) continue;
                    (isHotspot(name) ? hotspot : out).add(ip);
                }
            }
        } catch (Throwable ignored) {
            // Some firmwares throw from getNetworkInterfaces(); the active network is enough then.
        }
        out.addAll(hotspot);
        return out;
    }

    private static String activeIp(Context c) {
        if (c == null || Build.VERSION.SDK_INT < 23) return null;
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm == null ? null : cm.getActiveNetwork();
            LinkProperties lp = n == null ? null : cm.getLinkProperties(n);
            if (lp == null) return null;
            for (LinkAddress la : lp.getLinkAddresses()) {
                InetAddress a = la.getAddress();
                if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a.getHostAddress();
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    /** Interfaces that belong to the TV's own hotspot / screen-share, not the office network. */
    private static boolean isHotspot(String name) {
        return name.startsWith("ap") || name.startsWith("p2p") || name.startsWith("swlan")
                || name.startsWith("softap") || name.startsWith("wlan1") || name.startsWith("rndis");
    }
}
