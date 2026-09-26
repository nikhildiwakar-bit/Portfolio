package com.nikhil.officetv;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Small on-device problem log: the last crash (filesDir/last_crash.txt) and the last ~20 non-fatal
 * notes (filesDir/notes.txt), so a TV without adb can still tell us what went wrong.
 */
final class CrashLog {
    private static final String TAG = "OfficeTV";
    private static final String CRASH = "last_crash.txt";
    private static final String NOTES = "notes.txt";
    private static final int MAX_NOTES = 20;
    private static final int MAX_LINE = 200;
    private static final int MAX_REPORT = 1500;
    private static final int FRAMES = 12;
    private static final long RECENT_MS = 3L * 24 * 60 * 60 * 1000;

    private static volatile boolean installed;

    private CrashLog() {}

    /** Writes a short report for every uncaught exception, then lets the previous handler run. */
    static synchronized void install(Context c) {
        if (installed || c == null) return;
        installed = true;
        Context app = c.getApplicationContext();
        final Context ctx = app != null ? app : c;
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try {
                write(new File(ctx.getFilesDir(), CRASH), report(t, e));
            } catch (Throwable ignored) {
                // Never fail inside the crash handler.
            }
            if (prev != null) {
                prev.uncaughtException(t, e);
            } else {
                android.os.Process.killProcess(android.os.Process.myPid());
                System.exit(10);
            }
        });
    }

    /** Remembers a non-fatal problem (one line; the same message twice in a row is counted, not repeated). */
    static void note(Context c, String msg) {
        String line = oneLine(msg);
        Log.w(TAG, line);
        if (c == null) return;
        try {
            synchronized (CrashLog.class) {
                File f = new File(c.getFilesDir(), NOTES);
                List<String> lines = new ArrayList<>();
                String old = read(f);
                if (old != null) {
                    for (String l : old.split("\n")) if (!l.isEmpty()) lines.add(l);
                }
                String entry = now() + "  " + line;
                int last = lines.size() - 1;
                if (last >= 0) {
                    String prevMsg = messageOf(lines.get(last));
                    if (stripCount(prevMsg).equals(line)) {
                        entry = entry + " (x" + (countOf(prevMsg) + 1) + ")";
                        lines.remove(last);
                    }
                }
                lines.add(entry);
                while (lines.size() > MAX_NOTES) lines.remove(0);
                StringBuilder b = new StringBuilder();
                for (String l : lines) b.append(l).append('\n');
                write(f, b.toString());
            }
        } catch (Throwable ignored) {
            // Logging must never break the caller.
        }
    }

    /** The last crash report (short), or null if there is none. */
    static String last(Context c) {
        if (c == null) return null;
        String s = read(new File(c.getFilesDir(), CRASH));
        if (s == null || s.trim().isEmpty()) return null;
        s = s.trim();
        return s.length() > MAX_REPORT ? s.substring(0, MAX_REPORT) + "…" : s;
    }

    /** One line about a crash from the last 3 days ("time  Exception: message"), or null. */
    static String lastLine(Context c) {
        if (c == null) return null;
        File f = new File(c.getFilesDir(), CRASH);
        if (!f.isFile() || System.currentTimeMillis() - f.lastModified() > RECENT_MS) return null;
        String s = read(f);
        if (s == null) return null;
        String time = "", error = null;
        boolean header = true;
        for (String l : s.split("\n")) {
            if (l.startsWith("Time: ")) time = l.substring(6).trim();
            if (!header && !l.trim().isEmpty()) {
                error = l.trim();
                break;
            }
            // The exception line comes right after the "Model: " header line (see report()).
            if (l.startsWith("Model: ")) header = false;
        }
        if (error == null) return null;
        String out = (time + "  " + error).trim();
        return out.length() > 160 ? out.substring(0, 160) + "…" : out;
    }

    /** The recent notes, oldest first, or null if there are none. */
    static String notes(Context c) {
        if (c == null) return null;
        String s = read(new File(c.getFilesDir(), NOTES));
        return s == null || s.trim().isEmpty() ? null : s.trim();
    }

    /** Forget the last crash (e.g. after it was shown on the TV). */
    static void clear(Context c) {
        if (c == null) return;
        try {
            //noinspection ResultOfMethodCallIgnored
            new File(c.getFilesDir(), CRASH).delete();
        } catch (Throwable ignored) {
        }
    }

    static String report(Thread t, Throwable e) {
        StringBuilder b = new StringBuilder(1024);
        b.append("Office TV crash\n");
        b.append("Time: ").append(now()).append('\n');
        b.append("Thread: ").append(t == null ? "?" : t.getName()).append('\n');
        b.append("App: ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.VERSION_CODE)
                .append(") ").append(BuildConfig.FLAVOR).append('\n');
        b.append("Android: ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT)
                .append(")\n");
        b.append("Model: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n');
        appendTrace(b, e, FRAMES);
        Throwable root = e;
        for (int i = 0; i < 10 && root != null && root.getCause() != null && root.getCause() != root; i++) {
            root = root.getCause();
        }
        if (root != null && root != e) {
            b.append("Caused by: ");
            appendTrace(b, root, 6);
        }
        return b.toString();
    }

    private static void appendTrace(StringBuilder b, Throwable e, int frames) {
        if (e == null) {
            b.append("(unknown error)\n");
            return;
        }
        b.append(oneLine(String.valueOf(e))).append('\n');
        StackTraceElement[] st = e.getStackTrace();
        for (int i = 0; st != null && i < st.length && i < frames; i++) b.append("  at ").append(st[i]).append('\n');
    }

    private static String oneLine(String s) {
        if (s == null) s = "null";
        s = s.replace('\r', ' ').replace('\n', ' ').trim();
        return s.length() > MAX_LINE ? s.substring(0, MAX_LINE) + "…" : s;
    }

    /** "2026-09-26 10:20:30  msg (x3)" -> "msg (x3)". */
    private static String messageOf(String line) {
        int i = line.indexOf("  ");
        return i < 0 ? line : line.substring(i + 2);
    }

    private static int countOf(String msg) {
        if (msg.endsWith(")")) {
            int i = msg.lastIndexOf(" (x");
            if (i >= 0) {
                try {
                    return Integer.parseInt(msg.substring(i + 3, msg.length() - 1));
                } catch (NumberFormatException ignored) {
                }
            }
        }
        return 1;
    }

    private static String stripCount(String msg) {
        if (msg.endsWith(")")) {
            int i = msg.lastIndexOf(" (x");
            if (i >= 0 && countOf(msg) > 1) return msg.substring(0, i);
        }
        return msg;
    }

    private static String now() {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());
    }

    private static String read(File f) {
        if (f == null || !f.isFile()) return null;
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0 && out.size() < 64 * 1024) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /** Writes via a temp file + rename so a crash mid-write never leaves half a file. */
    private static void write(File f, String s) throws IOException {
        File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(s.getBytes("UTF-8"));
        }
        if (!tmp.renameTo(f)) {
            try (OutputStream out = new FileOutputStream(f)) {
                out.write(s.getBytes("UTF-8"));
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }
}
