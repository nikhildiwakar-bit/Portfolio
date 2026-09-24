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
import java.io.FileNotFoundException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Shares uploaded files (read-only) with the viewer app that opens them. */
public class FilesProvider extends ContentProvider {
    private static final Map<String, String> EXTRA_MIME = new HashMap<>();

    static {
        EXTRA_MIME.put("pdf", "application/pdf");
        EXTRA_MIME.put("ppt", "application/vnd.ms-powerpoint");
        EXTRA_MIME.put("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        EXTRA_MIME.put("doc", "application/msword");
        EXTRA_MIME.put("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        EXTRA_MIME.put("xls", "application/vnd.ms-excel");
        EXTRA_MIME.put("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        EXTRA_MIME.put("mp4", "video/mp4");
        EXTRA_MIME.put("mkv", "video/x-matroska");
        EXTRA_MIME.put("webp", "image/webp");
    }

    static File dir(Context c) {
        File d = new File(c.getFilesDir(), "uploads");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    static Uri uriFor(Context c, File f) {
        return new Uri.Builder().scheme("content")
                .authority(c.getPackageName() + ".files")
                .appendPath(f.getName())
                .build();
    }

    static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.US);
        String m = EXTRA_MIME.get(ext);
        if (m == null) m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m != null ? m : "application/octet-stream";
    }

    private File file(Uri uri) throws FileNotFoundException {
        String n = uri.getLastPathSegment();
        if (n == null || n.contains("/") || n.startsWith(".")) throw new FileNotFoundException();
        File f = new File(dir(getContext()), n);
        if (!f.isFile()) throw new FileNotFoundException(n);
        return f;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        String n = uri.getLastPathSegment();
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
