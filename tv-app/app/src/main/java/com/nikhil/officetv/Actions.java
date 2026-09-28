package com.nikhil.officetv;

import android.accessibilityservice.AccessibilityService;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.KeyEvent;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.TreeMap;

/** Everything the phone can ask the TV to do. Each call returns {ok, msg}. */
final class Actions {
    private Actions() {}

    static JSONObject result(boolean ok, String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            o.put("msg", msg);
        } catch (JSONException ignored) {
        }
        return o;
    }

    /** Android 10+ blocks background apps from opening screens unless one of these is on. */
    static boolean canOpenFromBackground(Context c) {
        if (Build.VERSION.SDK_INT < 29) return true;
        return RemoteA11yService.instance != null || android.provider.Settings.canDrawOverlays(c);
    }

    static void wake(Context c) {
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        if (pm == null || pm.isInteractive()) return;
        @SuppressWarnings("deprecation")
        PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE, "officetv:wake");
        wl.acquire(5000);
    }

    /** True when the only apps that claim an intent are Android TV "no app" stubs. */
    static boolean onlyStubs(Context c, Intent i) {
        try {
            List<ResolveInfo> list = c.getPackageManager().queryIntentActivities(i, 0);
            if (list == null || list.isEmpty()) return false; // unknown (package visibility): just try it
            for (ResolveInfo ri : list) {
                String pkg = ri.activityInfo == null ? "" : ri.activityInfo.packageName;
                if (!pkg.contains("stub")) return false;
            }
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    static final String CHROME = "com.android.chrome";
    static final String[] YOUTUBE_APPS = {"com.google.android.youtube.tv", "com.google.android.youtube"};

    static boolean installed(Context c, String pkg) {
        try {
            c.getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            return false;
        }
    }

    static String youtubeApp(Context c) {
        for (String p : YOUTUBE_APPS) if (installed(c, p)) return p;
        return null;
    }

    private static final String NO_BG = "Sent, but the TV may not show it. On the TV, open Office TV and turn on "
            + "Accessibility or \"Display over other apps\".";

    /** Starts one of the intents in order (null entries skipped); the first that starts wins. */
    private static JSONObject start(Context c, String what, String notFound, boolean[] ownFlags, Intent... tries) {
        wake(c);
        for (int k = 0; k < tries.length; k++) {
            Intent i = tries[k];
            if (i == null) continue;
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            boolean own = ownFlags[k];
            try {
                if (!own && onlyStubs(c, i)) continue;
                c.startActivity(i);
            } catch (ActivityNotFoundException e) {
                continue;
            } catch (SecurityException e) {
                if (k == tries.length - 1) return result(false, "Android blocked this: " + e.getMessage());
                continue;
            } catch (RuntimeException e) {
                CrashLog.note(c, "startActivity: " + e);
                if (k == tries.length - 1) return result(false, "Could not open it on the TV: " + e.getMessage());
                continue;
            }
            if (!canOpenFromBackground(c)) return result(false, NO_BG);
            return result(true, "Opened " + what + " on the TV.");
        }
        return result(false, notFound);
    }

    private static Intent browserIntent(Context c, Uri uri, String pkg) {
        Intent i = new Intent(Intent.ACTION_VIEW, uri);
        i.addCategory(Intent.CATEGORY_BROWSABLE);
        if (pkg != null) i.setPackage(pkg);
        // Reuse one browser tab for every command instead of a new tab each time.
        i.putExtra(android.provider.Browser.EXTRA_APPLICATION_ID, c.getPackageName());
        i.putExtra(android.provider.Browser.EXTRA_CREATE_NEW_TAB, false);
        return i;
    }

    private static JSONObject openWeb(Context c, Uri uri, String what) {
        Intent chrome = installed(c, CHROME) ? browserIntent(c, uri, CHROME) : null;
        Intent any = browserIntent(c, uri, null);
        Intent own = ViewerActivity.intent(c, ViewerActivity.MODE_WEB, uri, null, null);
        return start(c, what, "No app on the TV can open this link.", new boolean[]{false, false, true},
                chrome, any, own);
    }

    static JSONObject openUrl(Context c, String url) {
        url = url == null ? "" : url.trim();
        if (url.isEmpty()) return result(false, "The link is empty.");
        if (!url.matches("(?i)^[a-z][a-z0-9+.-]*:.*")) url = "https://" + url;
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        if (scheme.equals("http") || scheme.equals("https")) {
            if (isYoutube(uri)) return openYoutube(c, uri);
            return openWeb(c, uri, "the link");
        }
        Intent i = new Intent(Intent.ACTION_VIEW, uri);
        return start(c, "the link", "No app on the TV can open this link.", new boolean[]{false}, i);
    }

    static boolean isYoutube(Uri u) {
        String h = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.US);
        return h.equals("youtu.be") || h.equals("youtube.com") || h.endsWith(".youtube.com");
    }

    /** Canonical www.youtube.com URL (youtu.be and m.youtube.com become www.youtube.com/watch?v=...). */
    static String canonicalYoutube(String url) {
        Uri u = Uri.parse(url);
        String h = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.US);
        String path = u.getPath() == null ? "" : u.getPath();
        String query = u.getEncodedQuery();
        if (h.equals("youtu.be")) {
            String id = path.startsWith("/") ? path.substring(1) : path;
            int slash = id.indexOf('/');
            if (slash >= 0) id = id.substring(0, slash);
            String q = "v=" + id;
            if (query != null && !query.isEmpty()) q += "&" + query;
            return "https://www.youtube.com/watch?" + q;
        }
        return "https://www.youtube.com" + (path.isEmpty() ? "/" : u.getEncodedPath())
                + (query == null || query.isEmpty() ? "" : "?" + query);
    }

    /** Adds app=desktop&persist_app=1 so the browser shows YouTube's desktop layout on a TV. */
    static String desktopYoutube(String canonical) {
        String out = canonical.replaceAll("([?&])(app|persist_app)=[^&]*&?", "$1");
        if (out.endsWith("?") || out.endsWith("&")) out = out.substring(0, out.length() - 1);
        return out + (out.indexOf('?') >= 0 ? "&" : "?") + "app=desktop&persist_app=1";
    }

    private static JSONObject openYoutube(Context c, Uri uri) {
        String canonical = canonicalYoutube(uri.toString());
        String app = youtubeApp(c);
        if (app != null) {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(canonical)).setPackage(app);
            Intent web = browserIntent(c, Uri.parse(desktopYoutube(canonical)), installed(c, CHROME) ? CHROME : null);
            return start(c, "YouTube", "Could not open YouTube on the TV.", new boolean[]{false, false}, i, web);
        }
        return openWeb(c, Uri.parse(desktopYoutube(canonical)), "YouTube");
    }

    static JSONObject youtube(Context c, String q) {
        q = q == null ? "" : q.trim();
        if (q.isEmpty()) return openUrl(c, "https://www.youtube.com");
        if (q.matches("(?i)^https?://.*") || q.toLowerCase(Locale.US).contains("youtu")) return openUrl(c, q);
        try {
            return openUrl(c, "https://www.youtube.com/results?search_query=" + URLEncoder.encode(q, "UTF-8"));
        } catch (java.io.UnsupportedEncodingException e) {
            return result(false, e.getMessage());
        }
    }

    /** Types Office TV's own viewer always shows (TV photo/video apps are unreliable and some crash). */
    static boolean ownViewerType(String mime) {
        String m = mime == null ? "" : mime.toLowerCase(Locale.US);
        return m.startsWith("image/") || m.startsWith("video/") || m.startsWith("audio/") || m.startsWith("text/")
                || m.equals("application/pdf");
    }

    static JSONObject openFile(Context c, File f) {
        if (!f.isFile()) return result(false, "File not found.");
        String mime = FilesProvider.mime(f.getName());
        Intent own = ViewerActivity.intent(c, ViewerActivity.modeFor(mime), Uri.fromFile(f), mime, f.getName());
        own.putExtra(ViewerActivity.EXTRA_PATH, f.getAbsolutePath());
        String notFound = "The TV cannot open this file type.";
        if (ownViewerType(mime)) return start(c, f.getName(), notFound, new boolean[]{true}, own);
        Intent ext = new Intent(Intent.ACTION_VIEW);
        ext.setDataAndType(FilesProvider.uriFor(c, f), mime);
        ext.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return start(c, f.getName(), notFound, new boolean[]{false, true}, ext, own);
    }

    static JSONArray apps(Context c) {
        PackageManager pm = c.getPackageManager();
        TreeMap<String, String> byLabel = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        String[] cats = {Intent.CATEGORY_LAUNCHER, Intent.CATEGORY_LEANBACK_LAUNCHER};
        for (String cat : cats) {
            Intent q = new Intent(Intent.ACTION_MAIN).addCategory(cat);
            for (ResolveInfo ri : pm.queryIntentActivities(q, 0)) {
                String pkg = ri.activityInfo.packageName;
                if (pkg.equals(c.getPackageName())) continue;
                byLabel.put(String.valueOf(ri.loadLabel(pm)), pkg);
            }
        }
        JSONArray out = new JSONArray();
        for (String label : byLabel.keySet()) {
            JSONObject o = new JSONObject();
            try {
                o.put("label", label);
                o.put("pkg", byLabel.get(label));
            } catch (JSONException ignored) {
            }
            out.put(o);
        }
        return out;
    }

    static JSONObject openApp(Context c, String pkg) {
        PackageManager pm = c.getPackageManager();
        Intent i = pm.getLaunchIntentForPackage(pkg);
        if (i == null) i = pm.getLeanbackLaunchIntentForPackage(pkg);
        if (i == null) return result(false, "This app is not installed on the TV.");
        return start(c, "the app", "This app is not installed on the TV.", new boolean[]{false}, i);
    }

    private static void mediaKey(AudioManager am, int code) {
        long t = SystemClock.uptimeMillis();
        am.dispatchMediaKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0));
        am.dispatchMediaKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_UP, code, 0));
    }

    static JSONObject key(Context c, String name) {
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        switch (name) {
            case "play_pause": mediaKey(am, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE); return result(true, "Play/Pause");
            case "next": mediaKey(am, KeyEvent.KEYCODE_MEDIA_NEXT); return result(true, "Next");
            case "previous": mediaKey(am, KeyEvent.KEYCODE_MEDIA_PREVIOUS); return result(true, "Previous");
            case "volume_up":
                am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI);
                return result(true, "Volume +");
            case "volume_down":
                am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI);
                return result(true, "Volume -");
            case "mute":
                if (Build.VERSION.SDK_INT >= 23) {
                    am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE,
                            AudioManager.FLAG_SHOW_UI);
                } else {
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, 0, AudioManager.FLAG_SHOW_UI);
                }
                return result(true, "Mute");
            case "wake": wake(c); return result(true, "Screen on");
            default: break;
        }

        // Office TV's own viewer is in front: drive it directly (works without Accessibility).
        ViewerActivity v = ViewerActivity.front();
        if (v != null) {
            switch (name) {
                case "next_slide": case "scroll_down": v.next(); return result(true, "Next");
                case "prev_slide": case "scroll_up": v.prev(); return result(true, "Previous");
                case "back": v.close(); return result(true, "Back");
                default: break;
            }
        }

        RemoteA11yService a = RemoteA11yService.instance;
        if (a == null) {
            return result(false, "To use this, turn on Office TV in the TV's Settings > Accessibility.");
        }
        wake(c);
        boolean done;
        switch (name) {
            case "back": done = a.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK); break;
            case "home": done = a.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME); break;
            case "recents": done = a.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS); break;
            case "next_slide": done = a.swipe(0.8f, 0.5f, 0.2f, 0.5f); break;
            case "prev_slide": done = a.swipe(0.2f, 0.5f, 0.8f, 0.5f); break;
            case "scroll_down": done = a.swipe(0.5f, 0.75f, 0.5f, 0.25f); break;
            case "scroll_up": done = a.swipe(0.5f, 0.25f, 0.5f, 0.75f); break;
            default: return result(false, "Unknown key: " + name);
        }
        if (!done && name.contains("_")) return result(false, "Swipe needs Android 7 or newer.");
        return result(done, done ? "Done" : "The TV did not accept the command.");
    }

    static JSONObject volume(Context c, int percent) {
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int v = Math.round(Math.max(0, Math.min(100, percent)) * max / 100f);
        am.setStreamVolume(AudioManager.STREAM_MUSIC, v, AudioManager.FLAG_SHOW_UI);
        return result(true, "Volume " + percent + "%");
    }

    static JSONObject status(Context c) throws JSONException {
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        JSONObject o = new JSONObject();
        o.put("name", Build.MANUFACTURER + " " + Build.MODEL);
        o.put("android", Build.VERSION.RELEASE);
        o.put("accessibility", RemoteA11yService.instance != null);
        o.put("needsPermission", !canOpenFromBackground(c));
        o.put("volume", am.getStreamVolume(AudioManager.STREAM_MUSIC));
        o.put("maxVolume", am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        o.put("keepAwake", Prefs.keepAwake(c));
        o.put("appVersion", BuildConfig.VERSION_NAME);
        o.put("flavor", BuildConfig.FLAVOR);
        o.put("port", ControlService.port());
        o.put("chrome", installed(c, CHROME));
        o.put("youtubeApp", youtubeApp(c) != null);
        return o;
    }

    static JSONArray files(Context c) throws JSONException {
        File[] list = FilesProvider.dir(c).listFiles();
        List<File> files = new ArrayList<>();
        if (list != null) Collections.addAll(files, list);
        Collections.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        JSONArray out = new JSONArray();
        for (File f : files) {
            JSONObject o = new JSONObject();
            o.put("name", f.getName());
            o.put("size", f.length());
            out.put(o);
        }
        return out;
    }
}
