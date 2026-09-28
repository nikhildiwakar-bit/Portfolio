package com.nikhil.officetv;

import android.content.Context;
import android.os.Build;

import com.nikhil.officetv.relay.RelayClient;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/** Runs commands that arrive through the relay (see PROTOCOL.md §5) using the same Actions as the LAN API. */
final class Commands implements RelayClient.Handler {
    private final Context ctx;

    Commands(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    @Override
    public JSONObject onCommand(String cmd, JSONObject args) {
        if (args == null) args = new JSONObject();
        try {
            switch (cmd == null ? "" : cmd) {
                case "ping": return withData(Actions.result(true, "The TV is online."), status(ctx));
                case "open": return Actions.openUrl(ctx, args.optString("url"));
                case "youtube": return Actions.youtube(ctx, args.optString("q"));
                case "key": return Actions.key(ctx, args.optString("key"));
                case "volume": return Actions.volume(ctx, args.optInt("percent", 30));
                case "app": return Actions.openApp(ctx, args.optString("pkg"));
                case "apps": {
                    JSONObject data = new JSONObject();
                    data.put("apps", Actions.apps(ctx));
                    return withData(Actions.result(true, "List of apps."), data);
                }
                case "awake": {
                    boolean on = args.optBoolean("on", true);
                    Prefs.setKeepAwake(ctx, on);
                    ControlService svc = ControlService.instance;
                    if (svc != null) svc.applyKeepAwake();
                    return Actions.result(true, on ? "The screen will stay on." : "The screen will turn off as usual.");
                }
                case "rename": {
                    String name = args.optString("name").trim();
                    if (name.isEmpty()) return Actions.result(false, "Please enter a name.");
                    if (name.length() > 40) name = name.substring(0, 40);
                    Prefs.setTvName(ctx, name);
                    return withData(Actions.result(true, "TV renamed to " + name + "."), status(ctx));
                }
                case "file": return file(args);
                default:
                    return Actions.result(false, "This TV app does not support that command. Please update Office TV on the TV.");
            }
        } catch (Exception e) {
            CrashLog.note(ctx, "Relay command " + cmd + " failed: " + e);
            return Actions.result(false, "Something went wrong on the TV: " + e.getMessage());
        }
    }

    @Override
    public void onState(RelayClient.State state, String detail) {
        RelayManager.setState(state, detail);
    }

    private JSONObject file(JSONObject args) throws JSONException {
        RelayClient client = RelayManager.client();
        if (client == null) return Actions.result(false, "The TV is not connected to the internet right now.");
        byte[] bytes;
        try {
            bytes = client.fetchFile(args);
        } catch (IOException e) {
            return Actions.result(false, "The file did not reach the TV (network issue or expired link). Please send it again.");
        } catch (java.security.GeneralSecurityException e) {
            return Actions.result(false, "The file was damaged or sent with the wrong TV code.");
        }
        File dest = new File(FilesProvider.dir(ctx), safeName(args.optString("name")));
        try (OutputStream out = new FileOutputStream(dest)) {
            out.write(bytes);
        } catch (IOException e) {
            return Actions.result(false, "Could not save the file on the TV (storage may be full).");
        }
        FilesProvider.trim(ctx);
        JSONObject r = Actions.openFile(ctx, dest);
        r.put("name", dest.getName());
        return r;
    }

    /** Same rules as the LAN upload: a plain file name inside the uploads folder. */
    static String safeName(String raw) {
        String n = new File(raw == null ? "" : raw).getName().replaceAll("[^A-Za-z0-9._-]", "_");
        if (n.isEmpty() || n.startsWith(".")) n = "file" + n;
        if (n.length() > 120) n = n.substring(n.length() - 120);
        return n;
    }

    /** Status object from PROTOCOL.md §5. */
    static JSONObject status(Context c) throws JSONException {
        JSONObject s = Actions.status(c);
        s.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        s.put("name", Prefs.tvName(c));
        JSONArray urls = new JSONArray();
        int port = ControlService.port();
        if (port > 0) {
            for (String ip : MainActivity.lanIps()) urls.put("http://" + ip + ":" + port);
        }
        s.put("lanUrls", urls);
        return s;
    }

    private static JSONObject withData(JSONObject result, JSONObject data) throws JSONException {
        result.put("data", data);
        return result;
    }
}
