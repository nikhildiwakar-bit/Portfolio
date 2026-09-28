package com.nikhil.officetv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.nikhil.officetv.relay.Pairing;

import java.lang.ref.WeakReference;

/**
 * Full-screen receiver for "Share my screen" (PROTOCOL.md section 8). A WebView loads the receiver page
 * that is hosted with the website (https, so WebRTC has a secure context). The pairing code and session
 * travel in the URL fragment, which the WebView never sends to any server; the page cannot navigate
 * anywhere else, so the code never reaches another site. The page does the WebRTC signaling itself over
 * the encrypted relay and calls OfficeTvCast.close() when sharing ends.
 *
 * <p>One receiver at a time (singleTask): a new session replaces the old one in place. Back on the remote,
 * the laptop's "Stop sharing", or the end of the stream closes it and returns to Office TV's home screen.
 */
public class CastActivity extends Activity {
    static final String RECEIVER_URL = "https://nikhildiwakar-bit.github.io/Portfolio/tv/receive.html";
    static final String EXTRA_URL = "cast_url";
    static final String EXTRA_SESSION = "cast_session";

    private static final String TAG = "OfficeTV";
    /** The receiver page must finish loading within this time. */
    private static final long LOAD_TIMEOUT_MS = 45000;
    /** How long a problem message stays up before the TV goes back to the home screen. */
    private static final long MESSAGE_MS = 9000;
    /** Cast screen hidden (Home pressed, another app on top) this long: end the cast, free the resources. */
    private static final long HIDDEN_END_MS = 3000;

    // ---------- one receiver at a time: state shared with the relay command thread ----------

    private static final Object LOCK = new Object();
    private static WeakReference<CastActivity> current = new WeakReference<>(null);
    /** Session on screen, "" if none. */
    private static String currentSession = "";
    /** Session a "cast start" asked for whose screen has not opened yet. */
    private static String expected = "";
    /** A "cast stop" arrived before that screen opened: close it as soon as it does. */
    private static String cancelled = "";
    private static Bitmap poster;

    static boolean validSession(String s) {
        return s != null && s.matches("[a-z0-9]{12,32}");
    }

    static String receiverUrl(String session, String code, String relay) {
        StringBuilder b = new StringBuilder(RECEIVER_URL).append("#s=").append(session).append("&code=").append(code);
        if (relay != null && !Pairing.isDefaultRelay(relay)) b.append("&relay=").append(Uri.encode(relay));
        return b.toString();
    }

