package com.nikhil.officetv;

import android.annotation.TargetApi;
import android.app.Activity;
import android.app.ActivityManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Typeface;
import android.graphics.pdf.PdfRenderer;
import android.media.ExifInterface;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.MediaController;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.VideoView;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/**
 * Office TV's own full-screen viewer, used when no other app on the TV can open a link or file, so the TV
 * shows the content (or a friendly explanation) instead of an error. Modes: web, pdf, image, video, audio,
 * text and office (explains how to get an office app).
 */
public class ViewerActivity extends Activity {
    static final String MODE_WEB = "web";
    static final String MODE_PDF = "pdf";
    static final String MODE_IMAGE = "image";
    static final String MODE_VIDEO = "video";
    static final String MODE_AUDIO = "audio";
    static final String MODE_TEXT = "text";
    static final String MODE_OFFICE = "office";

    static final String EXTRA_MODE = "com.nikhil.officetv.MODE";
    static final String EXTRA_TITLE = "com.nikhil.officetv.TITLE";
    /** Optional absolute path of the file (lets image mode read the photo's rotation). */
    static final String EXTRA_PATH = "com.nikhil.officetv.PATH";

    static final String WPS_PACKAGE = "cn.wps.moffice_eng";

    private static final int BG = UiKit.BG;
    private static final int FG = UiKit.FG;
    private static final int MUTED = UiKit.MUTED;
    private static final int SCRIM = UiKit.SCRIM;
    /** Desktop Chrome, so Gmail / Drive / Sheets and other sites render their full computer layout. */
    static final String DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
            + "Chrome/124.0.0.0 Safari/537.36";
    private static final int MAX_TEXT_BYTES = 512 * 1024;
    private static final long SEEK_MS = 10000;

    /** The viewer that is currently in front (resumed), or null. Actions uses it to drive the viewer. */
    static volatile ViewerActivity current;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private volatile String mode = "";
    /** Bumped for every new content, so late results from background threads are dropped. */
    private int generation;
    private boolean destroyed;
    private TextView hint;
    private View overlay;

    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private TextView progress;
    private Bitmap poster;

    private PdfPager pager;
    private ImageView pageView;
    private Bitmap shown;
    private TextView indicator;
    private TextView loading;
    private int page;
    private int pages;

    private VideoView video;
    private MediaController controller;

    private ScrollView textScroll;

    // ---------------------------------------------------------------- entry points

    /** Intent that shows uri in the given mode (see modeFor). */
    static Intent intent(Context c, String mode, Uri uri, String mime, String title) {
        Intent i = new Intent(c, ViewerActivity.class);
        i.setData(uri);
        i.putExtra(EXTRA_MODE, mode);
        if (mime != null) i.putExtra("mime", mime);
        if (title != null) i.putExtra(EXTRA_TITLE, title);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return i;
    }

    /** Viewer mode for a file's MIME type; unknown types get the office explanation. */
    static String modeFor(String mime) {
        String m = mime == null ? "" : mime.toLowerCase(Locale.US);
        if (m.equals("application/pdf")) return MODE_PDF;
        if (m.equals("image/svg+xml") || m.equals("text/html") || m.equals("application/xhtml+xml")) return MODE_WEB;
        if (m.startsWith("image/")) return MODE_IMAGE;
        if (m.startsWith("video/")) return MODE_VIDEO;
        if (m.startsWith("audio/")) return MODE_AUDIO;
        if (m.startsWith("text/") || m.equals("application/json") || m.equals("application/xml")) return MODE_TEXT;
        return MODE_OFFICE;
    }

    /** The viewer in front, or null. */
    static ViewerActivity front() {
        return current;
    }

    // ---------------------------------------------------------------- remote hooks (any thread)

    void next() {
        runOnUiThread(() -> step(1));
    }

    void prev() {
        runOnUiThread(() -> step(-1));
    }

    void close() {
        runOnUiThread(this::finish);
    }

    void back() {
        runOnUiThread(this::onBackPressed);
    }

    void scroll(final boolean down) {
        runOnUiThread(() -> {
            if (web != null && customView == null) {
                if (down) web.pageDown(false);
                else web.pageUp(false);
            } else if (textScroll != null) {
                textScroll.pageScroll(down ? View.FOCUS_DOWN : View.FOCUS_UP);
            } else if (MODE_PDF.equals(mode)) {
                step(down ? 1 : -1);
            }
        });
    }

