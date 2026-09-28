package com.nikhil.officetv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.nikhil.officetv.relay.Pairing;

import java.lang.ref.WeakReference;

/**
 * Full-screen receiver for "Share my screen" (PROTOCOL.md section 8). A WebView loads the receiver page
 * that is hosted with the controller site (https, so WebRTC has a secure context). The pairing code and
 * session travel in the URL fragment, which the WebView never sends to any server; the page cannot
 * navigate anywhere else, so the code never reaches another site. The page does the WebRTC signaling
 * itself over the encrypted relay and calls OfficeTvCast.close() when sharing ends.
 */
public class CastActivity extends Activity {
    static final String RECEIVER_URL = "https://nikhildiwakar-bit.github.io/Portfolio/tv/receive.html";
    static final String EXTRA_URL = "cast_url";
    static final String EXTRA_SESSION = "cast_session";

    private static WeakReference<CastActivity> current = new WeakReference<>(null);
    private static volatile String currentSession = "";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private String session = "";

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

    /** Closes the receiver if it shows this session (or any session when empty). True if one was open. */
    static boolean stop(String session) {
        final CastActivity a = current.get();
        if (a == null || a.isFinishing()) return false;
        if (session != null && !session.isEmpty() && !session.equals(currentSession)) return false;
        a.ui.post(a::finish);
        return true;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        current = new WeakReference<>(this);
        load(getIntent());
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
            finish();
            return;
        }
        session = s;
        currentSession = s;
        releaseWeb();
        WebView w;
        try {
            w = new WebView(this);
        } catch (Throwable t) {
            CrashLog.note(this, "Cast WebView could not be created: " + t);
            message("Screen sharing needs Android System WebView or Google Chrome. Please install or update it on the TV.");
            return;
        }
        web = w;
        try {
            setUp(w);
            root.addView(w, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            w.requestFocus();
            w.loadUrl(url);
        } catch (Throwable t) {
            CrashLog.note(this, "Cast WebView setup: " + t);
            releaseWeb();
            message("Screen sharing could not start on this TV.");
        }
    }

    private void setUp(WebView w) {
        w.setBackgroundColor(Color.BLACK);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setSupportZoom(false);
        if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        w.setFocusable(true);
        w.setFocusableInTouchMode(true);
        // Only close() is exposed; it carries no data, so it is harmless even if another page ever saw it.
        w.addJavascriptInterface(new Bridge(), "OfficeTvCast");
        w.setWebViewClient(new WebViewClient() {
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
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // API 26+ only. Drop the dead WebView instead of letting the app crash.
                if (view == web) {
                    web = null;
                    root.removeView(view);
                    view.destroy();
                    finish();
                }
                return true;
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (failingUrl != null && failingUrl.startsWith(RECEIVER_URL)) {
                    message("The TV could not load the screen receiver. Check the TV's internet connection.");
                }
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Receiving a stream needs no camera or microphone; refuse any capture request.
                request.deny();
            }
        });
    }

    private final class Bridge {
        @JavascriptInterface
        public void close() {
            ui.post(CastActivity.this::finish);
        }
    }

    private void message(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(Color.WHITE);
        t.setTextSize(24);
        t.setGravity(Gravity.CENTER);
        t.setPadding(64, 64, 64, 64);
        root.addView(t, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        ui.postDelayed(this::finish, 6000);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            finish();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        finish();
    }

    private void releaseWeb() {
        WebView w = web;
        web = null;
        if (w == null) return;
        try {
            w.stopLoading();
            root.removeView(w);
            w.removeJavascriptInterface("OfficeTvCast");
            w.destroy(); // closes the RTCPeerConnection, so the laptop sees the TV leave
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        releaseWeb();
        if (current.get() == this) {
            current = new WeakReference<>(null);
            currentSession = "";
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && Build.VERSION.SDK_INT >= 19) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }
}