    static Intent intent(Context c, String url, String session) {
        return new Intent(c, CastActivity.class)
                .putExtra(EXTRA_URL, url)
                .putExtra(EXTRA_SESSION, session)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    /** The session on screen, or "". */
    static String currentSession() {
        synchronized (LOCK) {
            return currentSession;
        }
    }

    /** Called right before the screen is started for a session. */
    static void expect(String session) {
        synchronized (LOCK) {
            expected = session;
            if (session.equals(cancelled)) cancelled = "";
        }
    }

    static void cancelExpected(String session) {
        synchronized (LOCK) {
            if (expected.equals(session)) expected = "";
        }
    }

    /** Waits until the screen for this session is open. False after ms (Android may have refused to open it). */
    static boolean awaitOpened(String session, long ms) {
        long end = System.currentTimeMillis() + ms;
        synchronized (LOCK) {
            while (!session.equals(currentSession)) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) return false;
                try {
                    LOCK.wait(left);
                } catch (InterruptedException e) {
                    return session.equals(currentSession);
                }
            }
            return true;
        }
    }

    /** Closes the receiver if it shows this session (any session when empty). True if one was open or opening. */
    static boolean stop(String session) {
        final CastActivity a;
        synchronized (LOCK) {
            boolean any = session == null || session.isEmpty();
            if (!any && session.equals(expected) && !session.equals(currentSession)) {
                cancelled = session;
                expected = "";
                return true;
            }
            a = current.get();
            if (a == null || currentSession.isEmpty() || (!any && !session.equals(currentSession))) return false;
        }
        a.ui.post(() -> a.end("stopped", true));
        return true;
    }

    // ---------- the screen ----------

    private final Handler ui = new Handler(Looper.getMainLooper());
    private UiKit kit;
    private FrameLayout root;
    private View overlay;
    private TextView overlayTitle, overlayText, overlayHint;
    private WebView web;
    private String session = "";
    private boolean pageLoaded, pageFailed, visible, ending;

    private final Runnable loadTimeout = () -> {
        if (!pageLoaded) {
            fail("Can’t load screen sharing", "The TV could not load the screen sharing page. Check the TV's internet "
                    + "connection, then share again from your laptop.");
        }
    };
    private final Runnable endHidden = () -> end("hidden", false);
    private final Runnable endAfterMessage = () -> end("message", true);

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
        showOverLockScreen(w);
        kit = new UiKit(this);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        overlay = buildOverlay();
        root.addView(overlay, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        synchronized (LOCK) {
            current = new WeakReference<>(this);
        }
        immersive();
        load(getIntent());
    }

    @SuppressWarnings("deprecation")
    private void showOverLockScreen(Window w) {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            w.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        load(intent);
    }

    private void load(Intent intent) {
        String url = intent == null ? null : intent.getStringExtra(EXTRA_URL);
        String s = intent == null ? null : intent.getStringExtra(EXTRA_SESSION);
        if (url == null || !url.startsWith(RECEIVER_URL + "#") || !validSession(s)) {
            if (web == null && !ending) end("invalid", false);
            return;
        }
        synchronized (LOCK) {
            if (s.equals(cancelled)) {
                // The laptop stopped before this screen opened.
                cancelled = "";
                if (web == null) end("cancelled", false);
                return;
            }
            if (s.equals(currentSession) && web != null) return; // same session again: keep it
            session = s;
            currentSession = s;
            if (expected.equals(s)) expected = "";
            LOCK.notifyAll();
        }
        DebugHooks.event("cast=open session=" + s);
        ending = false;
        ui.removeCallbacks(endAfterMessage);
        ui.removeCallbacks(loadTimeout);
        releaseWeb();
        pageLoaded = false;
        pageFailed = false;
        showOverlay("Getting ready…", "Your laptop screen will appear here in a moment.", "");

        WebView w;
        try {
            w = new WebView(this);
        } catch (Throwable t) {
            // No engine installed, or it is disabled or updating (MissingWebViewPackageException and friends).
            CrashLog.note(this, "Cast WebView could not be created: " + t);
            fail("Update needed", "Screen sharing needs “Android System WebView”. Install, turn on or update it "
                    + "in the TV's app store or app settings, then share again.");
            return;
        }
        int major = WebViewInfo.majorFromUserAgent(userAgent(w));
        if (major < 0) major = WebViewInfo.major(WebViewInfo.version(this));
        if (WebViewInfo.tooOld(major)) {
            destroyQuietly(w);
            fail("Update needed", WebViewInfo.tooOldMessage(major));
            return;
        }
        web = w;
        try {
            setUp(w, s);
            // On top of the "Getting ready" text; transparent until the page has drawn its black background.
            root.addView(w, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT));
            w.requestFocus();
            w.loadUrl(url);
            ui.postDelayed(loadTimeout, LOAD_TIMEOUT_MS);
        } catch (Throwable t) {
            CrashLog.note(this, "Cast WebView setup: " + t);
            fail("Can’t show your screen", "Screen sharing could not start on this TV. Please share again from your laptop.");
        }
    }

    private static String userAgent(WebView w) {
        try {
            return w.getSettings().getUserAgentString();
        } catch (Throwable t) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private void setUp(WebView w, String forSession) {
        w.setBackgroundColor(Color.TRANSPARENT);
        w.setFocusable(true);
        w.setFocusableInTouchMode(true);
        w.setKeepScreenOn(true);
        w.setOverScrollMode(View.OVER_SCROLL_NEVER);
        w.setVerticalScrollBarEnabled(false);
        w.setHorizontalScrollBarEnabled(false);
        w.setScrollbarFadingEnabled(true);
        if (Build.VERSION.SDK_INT >= 26) {
            // Keep the page's renderer at foreground priority even if Android is short of memory, so video
            // decoding is never throttled; the page is the only thing on screen.
            w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setGeolocationEnabled(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Safe Browsing and caching stay at their defaults.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        // Only close() is exposed; it carries no data, so it is harmless even if another page ever saw it.
        w.addJavascriptInterface(new Bridge(forSession), "OfficeTvCast");
        w.setWebViewClient(new Client());
        w.setWebChromeClient(new Chrome());
    }

    private final class Bridge {
        private final String forSession;

        Bridge(String forSession) {
            this.forSession = forSession;
        }

        @JavascriptInterface
        public void close() {
            ui.post(() -> {
                if (forSession.equals(session)) end("receiver", true);
            });
        }
    }

    private final class Client extends WebViewClient {
        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return true; // the receiver page never navigates; block everything else
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady(view);
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            // Android 6+: the page has drawn its first frame.
            pageReady(view);
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            // Main-frame errors only (the newer overload forwards those here).
            if (view == web && failingUrl != null && failingUrl.startsWith(RECEIVER_URL)) {
                pageFailed = true;
                fail("Can’t load screen sharing", "The TV could not load the screen sharing page. Check the TV's "
                        + "internet connection, then share again from your laptop.");
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            // Android 6+ only.
            if (view == web && request != null && request.isForMainFrame() && response != null
                    && response.getStatusCode() >= 400) {
                pageFailed = true;
                fail("Can’t load screen sharing", "The screen sharing page is not available right now (error "
                        + response.getStatusCode() + "). Please try again in a few minutes.");
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (view == web) {
                pageFailed = true;
                fail("Secure connection failed", "The TV could not open a secure connection. Check that the TV's date "
                        + "and time are correct, then share again.");
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Android 8+: the page's process crashed or was killed for memory. Drop the WebView instead of the app.
            boolean crashed = Build.VERSION.SDK_INT >= 26 && detail != null && detail.didCrash();
            CrashLog.note(CastActivity.this, "Cast page process ended (" + (crashed ? "crashed" : "killed for memory") + ").");
            if (view == web) {
                web = null;
                root.removeView(view);
                destroyQuietly(view);
                fail("Screen sharing stopped", "The screen sharing view stopped unexpectedly. Please share again from "
                        + "your laptop.");
            } else {
                destroyQuietly(view);
            }
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            // Receiving a stream needs no camera or microphone; refuse any capture request.
            request.deny();
        }

        @Override
        public Bitmap getDefaultVideoPoster() {
            // A transparent poster instead of the engine's grey "play" picture before the stream starts.
            synchronized (LOCK) {
                if (poster == null) poster = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
                return poster;
            }
        }

        @Override
        public void onProgressChanged(WebView view, int progress) {
            if (progress >= 100) pageReady(view);
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            if (BuildConfig.DEBUG && m != null) Log.d(TAG, "cast page: " + m.message() + " (" + m.lineNumber() + ")");
            return true;
        }
    }

    /** The receiver page is up (first of: first frame, progress 100, load finished). */
    private void pageReady(WebView view) {
        if (view != web || pageFailed || pageLoaded) return;
        pageLoaded = true;
        ui.removeCallbacks(loadTimeout);
        view.setBackgroundColor(Color.BLACK); // opaque from now on: cheaper to draw under video
        overlay.setVisibility(View.GONE);
        DebugHooks.event("cast=page-loaded session=" + session);
    }

    // ---------- native status / messages (black screen, centred text) ----------

    private View buildOverlay() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        int side = Math.round(getResources().getDisplayMetrics().widthPixels * 0.12f);
        box.setPadding(side, kit.dp(24), side, kit.dp(24));
        TextView eyebrow = kit.text("OFFICE TV · SCREEN SHARING", 14, UiKit.ACCENT, true);
        eyebrow.setLetterSpacing(0.14f);
        eyebrow.setGravity(Gravity.CENTER);
        box.addView(eyebrow, centered(0, 0, 0, kit.dp(14)));
        overlayTitle = kit.text("", 32, UiKit.FG, true);
        overlayTitle.setGravity(Gravity.CENTER);
        box.addView(overlayTitle, centered(0, 0, 0, kit.dp(10)));
        overlayText = kit.text("", 19, UiKit.MUTED, false);
        overlayText.setGravity(Gravity.CENTER);
        box.addView(overlayText, centered(0, 0, 0, 0));
        overlayHint = kit.text("", 15, UiKit.MUTED, false);
        overlayHint.setGravity(Gravity.CENTER);
        overlayHint.setAlpha(0.8f);
        box.addView(overlayHint, centered(0, kit.dp(22), 0, 0));
        return box;
    }

    private static LinearLayout.LayoutParams centered(int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(l, t, r, b);
        return lp;
    }

    private void showOverlay(String title, String text, String hint) {
        overlayTitle.setText(title);
        overlayText.setText(text);
        overlayHint.setText(hint);
        overlayHint.setVisibility(hint.isEmpty() ? View.GONE : View.VISIBLE);
        overlay.setVisibility(View.VISIBLE);
    }

    /** Shows a problem on the TV for a few seconds, then goes back to the home screen. */
    private void fail(final String title, final String text) {
        ui.post(() -> {
            if (ending || isFinishing()) return;
            ui.removeCallbacks(loadTimeout);
            releaseWeb();
            showOverlay(title, text, "Press Back to close.");
            DebugHooks.event("cast=message session=" + session + " text=" + text);
            ui.removeCallbacks(endAfterMessage);
            ui.postDelayed(endAfterMessage, MESSAGE_MS);
        });
    }

    /** Ends the cast. goHome: show Office TV's home screen (only if this screen is visible). */
    private void end(String reason, boolean goHome) {
        if (ending || isFinishing()) return;
        ending = true;
        DebugHooks.event("cast=closed reason=" + reason + " session=" + session);
        ui.removeCallbacks(loadTimeout);
        ui.removeCallbacks(endAfterMessage);
        ui.removeCallbacks(endHidden);
        releaseWeb();
        synchronized (LOCK) {
            if (current.get() == this) currentSession = "";
        }
        if (goHome && visible) {
            try {
                startActivity(new Intent(this, MainActivity.class));
            } catch (RuntimeException e) {
                CrashLog.note(this, "Back to home screen: " + e);
            }
        }
        finish();
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int k = event.getKeyCode();
        if (k == KeyEvent.KEYCODE_BACK || k == KeyEvent.KEYCODE_ESCAPE) {
            // Handled here so the page can never swallow it; acted on when the key is released.
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) end("back", true);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onBackPressed() {
        end("back", true);
    }

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;
        ui.removeCallbacks(endHidden);
    }

    @Override
    protected void onResume() {
        super.onResume();
        immersive();
        if (web != null) web.requestFocus();
    }

    @Override
    protected void onStop() {
        visible = false;
        if (!isChangingConfigurations() && !isFinishing()) ui.postDelayed(endHidden, HIDDEN_END_MS);
        super.onStop();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @SuppressWarnings("deprecation")
    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    private void releaseWeb() {
        WebView w = web;
        web = null;
        if (w == null) return;
        root.removeView(w);
        // Navigate away first so the receiver's pagehide handler sends "bye" and the laptop
        // learns at once that the TV stopped; destroy the WebView a moment later.
        try {
            w.loadUrl("about:blank");
        } catch (Throwable ignored) {
        }
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> destroyQuietly(w), 600);
    }

    private static void destroyQuietly(WebView w) {
        try {
            w.stopLoading();
            w.removeJavascriptInterface("OfficeTvCast");
            w.destroy();
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        releaseWeb();
        synchronized (LOCK) {
            if (current.get() == this) {
                current = new WeakReference<>(null);
                currentSession = "";
            }
        }
        if (!ending) DebugHooks.event("cast=closed reason=destroyed session=" + session);
        super.onDestroy();
    }
}
