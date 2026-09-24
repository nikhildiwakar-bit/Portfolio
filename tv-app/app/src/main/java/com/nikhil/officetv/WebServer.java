package com.nikhil.officetv;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;

/** Tiny web server on the TV: serves the phone remote page and its JSON API. */
public class WebServer extends NanoHTTPD {
    static final int PORT = 8080;
    private static final String JSON = "application/json; charset=utf-8";

    private final Context ctx;

    WebServer(Context ctx) {
        super(PORT);
        this.ctx = ctx.getApplicationContext();
    }

    @Override
    public Response serve(IHTTPSession s) {
        String uri = s.getUri();
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
            if (uri.equals("/api/upload")) return json(Response.Status.OK, upload(s));

            Map<String, String> body = new HashMap<>();
            s.parseBody(body);
            String raw = body.get("postData");
            JSONObject in = raw == null || raw.isEmpty() ? new JSONObject() : new JSONObject(raw);
            return json(Response.Status.OK, post(uri, in));
        } catch (Exception e) {
            return json(Response.Status.INTERNAL_ERROR, Actions.result(false, "Error: " + e.getMessage()));
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
            case "/api/file/open": return Actions.openFile(ctx, file(in.optString("name")));
            case "/api/file/delete": {
                boolean ok = file(in.optString("name")).delete();
                return Actions.result(ok, ok ? "File hata di." : "File nahi mili.");
            }
            default: return Actions.result(false, "Unknown: " + uri);
        }
    }

    private JSONObject upload(IHTTPSession s) throws Exception {
        Map<String, String> files = new HashMap<>();
        s.parseBody(files);
        String tmp = files.get("file");
        List<String> names = s.getParameters().get("file");
        if (tmp == null || names == null || names.isEmpty()) return Actions.result(false, "File nahi mili.");
        File dest = file(names.get(0));
        File src = new File(tmp);
        // NanoHTTPD deletes its temp file after the response, so move or copy it now.
        if (!src.renameTo(dest)) copy(src, dest);
        JSONObject r = Actions.openFile(ctx, dest);
        r.put("name", dest.getName());
        return r;
    }

    /** Resolve a user-supplied name inside the uploads folder, never outside it. */
    private File file(String raw) {
        String n = new File(raw == null ? "" : raw).getName().replaceAll("[^A-Za-z0-9._-]", "_");
        if (n.isEmpty() || n.startsWith(".")) n = "file" + n;
        if (n.length() > 120) n = n.substring(n.length() - 120);
        return new File(FilesProvider.dir(ctx), n);
    }

    private static void copy(File src, File dest) throws IOException {
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
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
        return cors(newFixedLengthResponse(status, JSON, body.toString()));
    }

    private static Response cors(Response r) {
        r.addHeader("Access-Control-Allow-Origin", "*");
        r.addHeader("Access-Control-Allow-Headers", "Content-Type, X-Pin");
        r.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        return r;
    }
}
