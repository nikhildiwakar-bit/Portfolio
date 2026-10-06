package com.nikhil.officetv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputFilter;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.nikhil.officetv.relay.Pairing;
import com.nikhil.officetv.relay.RelayClient;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * The TV's home screen: the TV code and where to enter it, whether the TV is online, the one-time setup
 * (only when something is missing) and three settings. Everything is built in code, scaled to the screen
 * (see UiKit) and usable with the remote's D-pad or by touch. The 4-digit code is new every time Office TV is
 * opened from the launcher (not when a shared screen closes and the home screen comes back).
 */
public class MainActivity extends Activity {
    static final String SITE = "nikhildiwakar-bit.github.io/Portfolio/tv";
    private static final long TICK_MS = 5000;

    /** The visible home screen, so services can ask it to update at once (e.g. Accessibility just connected). */
    private static volatile java.lang.ref.WeakReference<MainActivity> visible = new java.lang.ref.WeakReference<>(null);

    static void refreshNow() {
        MainActivity a = visible.get();
        if (a != null) a.handler.post(a::refresh);
    }
    /** A failed connection is shown as "Connecting" for this long first (short outages are normal). */
    private static final long OFFLINE_GRACE_MS = 8000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            refresh();
            handler.postDelayed(this, TICK_MS);
        }
    };
    /** Relay state or TV code changed: the whole screen when the code (and so the phone QR code) is new. */
    private final Runnable relayChanged = () -> {
        String shown = MainActivity.this.codeShown;
        if (shown != null && !shown.equals(Prefs.pairCode(MainActivity.this))) refresh();
        else refreshStatus();
    };

    private UiKit ui;
    private boolean twoCols;
    private boolean holdTop;
    private TextView tvName, code, clock, date, statusDot, statusText, statusHint, diag;
    private String codeShown;
    /** For sizing the TV code: the page, its flexible spacers and (two columns) the body and the code's column. */
    private ScrollView scroll;
    private LinearLayout page, body, codeColumn;
    private View hero, topSpace, bottomSpace;
    private int gap;
    private float codeMinPx, codeMaxPx;
    private GradientDrawable statusPill;
    private View setupCard, howCard, allowSection, engineSection;
    private TextView allowText, allowHint, engineText;
    private Button allowPrimary, allowSecondary, engineButton, awakeButton, renameButton, newCodeButton;
    private long offlineSince;
    private boolean engineStoreFailed, settingsFailed;
    /** WebViewInfo.problem(), refreshed with the rest of the screen every few seconds. */
    private String engineProblem;
    private View phoneCard;
    private ImageView phoneQr;
    private TextView phoneAddr;
    private String phoneLinkShown;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Device.isPhone(this)) {
            // The same app on a phone is the sender: show the phone screen instead of the TV home screen.
            try {
                startActivity(new Intent(this, PhoneSendActivity.class));
            } catch (RuntimeException e) {
                CrashLog.note(this, "Phone screen: " + e);
            }
            finish();
            return;
        }
        // Opened from the launcher: a new code (a restored screen or the way back from a shared screen keeps it).
        if (state == null && openedFromLauncher(getIntent())) RelayManager.opened(this, "opened");
        ControlService.start(this);
        RelayManager.start(this);
        ui = new UiKit(this);
        float vw = ui.widthDp / ui.scale;
        twoCols = vw >= 820 && ui.widthDp > ui.heightDp * 1.2f;
        gap = ui.dp(16);

        page = vbox();
        page.setPadding(ui.dp(40), ui.dp(20), ui.dp(40), ui.dp(16));
        if (vw < 560) {
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, ui.dp(36));
            blp.setMargins(0, 0, 0, ui.dp(8));
            page.addView(schoolBadge(36), blp);
        }
        page.addView(header(vw >= 560), fill(0, 0, 0, gap));
        // Spacers above and below the content: centred on big screens, no gap when the page has to scroll.
        topSpace = new View(this);
        page.addView(topSpace, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        hero = heroCard();
        View settings = settingsRow(twoCols || vw >= 560);
        setupCard = setupCard();
        howCard = howCard();
        phoneCard = phoneCard();
        if (twoCols) {
            body = new LinearLayout(this);
            body.setOrientation(LinearLayout.HORIZONTAL);
            LinearLayout left = vbox(), right = vbox();
            codeColumn = left;
            left.addView(hero, fill(0, 0, 0, gap));
            left.addView(settings, fill(0, 0, 0, 0));
            right.addView(setupCard, fill(0, 0, 0, 0));
            right.addView(howCard, fill(0, 0, 0, gap));
            if (PhoneServer.ENABLED) right.addView(phoneCard, fill(0, 0, 0, 0));
            LinearLayout.LayoutParams l = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.3f);
            l.setMargins(0, 0, gap / 2, 0);
            LinearLayout.LayoutParams r = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            r.setMargins(gap / 2, 0, 0, 0);
            body.addView(left, l);
            body.addView(right, r);
            page.addView(body, fill(0, 0, 0, gap));
        } else {
            page.addView(hero, fill(0, 0, 0, gap));
            page.addView(setupCard, fill(0, 0, 0, gap));
            page.addView(howCard, fill(0, 0, 0, gap));
            if (PhoneServer.ENABLED) page.addView(phoneCard, fill(0, 0, 0, gap));
            page.addView(settings, fill(0, 0, 0, gap));
        }

        bottomSpace = new View(this);
        page.addView(bottomSpace, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        diag = ui.text("", 12, UiKit.MUTED, false);
        diag.setAlpha(0.85f);
        page.addView(diag, fill(ui.dp(4), 0, ui.dp(4), 0));

        scroll = new ScrollView(this) {
            /** While holdTop is set, focusing a button further down does not scroll the TV code away. */
            @Override
            protected int computeScrollDeltaToGetChildRectOnScreen(Rect rect) {
                return holdTop ? 0 : super.computeScrollDeltaToGetChildRectOnScreen(rect);
            }
        };
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[] {UiKit.BG_TOP, UiKit.BG}));
        scroll.addView(page, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);

        refresh();
        scroll.post(this::focusDefault);
    }

    /** The launcher's intent (also from recents or the TV's app row), not a plain "back to the home screen" one. */
    private static boolean openedFromLauncher(Intent i) {
        return i != null && Intent.ACTION_MAIN.equals(i.getAction());
    }

    // ---------- building the screen ----------

    /** The school's logo on a white badge (its dark-blue lettering needs a light background). */
    private View schoolBadge(int heightDp) {
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.school_logo);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        logo.setAdjustViewBounds(true);
        logo.setContentDescription("Fountainhead School");
        int pad = ui.dp(Math.max(4, heightDp / 7));
        logo.setPadding(pad * 2, pad, pad * 2, pad);
        logo.setBackground(ui.rounded(0xFFFFFFFF, 0xFFFFFFFF, 12, 0));
        return logo;
    }

    private View header(boolean withLogo) {
        LinearLayout h = new LinearLayout(this);
        h.setOrientation(LinearLayout.HORIZONTAL);
        h.setGravity(Gravity.CENTER_VERTICAL);

        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.ic_launcher);
        int m = ui.dp(46);
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(m, m);
        mlp.setMargins(0, 0, ui.dp(14), 0);
        h.addView(mark, mlp);

        LinearLayout names = vbox();
        names.addView(ui.text("Office TV", 24, UiKit.FG, true));
        tvName = ui.text("", 16, UiKit.MUTED, false);
        tvName.setSingleLine(true);
        tvName.setEllipsize(android.text.TextUtils.TruncateAt.END);
        names.addView(tvName);
        h.addView(names, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        if (withLogo) {
            View badge = schoolBadge(52);
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, ui.dp(52));
            blp.setMargins(ui.dp(12), 0, ui.dp(22), 0);
            h.addView(badge, blp);
        }

        LinearLayout time = vbox();
        time.setGravity(Gravity.END);
        clock = ui.text("", 26, UiKit.FG, true);
        clock.setGravity(Gravity.END);
        date = ui.text("", 14, UiKit.MUTED, false);
        date.setGravity(Gravity.END);
        time.addView(clock);
        time.addView(date);
        h.addView(time, wrapLp());
        return h;
    }

    /** Open the website on the laptop and enter this code: the 4 digits as large as the screen allows. */
    private View heroCard() {
        LinearLayout c = cardBox(26, 20);
        c.setBackground(ui.rounded(UiKit.CARD, UiKit.ACCENT_DARK, 20, 1.5f));
        c.setGravity(Gravity.CENTER_HORIZONTAL);
        c.addView(center(ui.text("Open this website on the laptop", 18, UiKit.FG, false)), fill(0, 0, 0, ui.dp(2)));
        TextView site = center(ui.text(SITE, 22, UiKit.FG, true));
        site.setSingleLine(true);
        fitWidth(site);
        c.addView(site, fill(0, 0, 0, ui.dp(2)));
        c.addView(center(ui.text("and enter this code", 18, UiKit.FG, false)), fill(0, 0, 0, ui.dp(4)));

        // Monospace digits with wide spacing, readable across the room; fitCode sets the size.
        codeMinPx = ui.sp(56);
        codeMaxPx = ui.sp(170);
        code = center(ui.text("", 96, UiKit.ACCENT, true));
        code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        code.setLetterSpacing(0.25f);
        code.setSingleLine(true);
        code.setIncludeFontPadding(false);
        c.addView(code, fill(0, ui.dp(6), 0, ui.dp(14)));

        LinearLayout pill = new LinearLayout(this);
        pill.setOrientation(LinearLayout.HORIZONTAL);
        pill.setGravity(Gravity.CENTER_VERTICAL);
        pill.setPadding(ui.dp(16), ui.dp(10), ui.dp(16), ui.dp(10));
        statusPill = ui.rounded(UiKit.CARD_HI, UiKit.LINE, 14, 1);
        pill.setBackground(statusPill);
        statusDot = ui.text("●", 20, UiKit.WARN, true);
        pill.addView(statusDot, wrapLp());
        LinearLayout texts = vbox();
        statusText = ui.text("", 16, UiKit.FG, true);
        statusHint = ui.text("", 14, UiKit.MUTED, false);
        texts.addView(statusText);
        texts.addView(statusHint);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        tlp.setMargins(ui.dp(12), 0, 0, 0);
        pill.addView(texts, tlp);
        c.addView(pill, fill(0, 0, 0, 0));
        return c;
    }

    private View setupCard() {
        LinearLayout c = cardBox(22, 18);
        c.setBackground(ui.rounded(UiKit.CARD, UiKit.WARN, 18, 1.5f));
        c.addView(eyebrow("ONE-TIME SETUP"), fill(0, 0, 0, ui.dp(8)));

        boolean lite = "lite".equals(BuildConfig.FLAVOR);
        LinearLayout allow = vbox();
        allow.addView(ui.text("Allow Office TV to open automatically", 18, UiKit.FG, true), fill(0, 0, 0, ui.dp(4)));
        allowText = ui.text(lite
                ? "Then your laptop screen appears on the TV by itself, even while another app is open. "
                        + "Allow “Display over other apps” for Office TV."
                : "Then your laptop screen appears on the TV by itself, even while another app is open. "
                        + "Turn on Office TV in Accessibility settings.", 15, UiKit.MUTED, false);
        allow.addView(allowText, fill(0, 0, 0, ui.dp(10)));
        if (lite) {
            allowPrimary = ui.button("Allow “Display over other apps”", 15, true, v -> openOverlaySettings());
            allow.addView(allowPrimary, wrapLp());
        } else {
            allowPrimary = ui.button("Open Accessibility settings", 15, true,
                    v -> openSettings(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
            allow.addView(allowPrimary, wrapLp());
            allowSecondary = ui.button("Use “Display over other apps” instead", 15, false, v -> openOverlaySettings());
            allow.addView(allowSecondary, wrapMargins(0, ui.dp(8), 0, 0));
        }
        allowHint = ui.text("", 13, UiKit.MUTED, false);
        allowHint.setVisibility(View.GONE);
        allow.addView(allowHint, fill(0, ui.dp(8), 0, 0));
        allowSection = allow;
        c.addView(allow, fill(0, 0, 0, 0));

        LinearLayout engine = vbox();
        engine.addView(ui.text("Update Android System WebView", 18, UiKit.FG, true), fill(0, 0, 0, ui.dp(4)));
        engineText = ui.text("", 15, UiKit.MUTED, false);
        engine.addView(engineText, fill(0, 0, 0, ui.dp(10)));
        engineButton = ui.button("Open the app store", 15, true, v -> openEngineStore());
        engine.addView(engineButton, wrapLp());
        engineSection = engine;
        c.addView(engine, fill(0, ui.dp(16), 0, 0));
        return c;
    }

    private View howCard() {
        LinearLayout c = cardBox(22, 18);
        c.addView(eyebrow("HOW IT WORKS"), fill(0, 0, 0, ui.dp(10)));
        String[] steps = {
            "Open the website shown here on a laptop, Chromebook or MacBook.",
            "Enter the TV code and choose what to share: a tab, a window or the whole screen.",
            "It appears here. Stop from the laptop, or press Back on the remote.",
        };
        for (int i = 0; i < steps.length; i++) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            TextView n = ui.text(String.valueOf(i + 1), 14, UiKit.ON_ACCENT, true);
            n.setGravity(Gravity.CENTER);
            n.setIncludeFontPadding(false);
            n.setBackground(ui.rounded(UiKit.ACCENT, UiKit.ACCENT, 13, 0));
            int d = ui.dp(26);
            LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(d, d);
            nlp.setMargins(0, ui.dp(1), ui.dp(12), 0);
            row.addView(n, nlp);
            row.addView(ui.text(steps[i], 15, UiKit.FG, false),
                    new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            c.addView(row, fill(0, 0, 0, i == steps.length - 1 ? 0 : ui.dp(10)));
        }
        return c;
    }

    /** Share an Android phone: the QR code (TV address + phone secret) and one line of instructions. */
    private View phoneCard() {
        LinearLayout c = cardBox(22, 18);
        c.addView(eyebrow("SHARE AN ANDROID PHONE"), fill(0, 0, 0, ui.dp(10)));
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        phoneQr = new ImageView(this);
        phoneQr.setScaleType(ImageView.ScaleType.FIT_CENTER);
        phoneQr.setBackground(ui.rounded(0xFFFFFFFF, 0xFFFFFFFF, 8, 0));
        phoneQr.setPadding(ui.dp(4), ui.dp(4), ui.dp(4), ui.dp(4));
        int q = ui.dp(128);
        LinearLayout.LayoutParams qlp = new LinearLayout.LayoutParams(q, q);
        qlp.setMargins(0, 0, ui.dp(18), 0);
        row.addView(phoneQr, qlp);
        LinearLayout texts = vbox();
        texts.addView(ui.text("On a phone: scan with the camera, tap Share, then Start now.",
                15, UiKit.FG, false), fill(0, 0, 0, ui.dp(8)));
        phoneAddr = ui.text("", 13, UiKit.MUTED, false);
        texts.addView(phoneAddr, fill(0, 0, 0, 0));
        row.addView(texts, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        c.addView(row, fill(0, 0, 0, 0));
        return c;
    }

    /** Rebuilds the QR code only when the address, port, secret or name changed. */
    private void refreshPhone() {
        String ip = Qr.lanAddress();
        int port = PhoneServer.port();
        if (ip == null || port == 0) {
            phoneLinkShown = null;
            phoneQr.setImageDrawable(null);
            phoneQr.setVisibility(View.GONE);
            put(phoneAddr, ip == null ? "Connect the TV to the office Wi-Fi or network to share a phone screen."
                    : "Getting ready…");
            return;
        }
        String link = Qr.phoneLink(ip, port, Prefs.phoneSecret(this), Prefs.tvName(this), Prefs.pairCode(this));
        if (!link.equals(phoneLinkShown)) {
            android.graphics.Bitmap b = Qr.bitmap(link);
            if (b != null) {
                android.graphics.drawable.BitmapDrawable d = new android.graphics.drawable.BitmapDrawable(getResources(), b);
                d.setFilterBitmap(false);
                d.setAntiAlias(false);
                phoneQr.setImageDrawable(d);
                phoneLinkShown = link;
            }
        }
        phoneQr.setVisibility(phoneLinkShown != null ? View.VISIBLE : View.GONE);
        PhoneServer.Session s = PhoneServer.current();
        put(phoneAddr, (s != null ? "A phone is connected.  ·  " : "") + "TV address " + ip + ":" + port
                + " · same Wi-Fi as the phone");
    }

    /** Keep screen on, Rename TV, New TV code: one row when there is room, else stacked. */
    private View settingsRow(boolean roomy) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(roomy ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        awakeButton = ui.button("", 15, false, v -> {
            boolean on = !Prefs.keepAwake(this);
            Prefs.setKeepAwake(this, on);
            ControlService svc = ControlService.instance;
            if (svc != null) svc.applyKeepAwake();
            refresh();
        });
        renameButton = ui.button("Rename TV", 15, false, v -> renameDialog());
        newCodeButton = ui.button("New TV code", 15, false, v -> newCodeDialog());
        Button[] bs = {awakeButton, renameButton, newCodeButton};
        for (int i = 0; i < bs.length; i++) {
            LinearLayout.LayoutParams lp;
            if (roomy) {
                lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, i == 0 ? 1.35f : 1f);
                lp.setMargins(i == 0 ? 0 : ui.dp(5), 0, i == bs.length - 1 ? 0 : ui.dp(5), 0);
            } else {
                lp = fill(0, i == 0 ? 0 : ui.dp(8), 0, 0);
            }
            row.addView(bs[i], lp);
        }
        return row;
    }

    // ---------- updating ----------

    @Override
    protected void onResume() {
        super.onResume();
        visible = new java.lang.ref.WeakReference<>(this);
        ControlService.start(this);
        RelayManager.start(this);
        RelayManager.setListener(relayChanged);
        handler.removeCallbacks(tick);
        handler.post(tick);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(tick);
        RelayManager.setListener(null);
        if (visible.get() == this) visible = new java.lang.ref.WeakReference<>(null);
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // Opened again from the launcher (not "back to home" from a shared screen): a new code each time.
        if (openedFromLauncher(intent)) RelayManager.opened(this, "opened");
        refresh();
    }

    private void refresh() {
        put(tvName, "TV name: " + Prefs.tvName(this) + "  (shown on the laptop)");
        put(code, Pairing.display(Prefs.pairCode(this)));

        Date now = new Date();
        boolean h24 = android.text.format.DateFormat.is24HourFormat(this);
        put(clock, new SimpleDateFormat(h24 ? "HH:mm" : "h:mm a", Locale.ENGLISH).format(now));
        put(date, new SimpleDateFormat("EEEE, d MMMM", Locale.ENGLISH).format(now));

        boolean keepAwake = Prefs.keepAwake(this);
        put(awakeButton, keepAwake ? "Keep screen on: On" : "Keep screen on: Off");
        if (keepAwake) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // One-time setup: only what is actually missing.
        boolean needAllow = needsAllow();
        allowSection.setVisibility(needAllow ? View.VISIBLE : View.GONE);
        String hint = settingsFailed
                ? "This TV has no shortcut to that setting. Open the TV's Settings and look for Accessibility, "
                        + "or Apps → Office TV → Display over other apps."
                : allowSecondary != null && Build.VERSION.SDK_INT >= 33
                        ? "If Android says “Restricted setting”, use the second button instead." : "";
        put(allowHint, hint);
        allowHint.setVisibility(hint.isEmpty() ? View.GONE : View.VISIBLE);
        String engine = WebViewInfo.problem(this);
        engineProblem = engine;
        engineSection.setVisibility(engine != null ? View.VISIBLE : View.GONE);
        if (engine != null) {
            put(engineText, engineStoreFailed ? engine + " If no app store opens here, ask IT to update it." : engine);
            LinearLayout.LayoutParams elp = (LinearLayout.LayoutParams) engineSection.getLayoutParams();
            int top = needAllow ? ui.dp(16) : 0;
            if (elp.topMargin != top) {
                elp.topMargin = top;
                engineSection.setLayoutParams(elp);
            }
        }
        boolean setup = needAllow || engine != null;
        setupCard.setVisibility(setup ? View.VISIBLE : View.GONE);
        // Two columns: the setup card takes the place of "How it works". One column: both, setup first.
        howCard.setVisibility(twoCols && setup ? View.GONE : View.VISIBLE);

        refreshStatus();
        if (PhoneServer.ENABLED) refreshPhone();

        StringBuilder d = new StringBuilder();
        String wv = WebViewInfo.version(this);
        d.append("Android ").append(Build.VERSION.RELEASE).append("  ·  ").append(Build.MANUFACTURER).append(' ')
                .append(Build.MODEL).append("  ·  Office TV ").append(BuildConfig.VERSION_NAME).append(" (")
                .append(BuildConfig.FLAVOR).append(")  ·  WebView ").append(wv == null ? "unknown" : wv);
        String crash = CrashLog.lastLine(this);
        if (crash != null) d.append("\nLast crash: ").append(crash);
        String lastEnd = Prefs.lastCastEndText(this);
        if (lastEnd != null) d.append("\nLast share ended: ").append(lastEnd);
        int sleepMin = Prefs.sleepAfterMinutes(this);
        if (sleepMin > 0) {
            d.append("\nThis TV turns its screen off after ").append(sleepMin).append(sleepMin == 1 ? " minute" : " minutes")
                    .append(" without the remote, even during a meeting. Set Settings > Energy saver (or Power) to Never.");
        }
        put(diag, d);

        View f = getCurrentFocus();
        if (f == null || !f.isShown()) focusDefault();
    }

    private boolean needsAllow() {
        return Build.VERSION.SDK_INT >= 29 && !Actions.canOpenFromBackground(this);
    }

    /** The status pill: online / connecting / no internet, each with what to do about it. */
    private void refreshStatus() {
        if (statusText == null) return;
        RelayClient.State s = RelayManager.state();
        String detail = RelayManager.detail();
        long now = SystemClock.elapsedRealtime();
        if (s == RelayClient.State.OFFLINE) {
            if (offlineSince == 0) offlineSince = now;
        } else {
            offlineSince = 0;
        }
        boolean offlineLong = offlineSince != 0 && now - offlineSince >= OFFLINE_GRACE_MS;
        String text, hint = "";
        int col;
        if (s != RelayClient.State.CONNECTED && !networkConnected()) {
            text = "No internet";
            hint = "Connect the TV to Wi-Fi or a network cable. Office TV reconnects by itself.";
            col = UiKit.BAD;
        } else if (s == RelayClient.State.CONNECTED) {
            if (needsAllow()) {
                text = "Online · One-time setup needed";
                hint = twoCols ? "Finish the setup on the right so shared screens can appear by themselves."
                        : "Finish the setup below so shared screens can appear by themselves.";
                col = UiKit.WARN;
            } else if (engineProblem != null) {
                text = "Online · Update needed";
                hint = "Update Android System WebView to use screen sharing.";
                col = UiKit.WARN;
            } else {
                text = "Online · Ready for screen sharing";
                hint = "Waiting for a laptop.";
                col = UiKit.OK;
            }
        } else if (s == RelayClient.State.RATE_LIMITED) {
            text = "Busy right now";
            hint = "The free connection service is at its limit. Office TV retries automatically.";
            col = UiKit.WARN;
        } else if (s == RelayClient.State.OFFLINE && offlineLong) {
            if (detail != null && detail.contains("date and time")) {
                text = "Can’t connect securely";
                hint = "Check that the TV's date and time are correct.";
            } else {
                text = "Can’t reach the connection service";
                hint = "Office TV keeps retrying. If this lasts, ask IT to allow ntfy.sh on the office network.";
            }
            col = UiKit.BAD;
        } else {
            text = "Connecting…";
            col = UiKit.WARN;
        }
        put(statusText, text);
        put(statusHint, hint);
        statusHint.setVisibility(hint.isEmpty() ? View.GONE : View.VISIBLE);
        statusDot.setTextColor(col);
        statusPill.setStroke(Math.max(1, ui.dp(1)), col);
    }

    @SuppressWarnings("deprecation")
    private boolean networkConnected() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkInfo ni = cm == null ? null : cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected();
        } catch (RuntimeException e) {
            return true; // unknown: do not claim "no internet"
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // The first remote key press: from now on the page follows the focus as usual.
        if (event.getAction() == KeyEvent.ACTION_DOWN) holdTop = false;
        return super.dispatchKeyEvent(event);
    }

    /**
     * Puts the remote's focus on the most useful button. In one column (portrait or small screens) that button
     * can be below the fold: the page stays at the top, with the TV code in view, until a key is pressed.
     */
    private void focusDefault() {
        holdTop = !twoCols;
        if (allowSection.isShown()) allowPrimary.requestFocus();
        else if (engineSection.isShown() && engineButton.isShown()) engineButton.requestFocus();
        else renameButton.requestFocus();
    }

    // ---------- settings ----------

    private void renameDialog() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setFilters(new InputFilter[] {new InputFilter.LengthFilter(Prefs.NAME_MAX)});
        input.setText(Prefs.tvName(this));
        input.setSelection(input.getText().length());
        input.setHint("e.g. Conference Room");
        LinearLayout box = vbox();
        box.setPadding(ui.dp(22), ui.dp(4), ui.dp(22), 0);
        box.addView(input, fill(0, 0, 0, 0));
        try {
            new AlertDialog.Builder(this)
                    .setTitle("Rename this TV")
                    .setMessage("Laptops see this name when they connect.")
                    .setView(box)
                    .setPositiveButton("Save", (dlg, w) -> {
                        String n = input.getText().toString().trim();
                        if (!n.isEmpty()) Prefs.setTvName(this, n);
                        refresh();
                    })
                    .setNegativeButton("Cancel", null)
                    .show();
        } catch (RuntimeException e) {
            CrashLog.note(this, "Rename dialog failed: " + e);
        }
    }

    /** "New TV code": a new 4-digit code at once (the code also changes every time Office TV opens). */
    private void newCodeDialog() {
        Prefs.newPhoneSecret(this);
        PhoneServer.disconnectAll("The TV code was changed. Scan the new QR code on the TV.");
        RelayManager.newCode(this, "button");
        DebugHooks.event("code=changed");
        refresh();
    }

    private void openOverlaySettings() {
        if (Build.VERSION.SDK_INT >= 23) {
            openSettings(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
        }
    }

    /** Opens a settings screen; falls back to the app's info page, then to Settings, and says so if all fail. */
    private void openSettings(Intent i) {
        Intent[] tries = {
            i,
            new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())),
            new Intent(Settings.ACTION_SETTINGS),
        };
        for (Intent t : tries) {
            try {
                startActivity(t);
                return;
            } catch (ActivityNotFoundException | SecurityException ignored) {
            }
        }
        settingsFailed = true;
        refresh();
    }

    private void openEngineStore() {
        Intent[] tries = {
            new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + WebViewInfo.UPDATE_PACKAGE)),
            new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id="
                    + WebViewInfo.UPDATE_PACKAGE)),
        };
        for (Intent t : tries) {
            try {
                startActivity(t);
                return;
            } catch (ActivityNotFoundException | SecurityException ignored) {
            }
        }
        engineStoreFailed = true;
        engineButton.setVisibility(View.GONE);
        refresh();
    }

    // ---------- small view helpers ----------

    /** setText only when the text changed (the screen refreshes every few seconds; no needless relayouts). */
    private static void put(TextView t, CharSequence text) {
        if (!android.text.TextUtils.equals(t.getText(), text)) t.setText(text);
    }

    /** Shrinks a single-line text (the TV code) until it fits its width, so it is never cut off. */
    private static void fitWidth(final TextView t) {
        final float max = t.getTextSize();
        t.addOnLayoutChangeListener((v, l, top, r, b, ol, ot, or, ob) -> {
            int avail = t.getWidth() - t.getPaddingLeft() - t.getPaddingRight();
            if (avail <= 0) return;
            Paint p = new Paint(t.getPaint());
            float size = max;
            p.setTextSize(size);
            String s = t.getText().toString();
            while (size > 12 && p.measureText(s) + p.getTextSize() * t.getLetterSpacing() * s.length() > avail) {
                size *= 0.94f;
                p.setTextSize(size);
            }
            if (Math.abs(size - t.getTextSize()) > 0.5f) {
                final float target = size;
                t.post(() -> t.setTextSize(TypedValue.COMPLEX_UNIT_PX, target));
            }
        });
    }

    private LinearLayout vbox() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    private LinearLayout cardBox(float padH, float padV) {
        LinearLayout l = vbox();
        l.setBackground(ui.card());
        l.setPadding(ui.dp(padH), ui.dp(padV), ui.dp(padH), ui.dp(padV));
        return l;
    }

    private TextView eyebrow(String s) {
        TextView t = ui.text(s, 13, UiKit.ACCENT, true);
        t.setLetterSpacing(0.14f);
        return t;
    }

    private static TextView center(TextView t) {
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        return t;
    }

    private static LinearLayout.LayoutParams fill(int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(l, t, r, b);
        return lp;
    }

    private static LinearLayout.LayoutParams wrapLp() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private static LinearLayout.LayoutParams wrapMargins(int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = wrapLp();
        lp.setMargins(l, t, r, b);
        return lp;
    }
}