    /** Runs a remote key if it makes sense for what is on screen. Returns the reply text, or null if not handled. */
    String handleKey(String key) {
        String m = mode;
        boolean media = MODE_VIDEO.equals(m) || MODE_AUDIO.equals(m);
        boolean paged = MODE_PDF.equals(m);
        switch (key == null ? "" : key) {
            case "next_slide": next(); return paged ? "Next page" : "Forward";
            case "prev_slide": prev(); return paged ? "Previous page" : "Back";
            case "scroll_down": scroll(true); return "Scrolled down";
            case "scroll_up": scroll(false); return "Scrolled up";
            case "back": back(); return "Back";
            case "play_pause":
                if (!media) return null;
                runOnUiThread(this::togglePlay);
                return "Play/Pause";
            case "next":
                if (!media && !paged) return null;
                next();
                return "Next";
            case "previous":
                if (!media && !paged) return null;
                prev();
                return "Previous";
            default: return null;
        }
    }

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        } catch (RuntimeException ignored) {
        }
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        show(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        show(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        current = this;
        if (web != null) {
            try {
                web.onResume();
            } catch (RuntimeException ignored) {
            }
        }
    }

    @Override
    protected void onPause() {
        if (current == this) current = null;
        if (web != null) {
            try {
                web.onPause();
            } catch (RuntimeException ignored) {
            }
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        if (current == this) current = null;
        teardown();
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        kit = null;
        // The screen size may have changed: re-render the PDF page to fit.
        if (MODE_PDF.equals(mode) && pages > 0) root.post(() -> showPage(page));
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (customView != null) {
            hideCustomView();
            return;
        }
        // An error overlay on a web page: Back leaves it like the page itself (history, then close).
        removeOverlay();
        if (web != null) {
            try {
                if (web.canGoBack()) {
                    web.goBack();
                    return;
                }
            } catch (RuntimeException ignored) {
            }
        }
        finish();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        if (MODE_PDF.equals(mode) && pages > 0 && overlay == null) {
            int dir = pageDirection(code);
            if (dir != 0) {
                if (e.getAction() == KeyEvent.ACTION_DOWN) step(dir);
                return true;
            }
        }
        if (video != null && e.getAction() == KeyEvent.ACTION_DOWN) {
            switch (code) {
                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                case KeyEvent.KEYCODE_HEADSETHOOK:
                    togglePlay();
                    return true;
                case KeyEvent.KEYCODE_MEDIA_PLAY:
                    video.start();
                    return true;
                case KeyEvent.KEYCODE_MEDIA_PAUSE:
                case KeyEvent.KEYCODE_MEDIA_STOP:
                    video.pause();
                    return true;
                case KeyEvent.KEYCODE_MEDIA_NEXT:
                case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                    seekBy(SEEK_MS);
                    return true;
                case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                case KeyEvent.KEYCODE_MEDIA_REWIND:
                    seekBy(-SEEK_MS);
                    return true;
                default:
                    break;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    private static int pageDirection(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_RIGHT:
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_PAGE_DOWN:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_SPACE:
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
                return 1;
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_PAGE_UP:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                return -1;
            default:
                return 0;
        }
    }

    // ---------------------------------------------------------------- content

    private void show(Intent i) {
        teardown();
        generation++;
        String m = i == null ? null : i.getStringExtra(EXTRA_MODE);
        mode = m == null ? "" : m;
        Uri uri = i == null ? null : i.getData();
        String title = i == null ? null : i.getStringExtra(EXTRA_TITLE);
        String path = i == null ? null : i.getStringExtra(EXTRA_PATH);
        try {
            if (uri == null && !MODE_OFFICE.equals(mode)) {
                showMessage("Nothing to show", "Please send the link or file again.");
                return;
            }
            switch (mode) {
                case MODE_WEB: showWeb(uri); break;
                case MODE_PDF: showPdf(uri); break;
                case MODE_IMAGE: showImage(uri, path); break;
                case MODE_VIDEO: showMedia(uri, title, false); break;
                case MODE_AUDIO: showMedia(uri, title, true); break;
                case MODE_TEXT: showText(uri); break;
                default: showOffice(title); break;
            }
        } catch (Throwable t) {
            CrashLog.note(this, "Viewer " + mode + ": " + t);
            teardown();
            showMessage("This could not be opened on the TV", "Something went wrong. Try sending the link or file again.");
        }
    }

    /** Releases whatever is on screen (WebView, PDF renderer, player, bitmaps). */
    private void teardown() {
        ui.removeCallbacksAndMessages(null);
        if (customView != null) hideCustomView();
        if (controller != null) {
            try {
                controller.hide();
            } catch (RuntimeException ignored) {
            }
            controller = null;
        }
        if (video != null) {
            try {
                video.stopPlayback();
            } catch (RuntimeException ignored) {
            }
            video = null;
        }
        if (web != null) {
            WebView w = web;
            web = null;
            try {
                w.stopLoading();
                if (root != null) root.removeView(w);
                w.destroy();
            } catch (Throwable ignored) {
            }
        }
        if (pager != null) {
            pager.close();
            pager = null;
        }
        if (pageView != null) pageView.setImageDrawable(null);
        if (shown != null) {
            shown.recycle();
            shown = null;
        }
        pageView = null;
        indicator = null;
        loading = null;
        progress = null;
        textScroll = null;
        hint = null;
        overlay = null;
        page = 0;
        pages = 0;
        if (root != null) root.removeAllViews();
    }

    private void step(int dir) {
        if (destroyed) return;
        switch (mode) {
            case MODE_PDF:
                showPage(page + dir);
                break;
            case MODE_WEB:
                pressInPage(dir > 0 ? KeyEvent.KEYCODE_PAGE_DOWN : KeyEvent.KEYCODE_PAGE_UP);
                break;
            case MODE_VIDEO:
            case MODE_AUDIO:
                seekBy(dir * SEEK_MS);
                break;
            case MODE_TEXT:
                if (textScroll != null) textScroll.pageScroll(dir > 0 ? View.FOCUS_DOWN : View.FOCUS_UP);
                break;
            default:
                break;
        }
    }

    // ---------------------------------------------------------------- web

    private void showWeb(Uri uri) {
        WebView w;
        try {
            w = new WebView(this);
        } catch (Throwable t) {
            // No WebView provider installed / disabled / being updated: explain instead of crashing.
            CrashLog.note(this, "WebView could not be created: " + t);
            noWebView();
            return;
        }
        web = w;
        try {
            setUpWeb(w);
            root.addView(w, match());
            progress = label("Loading…", 18, FG, false);
            chip(progress);
            root.addView(progress, wrap(Gravity.TOP | Gravity.END, 16));
            w.requestFocus();
            w.loadUrl(uri.toString());
        } catch (Throwable t) {
            CrashLog.note(this, "WebView setup: " + t);
            teardown();
            noWebView();
        }
    }

    private void noWebView() {
        showMessage("Web page could not be opened",
                "This TV does not have the component that shows web pages (Android System WebView), or it is turned off.\n\n"
                        + "Install \u201cAndroid System WebView\u201d or a browser such as Chrome from the TV's Play Store.");
    }

    private void setUpWeb(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setUserAgentString(DESKTOP_UA);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        try {
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            cm.setAcceptThirdPartyCookies(w, true);
        } catch (RuntimeException ignored) {
        }
        w.setFocusable(true);
        w.setFocusableInTouchMode(true);
        w.setWebViewClient(new Client());
        w.setWebChromeClient(new Chrome());
        w.setDownloadListener((url, agent, disposition, mime, length) -> openOutside(url, null,
                "Downloads are not possible on this TV. Send the file through Office TV instead."));
    }

    /** Sends a key press to the page (or its fullscreen video), e.g. PageDown for the next slide. */
    private void pressInPage(int code) {
        View target = customView != null ? customView : web;
        if (target == null) return;
        long t = SystemClock.uptimeMillis();
        target.dispatchKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0));
        target.dispatchKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_UP, code, 0));
    }

    /** Links that need another app (intent:, market:, zoomus:, mailto: ...). Always returns true (handled). */
    private boolean openSpecial(WebView v, String url) {
        Uri u = Uri.parse(url);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.US);
        Intent i;
        try {
            if (scheme.equals("intent")) {
                i = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                i.addCategory(Intent.CATEGORY_BROWSABLE);
                i.setComponent(null);
                i.setSelector(null);
            } else {
                i = new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE);
            }
        } catch (Throwable t) {
            hint("This link cannot be opened on the TV.");
            return true;
        }
        if (tryStart(i)) return true;
        String fallback = i.getStringExtra("browser_fallback_url");
        if (fallback != null && fallback.matches("(?i)^https?://.*")) {
            v.loadUrl(fallback);
        } else if (scheme.equals("market") && u.getEncodedQuery() != null) {
            v.loadUrl("https://play.google.com/store/apps/details?" + u.getEncodedQuery());
        } else {
            hint("No app on this TV can open this link.");
        }
        return true;
    }

    private void openOutside(String url, String okHint, String failHint) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        if (tryStart(i)) {
            if (okHint != null) hint(okHint);
        } else {
            hint(failHint);
        }
    }

    private final class Client extends WebViewClient {
        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView v, String url) {
            if (url == null) return false;
            String lower = url.toLowerCase(Locale.US);
            if (lower.startsWith("http:") || lower.startsWith("https:") || lower.startsWith("about:")
                    || lower.startsWith("data:") || lower.startsWith("blob:") || lower.startsWith("javascript:")
                    || lower.startsWith("content:")) {
                return false;
            }
            return openSpecial(v, url);
        }

        @Override
        public void onPageStarted(WebView v, String url, Bitmap favicon) {
            if (progress != null) {
                progress.setText("Loading…");
                progress.setVisibility(View.VISIBLE);
            }
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            if (progress != null) progress.setVisibility(View.GONE);
        }

        /** Main-frame errors on every Android version (the API 23 variant calls this one for the main frame). */
        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView v, int code, String description, String failingUrl) {
            if (v != web) return;
            showOverlay("Page did not load", "Check the internet connection, then press \u201cTry again\u201d."
                    + (description == null ? "" : "\n\n(" + description + ")"), true);
        }

        @Override
        public void onReceivedSslError(WebView v, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (v != web) return;
            showOverlay("Website security check failed",
                    "Is the TV's date and time correct? Check it in the TV Settings, then press \u201cTry again\u201d.", true);
        }

        /** Without this, a crashed web renderer takes the whole app down on Android 8+. */
        @Override
        @TargetApi(26)
        public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
            CrashLog.note(ViewerActivity.this, "WebView renderer stopped (crash=" + detail.didCrash() + ")");
            if (v == web) {
                web = null;
                try {
                    root.removeView(v);
                    v.destroy();
                } catch (Throwable ignored) {
                }
                ui.post(() -> {
                    if (destroyed) return;
                    teardown();
                    LinearLayout col = showMessage("The page stopped",
                            "The TV ran low on memory. Press \u201cTry again\u201d.");
                    col.addView(button("Try again", x -> show(getIntent())), 2);
                    focusFirst(col);
                });
            } else {
                try {
                    v.destroy();
                } catch (Throwable ignored) {
                }
            }
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView v, int p) {
            if (progress == null) return;
            if (p >= 100) {
                progress.setVisibility(View.GONE);
            } else {
                progress.setVisibility(View.VISIBLE);
                progress.setText("Loading… " + p + "%");
            }
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback cb) {
            if (customView != null || web == null) {
                cb.onCustomViewHidden();
                return;
            }
            customView = view;
            customCallback = cb;
            root.addView(view, match());
            web.setVisibility(View.INVISIBLE);
            view.requestFocus();
        }

        @Override
        public void onHideCustomView() {
            hideCustomView();
        }

        /** Some WebView versions crash or show a broken icon when this returns null. */
        @Override
        public Bitmap getDefaultVideoPoster() {
            if (poster == null) {
                try {
                    poster = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
                } catch (Throwable ignored) {
                }
            }
            return poster;
        }
    }

    private void hideCustomView() {
        View v = customView;
        if (v == null) return;
        customView = null;
        try {
            root.removeView(v);
        } catch (RuntimeException ignored) {
        }
        if (web != null) {
            web.setVisibility(View.VISIBLE);
            web.requestFocus();
        }
        WebChromeClient.CustomViewCallback cb = customCallback;
        customCallback = null;
        if (cb != null) {
            try {
                cb.onCustomViewHidden();
            } catch (Throwable ignored) {
            }
        }
    }

    // ---------------------------------------------------------------- pdf

    private void showPdf(Uri uri) {
        pageView = new ImageView(this);
        pageView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        pageView.setBackgroundColor(Color.parseColor("#202020"));
        root.addView(pageView, match());
        attachSwipe(pageView);

        indicator = label("", 22, Color.WHITE, true);
        chip(indicator);
        indicator.setPadding(kit().dp(18), kit().dp(8), kit().dp(18), kit().dp(8));
        indicator.setVisibility(View.GONE);
        root.addView(indicator, wrap(Gravity.BOTTOM | Gravity.END, 16));

        loading = label("Opening PDF…", 28, FG, false);
        root.addView(loading, wrap(Gravity.CENTER, 0));
        addCloseChip();

        pager = new PdfPager(uri, generation);
        pager.open();
    }

    private void showPage(int index) {
        if (pager == null || pages <= 0) return;
        if (index < 0 || index >= pages) {
            hint(index < 0 ? "This is the first page." : "This is the last page.");
            return;
        }
        page = index;
        if (indicator != null) {
            indicator.setText((page + 1) + " / " + pages);
            indicator.setVisibility(View.VISIBLE);
        }
        int w = root.getWidth(), h = root.getHeight();
        if (w <= 0 || h <= 0) {
            DisplayMetrics dm = screen();
            w = dm.widthPixels;
            h = dm.heightPixels;
        }
        pager.render(page, w, h, maxPixels());
    }

    private void onPdfOpened(int gen, int count) {
        if (gen != generation || destroyed) return;
        pages = count;
        if (count <= 0) {
            teardown();
            showMessage("The PDF is empty", "This PDF has no pages.");
            return;
        }
        showPage(0);
        if (count > 1) hint("Use Left / Right on the remote, or swipe, to change pages.");
    }

    private void onPdfPage(int gen, int index, Bitmap b) {
        if (gen != generation || destroyed || pageView == null || index != page) {
            b.recycle();
            return;
        }
        if (loading != null) {
            root.removeView(loading);
            loading = null;
        }
        final Bitmap old = shown;
        pageView.setImageBitmap(b);
        shown = b;
        // Recycle a little later: the last frame may still be drawing the old page.
        if (old != null) ui.postDelayed(old::recycle, 500);
    }

    private void onPdfError(int gen, String msg) {
        if (gen != generation || destroyed) return;
        teardown();
        showMessage("PDF could not be opened", msg);
    }

    /** Owns the PdfRenderer; all rendering happens on its own thread, newest request wins. */
    private final class PdfPager {
        private final HandlerThread thread = new HandlerThread("officetv-pdf");
        private final Handler worker;
        private final Uri uri;
        private final int gen;
        private final Runnable renderTask = this::renderWanted;
        private ParcelFileDescriptor fd;
        private PdfRenderer renderer;
        private volatile boolean closed;
        private volatile int wanted = -1;
        private volatile int targetW = 1280;
        private volatile int targetH = 720;
        private volatile long maxPx = 2000000;

        PdfPager(Uri uri, int gen) {
            this.uri = uri;
            this.gen = gen;
            thread.start();
            worker = new Handler(thread.getLooper());
        }

        void open() {
            worker.post(() -> {
                try {
                    fd = getContentResolver().openFileDescriptor(uri, "r");
                    if (fd == null) throw new FileNotFoundException(String.valueOf(uri));
                    renderer = new PdfRenderer(fd);
                    final int n = renderer.getPageCount();
                    ui.post(() -> onPdfOpened(gen, n));
                } catch (SecurityException e) {
                    fail("This PDF is password-protected. Please send a PDF without a password.");
                } catch (FileNotFoundException e) {
                    fail("The PDF file was not found. Please send it again.");
                } catch (Throwable e) {
                    CrashLog.note(ViewerActivity.this, "PDF open: " + e);
                    fail("This PDF will not open (the file may be damaged). Try sending it again.");
                }
            });
        }

        void render(int index, int w, int h, long maxPixels) {
            wanted = index;
            targetW = Math.max(1, w);
            targetH = Math.max(1, h);
            maxPx = maxPixels;
            worker.removeCallbacks(renderTask);
            worker.post(renderTask);
        }

        private void renderWanted() {
            final int index = wanted;
            if (closed || renderer == null || index < 0) return;
            Bitmap b;
            try {
                b = renderPage(index, 1f);
            } catch (OutOfMemoryError e) {
                try {
                    b = renderPage(index, 0.5f);
                } catch (Throwable t) {
                    fail("The TV is low on memory, so this page could not be shown.");
                    return;
                }
            } catch (Throwable t) {
                if (!closed) {
                    CrashLog.note(ViewerActivity.this, "PDF page " + index + ": " + t);
                    fail("This PDF page could not be shown (the file may be damaged).");
                }
                return;
            }
            final Bitmap out = b;
            ui.post(() -> onPdfPage(gen, index, out));
        }

        private Bitmap renderPage(int index, float quality) {
            PdfRenderer.Page p = renderer.openPage(index);
            try {
                float pw = Math.max(1, p.getWidth()), ph = Math.max(1, p.getHeight());
                float scale = Math.min(targetW / pw, targetH / ph) * quality;
                int w = Math.max(1, Math.round(pw * scale));
                int h = Math.max(1, Math.round(ph * scale));
                double px = (double) w * h;
                if (px > maxPx) {
                    double f = Math.sqrt(maxPx / px);
                    w = Math.max(1, (int) (w * f));
                    h = Math.max(1, (int) (h * f));
                }
                Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                b.eraseColor(Color.WHITE);
                p.render(b, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                return b;
            } finally {
                p.close();
            }
        }

        private void fail(final String msg) {
            ui.post(() -> onPdfError(gen, msg));
        }

        void close() {
            closed = true;
            worker.removeCallbacks(renderTask);
            worker.post(() -> {
                try {
                    if (renderer != null) renderer.close();
                } catch (Throwable ignored) {
                }
                try {
                    if (fd != null) fd.close();
                } catch (Throwable ignored) {
                }
                renderer = null;
                fd = null;
            });
            thread.quitSafely();
        }
    }

    /** Swipe left/up or tap the right third: next page. Swipe right/down or tap the left third: previous. */
    private void attachSwipe(final View v) {
        final GestureDetector gd = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent e) {
                return true;
            }

            @Override
            public boolean onFling(MotionEvent a, MotionEvent b, float vx, float vy) {
                if (a == null || b == null) return false;
                float dx = b.getX() - a.getX(), dy = b.getY() - a.getY();
                int min = dp(60);
                if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > min) step(dx < 0 ? 1 : -1);
                else if (Math.abs(dy) > min) step(dy < 0 ? 1 : -1);
                else return false;
                return true;
            }

            @Override
            public boolean onSingleTapUp(MotionEvent e) {
                float w = v.getWidth();
                if (e.getX() < w / 3) step(-1);
                else if (e.getX() > w * 2 / 3) step(1);
                return true;
            }
        });
        v.setOnTouchListener((view, ev) -> gd.onTouchEvent(ev));
    }

    // ---------------------------------------------------------------- image

    private void showImage(final Uri uri, final String path) {
        pageView = new ImageView(this);
        pageView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        pageView.setBackgroundColor(Color.BLACK);
        root.addView(pageView, match());
        loading = label("Opening photo…", 28, FG, false);
        root.addView(loading, wrap(Gravity.CENTER, 0));
        addCloseChip();

        final int gen = generation;
        DisplayMetrics dm = screen();
        final int tw = Math.max(1, dm.widthPixels), th = Math.max(1, dm.heightPixels);
        final long maxPx = maxPixels();
        new Thread(() -> {
            Bitmap b = null;
            String err = null;
            try {
                b = decodeImage(uri, path, tw, th, maxPx);
                if (b == null) err = "This photo format is not supported on the TV. Please send a JPG or PNG.";
            } catch (OutOfMemoryError e) {
                err = "This photo is too large for the TV. Please send a smaller one.";
            } catch (Throwable t) {
                CrashLog.note(ViewerActivity.this, "Image: " + t);
                err = "This photo could not be opened on the TV. Please send a JPG or PNG.";
            }
            final Bitmap out = b;
            final String error = err;
            ui.post(() -> onImage(gen, out, error));
        }, "officetv-image").start();
    }

    private void onImage(int gen, Bitmap b, String error) {
        if (gen != generation || destroyed || pageView == null) {
            if (b != null) b.recycle();
            return;
        }
        if (b == null) {
            teardown();
            showMessage("Photo could not be opened", error);
            return;
        }
        if (loading != null) {
            root.removeView(loading);
            loading = null;
        }
        pageView.setImageBitmap(b);
        shown = b;
    }

    /** Decodes with inSampleSize so even a 4K/8K photo fits in memory, then applies the EXIF rotation. */
    private Bitmap decodeImage(Uri uri, String path, int tw, int th, long maxPx) throws IOException {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            BitmapFactory.decodeStream(in, null, o);
        }
        if (o.outWidth <= 0 || o.outHeight <= 0) return null;
        int sample = 1;
        while (o.outWidth / (sample * 2) >= tw && o.outHeight / (sample * 2) >= th) sample *= 2;
        while ((long) (o.outWidth / sample) * (o.outHeight / sample) > maxPx) sample *= 2;
        BitmapFactory.Options d = new BitmapFactory.Options();
        d.inSampleSize = sample;
        d.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap b;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            b = BitmapFactory.decodeStream(in, null, d);
        }
        if (b == null) return null;
        int deg = exifRotation(path);
        if (deg == 0) return b;
        try {
            Matrix m = new Matrix();
            m.postRotate(deg);
            Bitmap r = Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true);
            if (r != b) b.recycle();
            return r;
        } catch (OutOfMemoryError e) {
            return b;
        }
    }

    private static int exifRotation(String path) {
        if (path == null) return 0;
        try {
            int o = new ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL);
            switch (o) {
                case ExifInterface.ORIENTATION_ROTATE_90: return 90;
                case ExifInterface.ORIENTATION_ROTATE_180: return 180;
                case ExifInterface.ORIENTATION_ROTATE_270: return 270;
                default: return 0;
            }
        } catch (Throwable t) {
            return 0;
        }
    }

    // ---------------------------------------------------------------- video / audio

    private void showMedia(Uri uri, String title, final boolean audio) {
        if (audio) {
            TextView name = label("Now playing\n" + (title == null ? "" : title), 32, FG, true);
            root.addView(name, wrap(Gravity.CENTER, 0));
        }
        final VideoView v = new VideoView(this);
        video = v;
        FrameLayout.LayoutParams lp = audio
                ? new FrameLayout.LayoutParams(1, 1, Gravity.CENTER)
                : new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER);
        root.addView(v, lp);
        loading = label(audio ? "Opening audio…" : "Opening video…", 28, FG, false);
        root.addView(loading, wrap(audio ? Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL : Gravity.CENTER, 48));
        addCloseChip();

        controller = new MediaController(this);
        v.setMediaController(controller);
        final int gen = generation;
        v.setOnPreparedListener(mp -> {
            if (gen != generation || destroyed) return;
            if (loading != null) {
                root.removeView(loading);
                loading = null;
            }
            v.start();
            showController(3000);
        });
        v.setOnErrorListener((mp, what, extra) -> {
            CrashLog.note(this, "Media error " + what + "/" + extra);
            ui.post(() -> {
                if (gen != generation || destroyed) return;
                teardown();
                showMessage(audio ? "Audio could not be played" : "Video could not be played", audio
                        ? "This audio could not be played on the TV. Try sending an MP3 file."
                        : "This video format is not supported on the TV. Send an MP4 (H.264) file, "
                                + "or a YouTube / Google Drive link.");
            });
            return true; // true = no system "Can't play this video" dialog
        });
        v.setOnCompletionListener(mp -> {
            if (gen != generation || destroyed) return;
            hint("Finished. Press Play to watch again.");
            showController(0);
        });
        v.setFocusable(true);
        v.setFocusableInTouchMode(true);
        v.setVideoURI(uri);
        v.requestFocus();
    }

    private void showController(int ms) {
        if (controller == null || destroyed) return;
        try {
            controller.show(ms);
        } catch (RuntimeException ignored) {
            // BadTokenException if the window is not attached yet.
        }
    }

    private void togglePlay() {
        if (video == null) return;
        try {
            if (video.isPlaying()) video.pause();
            else video.start();
            showController(3000);
        } catch (RuntimeException ignored) {
        }
    }

    private void seekBy(long ms) {
        if (video == null) return;
        try {
            int pos = video.getCurrentPosition(), dur = video.getDuration();
            long to = Math.max(0, pos + ms);
            if (dur > 0) to = Math.min(to, dur - 500L);
            video.seekTo((int) Math.max(0, to));
            showController(3000);
        } catch (RuntimeException ignored) {
        }
    }

    // ---------------------------------------------------------------- text

    private void showText(final Uri uri) {
        final ScrollView sv = new ScrollView(this);
        textScroll = sv;
        sv.setBackgroundColor(BG);
        sv.setFocusable(true);
        final TextView t = label("Loading…", 22, FG, false);
        t.setGravity(Gravity.START);
        t.setPadding(dp(48), dp(32), dp(48), dp(32));
        sv.addView(t);
        root.addView(sv, match());
        addCloseChip();
        sv.requestFocus();
        final int gen = generation;
        new Thread(() -> {
            String text;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) throw new FileNotFoundException();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0 && out.size() < MAX_TEXT_BYTES) out.write(buf, 0, n);
                text = out.toString("UTF-8");
                if (out.size() >= MAX_TEXT_BYTES) text += "\n\n… (the file is very long; the rest is not shown)";
            } catch (Throwable e) {
                text = "The file could not be read. Please send it again.";
            }
            final String s = text;
            ui.post(() -> {
                if (gen == generation && !destroyed) t.setText(s);
            });
        }, "officetv-text").start();
    }

    // ---------------------------------------------------------------- office / no app

    private void showOffice(String title) {
        String name = title == null || title.trim().isEmpty() ? "This file" : "\u201c" + title + "\u201d";
        LinearLayout col = showMessage("No app on this TV can open this file",
                name + " needs a PowerPoint / Word / Excel app on the TV.\n\n"
                        + "1. Install WPS Office with the button below, then send the file again.\n\n"
                        + "2. Or put the file on Google Drive / Google Slides and send its link. "
                        + "The link opens directly on the TV.");
        col.addView(button("Install WPS Office", v -> installWps()), 2);
        focusFirst(col);
    }

    private void installWps() {
        if (tryStart(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + WPS_PACKAGE)))) return;
        if (tryStart(new Intent(Intent.ACTION_VIEW,
                Uri.parse("https://play.google.com/store/apps/details?id=" + WPS_PACKAGE)))) {
            return;
        }
        hint("No Play Store on this TV. Install the WPS Office APK from a USB drive.");
    }

    /** startActivity that never throws; false if no real app (not just an Android TV stub) handled it. */
    private boolean tryStart(Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (Actions.onlyStubs(this, i)) return false;
            startActivity(i);
            return true;
        } catch (ActivityNotFoundException | SecurityException e) {
            return false;
        } catch (RuntimeException e) {
            CrashLog.note(this, "startActivity: " + e);
            return false;
        }
    }

    // ---------------------------------------------------------------- messages and small UI helpers

    /**
     * Replaces the screen with a big, centered message and focuses its button. Returns the column
     * (children: title, body, close button); callers insert extra buttons at index 2 and call focusFirst again.
     */
    private LinearLayout showMessage(String title, String body) {
        View v = messageView(title, body, false);
        root.addView(v, match());
        LinearLayout col = (LinearLayout) ((FrameLayout) ((ScrollView) v).getChildAt(0)).getChildAt(0);
        focusFirst(col);
        return col;
    }

    /** A message on top of the web page, with an optional retry button. */
    private void showOverlay(String title, String body, boolean retry) {
        removeOverlay();
        View v = messageView(title, body, true);
        LinearLayout col = (LinearLayout) ((FrameLayout) ((ScrollView) v).getChildAt(0)).getChildAt(0);
        if (retry) {
            col.addView(button("Try again", x -> {
                removeOverlay();
                if (web != null) {
                    web.reload();
                    web.requestFocus();
                }
            }), 2);
        }
        overlay = v;
        root.addView(v, match());
        focusFirst(col);
    }

    private void removeOverlay() {
        if (overlay != null) {
            root.removeView(overlay);
            overlay = null;
        }
    }

    private View messageView(String title, String body, boolean overlayStyle) {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        UiKit k = kit();
        col.setPadding(k.dp(56), k.dp(40), k.dp(56), k.dp(40));
        col.setBackground(k.card());
        TextView tt = label(title, 28, Color.WHITE, true);
        tt.setGravity(Gravity.CENTER_HORIZONTAL);
        col.addView(tt, margins(0, 0, 0, 0));
        TextView b = label(body, 19, FG, false);
        b.setLineSpacing(0, 1.2f);
        b.setGravity(Gravity.CENTER_HORIZONTAL);
        col.addView(b, margins(0, k.dp(18), 0, k.dp(10)));
        col.addView(button("Close", x -> finish()), margins(0, k.dp(12), 0, 0));
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        // The card sits centred, at most ~900dp wide so lines stay readable on 4K; it scrolls if tall.
        FrameLayout holder = new FrameLayout(this);
        int maxW = Math.min(screen().widthPixels - k.dp(48), k.dp(900));
        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(maxW, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER);
        clp.setMargins(0, k.dp(24), 0, k.dp(24));
        holder.addView(col, clp);
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        sv.setBackgroundColor(overlayStyle ? Color.parseColor("#F20B1220") : BG);
        sv.addView(holder, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        return sv;
    }

    /** Short message at the bottom of the screen that hides itself. */
    private void hint(String s) {
        if (destroyed || root == null) return;
        if (hint == null) {
            hint = label("", 18, Color.WHITE, false);
            chip(hint);
            hint.setPadding(kit().dp(22), kit().dp(12), kit().dp(22), kit().dp(12));
            hint.setMaxWidth(Math.round(screen().widthPixels * 0.8f));
        }
        if (hint.getParent() == null) {
            FrameLayout.LayoutParams lp = wrap(Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL, 32);
            // Sit above the page indicator / media controls so the two never overlap.
            lp.bottomMargin = kit().dp(indicator != null || video != null ? 96 : 40);
            root.addView(hint, lp);
        }
        hint.setText(s);
        hint.setVisibility(View.VISIBLE);
        hint.bringToFront();
        ui.removeCallbacks(hideHint);
        ui.postDelayed(hideHint, 5000);
    }

    private final Runnable hideHint = () -> {
        if (hint != null) hint.setVisibility(View.GONE);
    };

    /** Small touch-only "close" chip; not focusable so the remote's D-pad keeps changing pages. */
    private void addCloseChip() {
        String title = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_TITLE);
        if (title != null && !title.trim().isEmpty()) {
            TextView t = label(title.trim(), 16, FG, true);
            chip(t);
            t.setSingleLine(true);
            t.setEllipsize(android.text.TextUtils.TruncateAt.END);
            // At most half the width, so it can never run into the Close chip on the right.
            t.setMaxWidth(Math.round(screen().widthPixels * 0.5f));
            t.setFocusable(false);
            root.addView(t, wrap(Gravity.TOP | Gravity.START, 16));
        }
        TextView x = label("✕  Close", 16, Color.WHITE, true);
        chip(x);
        x.setFocusable(false);
        x.setClickable(true);
        x.setOnClickListener(v -> finish());
        root.addView(x, wrap(Gravity.TOP | Gravity.END, 16));
    }

    private void focusFirst(final LinearLayout col) {
        for (int i = 0; i < col.getChildCount(); i++) {
            final View v = col.getChildAt(i);
            if (v instanceof Button) {
                v.post(v::requestFocus);
                return;
            }
        }
    }

    private Button button(String text, View.OnClickListener l) {
        UiKit k = kit();
        Button b = k.button(text, 20, true, l);
        b.setPadding(k.dp(32), k.dp(12), k.dp(32), k.dp(12));
        return b;
    }

    private UiKit kit;

    /** Created lazily (the display may change between contents). */
    private UiKit kit() {
        if (kit == null) kit = new UiKit(this);
        return kit;
    }

    /** Rounded translucent pill used for the page indicator, hints, title and Close. */
    private void chip(TextView t) {
        UiKit k = kit();
        t.setBackground(k.rounded(SCRIM, UiKit.LINE, 14, 1));
        t.setPadding(k.dp(14), k.dp(8), k.dp(14), k.dp(8));
    }

    private TextView label(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, kit().sp(sp));
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private static FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private FrameLayout.LayoutParams wrap(int gravity, int marginDp) {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT, gravity);
        int m = dp(marginDp);
        lp.setMargins(m, m, m, m);
        return lp;
    }

    private static LinearLayout.LayoutParams margins(int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(l, t, r, b);
        return lp;
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** Full screen size in pixels. */
    private DisplayMetrics screen() {
        DisplayMetrics dm = new DisplayMetrics();
        try {
            getWindowManager().getDefaultDisplay().getRealMetrics(dm);
        } catch (RuntimeException ignored) {
        }
        if (dm.widthPixels <= 0 || dm.heightPixels <= 0) dm = getResources().getDisplayMetrics();
        return dm;
    }

    /** Biggest bitmap we allow, by heap size (ARGB_8888: 4 bytes per pixel). */
    private long maxPixels() {
        int mb = 128;
        try {
            ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null) mb = am.getMemoryClass();
        } catch (RuntimeException ignored) {
        }
        if (mb >= 192) return 4200000L;
        if (mb >= 96) return 2400000L;
        return 1300000L;
    }
}
