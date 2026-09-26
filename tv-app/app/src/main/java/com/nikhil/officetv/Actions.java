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

    /** Opens i in another app; if none can, opens it in Office TV's own viewer so the TV never shows an error. */
    private static JSONObject launch(Context c, Intent i, String what, Intent fallback, String notFound) {
        wake(c);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        boolean own = false;
        try {
            if (onlyStubs(c, i)) throw new ActivityNotFoundException();
            c.startActivity(i);
        } catch (ActivityNotFoundException e) {
            if (fallback == null) return result(false, notFound);
            try {
                c.startActivity(fallback);
                own = true;
            } catch (RuntimeException e2) {
                return result(false, notFound);
            }
        } catch (SecurityException e) {
            return result(false, "Android ne rok diya: " + e.getMessage());
        } catch (RuntimeException e) {
            CrashLog.note(c, "startActivity: " + e);
            return result(false, "TV par kholte waqt error: " + e.getMessage());
        }
        if (!canOpenFromBackground(c)) {
            return result(false, "Command bhej diya, par shayad TV par nahi khulega. TV par Office TV app kholkar "
                    + "'Accessibility' ya 'Display over other apps' permission on karein.");
        }
        return result(true, own ? what + " Office TV ke andar khol diya." : what + " TV par khul gaya.");
    }

    static JSONObject openUrl(Context c, String url) {
        url = url == null ? "" : url.trim();
        if (url.isEmpty()) return result(false, "Link khaali hai.");
        if (!url.matches("(?i)^[a-z][a-z0-9+.-]*:.*")) url = "https://" + url;
        Uri uri = Uri.parse(url);
        Intent i = new Intent(Intent.ACTION_VIEW, uri);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        Intent fb = scheme.equals("http") || scheme.equals("https")
                ? ViewerActivity.intent(c, ViewerActivity.MODE_WEB, uri, null, null) : null;
        return launch(c, i, "Link", fb, "Is link ko kholne wali app TV par nahi mili.");
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

    static JSONObject openFile(Context c, File f) {
        if (!f.isFile()) return result(false, "File nahi mili.");
        Intent i = new Intent(Intent.ACTION_VIEW);
        String mime = FilesProvider.mime(f.getName());
        i.setDataAndType(FilesProvider.uriFor(c, f), mime);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent fb = ViewerActivity.intent(c, ViewerActivity.modeFor(mime), Uri.fromFile(f), mime, f.getName());
        fb.putExtra(ViewerActivity.EXTRA_PATH, f.getAbsolutePath());
        return launch(c, i, f.getName(), fb, "TV par is file ko kholne wali app nahi hai. PDF/PPT ke liye "
                + "WPS Office jaisi app TV par install karein.");
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
        if (i == null) return result(false, "Yeh app TV par nahi mili.");
        return launch(c, i, "App", null, "Yeh app TV par nahi mili.");
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
                case "next_slide": case "scroll_down": v.next(); return result(true, "Aage");
                case "prev_slide": case "scroll_up": v.prev(); return result(true, "Peeche");
                case "back": v.close(); return result(true, "Back");
                default: break;
            }
        }

        RemoteA11yService a = RemoteA11yService.instance;
        if (a == null) {
            return result(false, "Iske liye TV par Settings → Accessibility → Office TV on karein.");
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
        if (!done && name.contains("_")) return result(false, "Swipe ke liye Android 7 ya naya chahiye.");
        return result(done, done ? "Done" : "TV ne command nahi maani.");
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
