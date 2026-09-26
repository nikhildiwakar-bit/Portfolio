package com.nikhil.officetv;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Shares uploaded files (read-only) with the viewer app that opens them, and keeps the uploads folder small. */
public class FilesProvider extends ContentProvider {
    /** The uploads folder keeps at most this many files ... */
    static final int MAX_FILES = 40;
    /** ... and at most this many bytes (the newest file is always kept). */
    static final long MAX_BYTES = 1024L * 1024 * 1024;
    private static final long STALE_TEMP_MS = 6L * 60 * 60 * 1000;

    private static final Map<String, String> EXTRA_MIME = new HashMap<>();

    static {
        // Explicit list because some TV firmwares ship an incomplete MimeTypeMap.
        EXTRA_MIME.put("pdf", "application/pdf");
        EXTRA_MIME.put("ppt", "application/vnd.ms-powerpoint");
        EXTRA_MIME.put("pps", "application/vnd.ms-powerpoint");
        EXTRA_MIME.put("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        EXTRA_MIME.put("ppsx", "application/vnd.openxmlformats-officedocument.presentationml.slideshow");
        EXTRA_MIME.put("doc", "application/msword");
        EXTRA_MIME.put("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        EXTRA_MIME.put("xls", "application/vnd.ms-excel");
        EXTRA_MIME.put("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        EXTRA_MIME.put("odt", "application/vnd.oasis.opendocument.text");
        EXTRA_MIME.put("odp", "application/vnd.oasis.opendocument.presentation");
        EXTRA_MIME.put("ods", "application/vnd.oasis.opendocument.spreadsheet");
        EXTRA_MIME.put("rtf", "application/rtf");
        EXTRA_MIME.put("mp4", "video/mp4");
        EXTRA_MIME.put("m4v", "video/mp4");
        EXTRA_MIME.put("mkv", "video/x-matroska");
        EXTRA_MIME.put("webm", "video/webm");
        EXTRA_MIME.put("mov", "video/quicktime");
        EXTRA_MIME.put("3gp", "video/3gpp");
        EXTRA_MIME.put("avi", "video/x-msvideo");
        EXTRA_MIME.put("ts", "video/mp2t");
        EXTRA_MIME.put("mp3", "audio/mpeg");
        EXTRA_MIME.put("m4a", "audio/mp4");
        EXTRA_MIME.put("aac", "audio/aac");
        EXTRA_MIME.put("wav", "audio/x-wav");
        EXTRA_MIME.put("ogg", "audio/ogg");
        EXTRA_MIME.put("flac", "audio/flac");
        EXTRA_MIME.put("jpg", "image/jpeg");
        EXTRA_MIME.put("jpeg", "image/jpeg");
        EXTRA_MIME.put("png", "image/png");
        EXTRA_MIME.put("gif", "image/gif");
        EXTRA_MIME.put("bmp", "image/bmp");
        EXTRA_MIME.put("webp", "image/webp");
        EXTRA_MIME.put("heic", "image/heic");
        EXTRA_MIME.put("heif", "image/heif");
        EXTRA_MIME.put("svg", "image/svg+xml");
        EXTRA_MIME.put("txt", "text/plain");
        EXTRA_MIME.put("csv", "text/csv");
        EXTRA_MIME.put("htm", "text/html");
        EXTRA_MIME.put("html", "text/html");
        EXTRA_MIME.put("json", "application/json");
    }

    static File dir(Context c) {
        File d = new File(c.getFilesDir(), "uploads");
        if (!d.exists()) {
            //noinspection ResultOfMethodCallIgnored
            d.mkdirs();
        }
        return d;
    }

    static Uri uriFor(Context c, File f) {
        return new Uri.Builder().scheme("content")
                .authority(c.getPackageName() + ".files")
                .appendPath(f.getName())
                .build();
    }

    static String mime(String name) {
        if (name == null) return "application/octet-stream";
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.US);
        String m = EXTRA_MIME.get(ext);
        if (m == null) {
            try {
                m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            } catch (RuntimeException ignored) {
            }
        }
        return m != null ? m : "application/octet-stream";
    }

    /** Safe file name from user input: no folders, no hidden files, at most 120 chars (extension kept). */
    static String safeName(String raw) {
        String n = raw == null ? "" : raw.trim();
        int slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (slash >= 0) n = n.substring(slash + 1);
        n = n.replaceAll("[^\\p{L}\\p{M}\\p{N}._-]", "_");
        if (n.isEmpty() || n.startsWith(".")) n = "file" + n;
        if (n.length() > 120) n = n.substring(n.length() - 120);
        return n;
    }

    /** Resolve a user-supplied name inside the uploads folder, never outside it. */
    static File fileFor(Context c, String rawName) {
        return new File(dir(c), safeName(rawName));
    }

    /** Saves bytes (e.g. a file that came over the relay) into the uploads folder, then trims it. */
    static File save(Context c, String rawName, byte[] data) throws IOException {
        File dest = fileFor(c, rawName);
        File tmp = File.createTempFile("save-", ".part", c.getCacheDir());
        try {
            try (OutputStream out = new FileOutputStream(tmp)) {
                out.write(data);
            }
            moveInto(tmp, dest);
        } finally {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
        trim(c);
        return dest;
    }

    /** Moves (or copies) an already written file, e.g. a LAN upload temp file, into the uploads folder. */
    static File store(Context c, String rawName, File src) throws IOException {
        File dest = fileFor(c, rawName);
        moveInto(src, dest);
        trim(c);
        return dest;
    }

    private static void moveInto(File src, File dest) throws IOException {
        if (!src.renameTo(dest)) copy(src, dest);
        //noinspection ResultOfMethodCallIgnored
        dest.setLastModified(System.currentTimeMillis());
    }

    private static void copy(File src, File dest) throws IOException {
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    /**
     * Keeps only the newest MAX_FILES files and at most MAX_BYTES in the uploads folder (the newest file is
     * always kept), and removes stale upload temp files from the cache. Never throws.
     */
    static synchronized void trim(Context c) {
        try {
            File[] list = dir(c).listFiles();
            if (list != null) {
                List<File> files = new ArrayList<>();
                for (File f : list) if (f.isFile()) files.add(f);
                Collections.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                long total = 0;
                boolean full = false;
                for (int i = 0; i < files.size(); i++) {
                    File f = files.get(i);
                    long len = f.length();
                    if (i > 0 && (full || i >= MAX_FILES || total + len > MAX_BYTES)) {
                        full = true;
                        //noinspection ResultOfMethodCallIgnored
                        f.delete();
                    } else {
                        total += len;
                    }
                }
            }
            File[] tmp = c.getCacheDir().listFiles();
            long now = System.currentTimeMillis();
            if (tmp != null) {
                for (File f : tmp) {
                    String n = f.getName();
                    if (f.isFile() && (n.startsWith("NanoHTTPD-") || n.endsWith(".part"))
                            && now - f.lastModified() > STALE_TEMP_MS) {
                        //noinspection ResultOfMethodCallIgnored
                        f.delete();
                    }
                }
            }
        } catch (RuntimeException e) {
            CrashLog.note(c, "Uploads cleanup: " + e);
        }
    }

    private File file(Uri uri) throws FileNotFoundException {
        String n = uri.getLastPathSegment();
        if (n == null || n.contains("/") || n.startsWith(".")) throw new FileNotFoundException();
        Context c = getContext();
        if (c == null) throw new FileNotFoundException();
        File f = new File(dir(c), n);
        if (!f.isFile()) throw new FileNotFoundException(n);
        return f;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        String n = uri == null ? null : uri.getLastPathSegment();
        return n == null ? null : mime(n);
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File f;
        try {
            f = file(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = projection != null ? projection
                : new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        MatrixCursor c = new MatrixCursor(cols, 1);
        c.addRow(row);
        return c;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
