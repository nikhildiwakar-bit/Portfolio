package com.nikhil.officetv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputFilter;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.nikhil.officetv.relay.Pairing;
import com.nikhil.officetv.relay.RelayClient;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.Locale;
import java.text.SimpleDateFormat;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * TV screen: the TV code + QR for the fixed controller website (no IP needed), the same-Wi-Fi
 * fallback link, connection status and the one-time permission buttons.
 */
public class MainActivity extends Activity {
    private static final int BG = UiKit.BG;
    private static final int FG = UiKit.FG;
    private static final int MUTED = UiKit.MUTED;
    private static final int OK = UiKit.OK;
    private static final int WARN = UiKit.WARN;
    private static final int BAD = UiKit.BAD;
    private static final String SITE = "nikhildiwakar-bit.github.io/Portfolio/tv";

    static volatile Context appContext;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            refresh();
            handler.postDelayed(this, 3000);
        }
    };

    private UiKit ui;
    private ImageView qr;
    private TextView tvName, code, relay, lan, pin, a11y, overlay, diag, clock, date, relayDot;
    private Button a11yBtn, overlayBtn, awakeBtn, renameBtn;
    private View a11yRow, overlayRow, setupCard, tipCard;
    private GradientDrawable relayPill;
    private String lastQr;
    private int qrPx;

    // ---------- network helpers (also used by Commands for the status object) ----------

    /** Interfaces that belong to the TV's own hotspot / screen-share, not the office network. */
    private static boolean isHotspot(String name) {
        return name.startsWith("ap") || name.startsWith("p2p") || name.startsWith("swlan")
                || name.startsWith("softap") || name.startsWith("wlan1") || name.startsWith("rndis");
    }

    /** IPv4 of the network the TV actually uses for internet (the office Wi-Fi/LAN). */
    static String ip() {
        Context c = appContext;
        if (c != null && Build.VERSION.SDK_INT >= 23) {
            String a = activeNetworkIp(c);
            if (a != null) return a;
        }
        List<String> all = allIps();
        return all.isEmpty() ? null : all.get(0);
    }

    @android.annotation.TargetApi(23)
    private static String activeNetworkIp(Context c) {
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(CONNECTIVITY_SERVICE);
            Network n = cm == null ? null : cm.getActiveNetwork();
            LinkProperties lp = n == null ? null : cm.getLinkProperties(n);
            if (lp == null) return null;
            for (LinkAddress la : lp.getLinkAddresses()) {
                InetAddress a = la.getAddress();
                if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a.getHostAddress();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** Every IPv4 on the TV, office-network interfaces first, hotspot ones last. */
    static List<String> allIps() {
        List<String> main = new ArrayList<>(), hotspot = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    (isHotspot(ni.getName()) ? hotspot : main).add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) {
        }
        main.addAll(hotspot);
        return main;
    }

    /** Best address first (the active network), then every other one, without duplicates. */
    static List<String> lanIps() {
        List<String> out = new ArrayList<>();
        String best = ip();
        if (best != null) out.add(best);
        for (String a : allIps()) if (!out.contains(a)) out.add(a);
        return out;
    }

    static int port() {
        int p = ControlService.port();
        return p > 0 ? p : WebServer.PORT;
    }

    static String address() {
        String ip = ip();
        return ip == null ? "(not connected to Wi-Fi)" : "http://" + ip + ":" + port();
    }


    // ---------- UI ----------

    private static final String UI_PREFS = "officetv_ui";
    private static final String TIP_DONE = "chromeTipDismissed";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        appContext = getApplicationContext();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        ControlService.start(this);
        RelayManager.start(this);
        ui = new UiKit(this);

        boolean twoCols = ui.widthDp >= 900 && ui.widthDp > ui.heightDp;
        int gap = ui.dp(20);

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(ui.dp(36), ui.dp(24), ui.dp(36), ui.dp(24));

        page.addView(header(), fill(0, 0, 0, gap));

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(twoCols ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        LinearLayout left = vbox(), right = vbox();
        if (twoCols) {
            LinearLayout.LayoutParams l = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            l.setMargins(0, 0, gap / 2, 0);
            LinearLayout.LayoutParams r = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.1f);
            r.setMargins(gap / 2, 0, 0, 0);
            body.addView(left, l);
            body.addView(right, r);
        } else {
            body.addView(left, fill(0, 0, 0, 0));
            body.addView(right, fill(0, 0, 0, 0));
        }
        page.addView(body, fill(0, 0, 0, 0));

        // Left: how to connect (what people read from across the room).
        left.addView(connectCard(twoCols), fill(0, 0, 0, gap));

        // Right: tip, backup link, setup, settings.
        tipCard = tipCard();
        tipCard.setVisibility(View.GONE);
        right.addView(tipCard, fill(0, 0, 0, gap));
        right.addView(lanCard(), fill(0, 0, 0, gap));
        setupCard = setupCard();
        right.addView(setupCard, fill(0, 0, 0, gap));
        right.addView(settingsCard(), fill(0, 0, 0, gap));

        diag = ui.text("", 13, MUTED, false);
        page.addView(diag, fill(ui.dp(4), 0, ui.dp(4), 0));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[] {UiKit.BG_TOP, BG}));
        scroll.addView(page, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);

        refresh();
        checkChrome();
        scroll.post(() -> {
            if (a11yBtn != null && a11yBtn.getVisibility() == View.VISIBLE && RemoteA11yService.instance == null) {
                a11yBtn.requestFocus();
            } else if (renameBtn != null) {
                renameBtn.requestFocus();
            }
        });
    }

    private View header() {
        LinearLayout h = new LinearLayout(this);
        h.setOrientation(LinearLayout.HORIZONTAL);
        h.setGravity(Gravity.CENTER_VERTICAL);

        TextView mark = ui.text("TV", 18, UiKit.ON_ACCENT, true);
        mark.setGravity(Gravity.CENTER);
        mark.setBackground(ui.rounded(UiKit.ACCENT, UiKit.ACCENT, 12, 0));
        int m = ui.dp(48);
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(m, m);
        mlp.setMargins(0, 0, ui.dp(14), 0);
        h.addView(mark, mlp);

        LinearLayout names = vbox();
        names.addView(ui.text("Office TV", 26, FG, true));
        tvName = ui.text("", 16, MUTED, false);
        names.addView(tvName);
        h.addView(names, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        LinearLayout time = vbox();
        time.setGravity(Gravity.END);
        clock = ui.text("", 30, FG, true);
        clock.setGravity(Gravity.END);
        date = ui.text("", 14, MUTED, false);
        date.setGravity(Gravity.END);
        time.addView(clock);
        time.addView(date);
        h.addView(time, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        return h;
    }

    private View connectCard(boolean twoCols) {
        LinearLayout c = cardBox();
        c.setGravity(Gravity.CENTER_HORIZONTAL);
        c.addView(eyebrow("CONNECT FROM YOUR LAPTOP"), fill(0, 0, 0, ui.dp(8)));

        TextView label = ui.text("TV code", 16, MUTED, false);
        label.setGravity(Gravity.CENTER_HORIZONTAL);
        c.addView(label, fill(0, ui.dp(4), 0, 0));
        code = ui.text("", 54, UiKit.ACCENT, true);
        code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        code.setLetterSpacing(0.08f);
        code.setSingleLine(true);
        code.setGravity(Gravity.CENTER_HORIZONTAL);
        fitWidth(code);
        c.addView(code, fill(0, 0, 0, ui.dp(8)));

        TextView how = ui.text("On your laptop, open", 17, FG, false);
        how.setGravity(Gravity.CENTER_HORIZONTAL);
        c.addView(how, fill(0, 0, 0, 0));
        TextView site = ui.text(SITE, 19, FG, true);
        site.setGravity(Gravity.CENTER_HORIZONTAL);
        c.addView(site, fill(0, 0, 0, 0));
        TextView how2 = ui.text("and enter this TV code.", 17, FG, false);
        how2.setGravity(Gravity.CENTER_HORIZONTAL);
        c.addView(how2, fill(0, 0, 0, ui.dp(14)));

        // QR: capped by both screen dims so it never pushes the card off a 720p screen.
        int side = Math.min(ui.dp(twoCols ? 210 : 190), Math.round(Math.min(
                getResources().getDisplayMetrics().widthPixels, getResources().getDisplayMetrics().heightPixels) * 0.34f));
        qrPx = Math.max(64, side - ui.dp(16));
        qr = new ImageView(this);
        qr.setBackground(ui.rounded(Color.WHITE, Color.WHITE, 14, 0));
        qr.setPadding(ui.dp(8), ui.dp(8), ui.dp(8), ui.dp(8));
        qr.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams qlp = new LinearLayout.LayoutParams(side, side);
        qlp.gravity = Gravity.CENTER_HORIZONTAL;
        c.addView(qr, qlp);
        TextView scan = ui.text("Or scan with a phone", 14, MUTED, false);
        scan.setGravity(Gravity.CENTER_HORIZONTAL);
        c.addView(scan, fill(0, ui.dp(8), 0, ui.dp(14)));

        LinearLayout pill = new LinearLayout(this);
        pill.setOrientation(LinearLayout.HORIZONTAL);
        pill.setGravity(Gravity.CENTER_VERTICAL);
        pill.setPadding(ui.dp(14), ui.dp(10), ui.dp(14), ui.dp(10));
        relayPill = ui.rounded(UiKit.CARD_HI, UiKit.LINE, 14, 1);
        pill.setBackground(relayPill);
        relayDot = ui.text("●", 16, WARN, true);
        pill.addView(relayDot, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        relay = ui.text("", 15, FG, false);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        rlp.setMargins(ui.dp(10), 0, 0, 0);
        pill.addView(relay, rlp);
        c.addView(pill, fill(0, 0, 0, 0));
        return c;
    }

    private View tipCard() {
        LinearLayout c = cardBox();
        c.setBackground(ui.rounded(UiKit.CARD, UiKit.ACCENT_DARK, 18, 2));
        c.addView(eyebrow("TIP · GOOGLE APPS"), fill(0, 0, 0, ui.dp(6)));
        c.addView(ui.text("For the full desktop view of Gmail, Drive and Sheets: open Chrome → ⋮ menu → Settings → "
                + "Site settings → Desktop site → On", 16, FG, false), fill(0, 0, 0, ui.dp(10)));
        Button ok = ui.button("Got it", 15, false, v -> {
            try {
                getSharedPreferences(UI_PREFS, MODE_PRIVATE).edit().putBoolean(TIP_DONE, true).apply();
            } catch (RuntimeException ignored) {
            }
            tipCard.setVisibility(View.GONE);
            if (renameBtn != null) renameBtn.requestFocus();
        });
        c.addView(ok, wrapLp());
        return c;
    }

    private View lanCard() {
        LinearLayout c = cardBox();
        c.addView(eyebrow("SAME WI-FI LINK (BACKUP)"), fill(0, 0, 0, ui.dp(6)));
        lan = ui.text("", 17, FG, false);
        c.addView(lan, fill(0, 0, 0, ui.dp(4)));
        pin = ui.text("", 17, FG, true);
        c.addView(pin, fill(0, 0, 0, 0));
        return c;
    }

    private View setupCard() {
        LinearLayout c = cardBox();
        c.addView(eyebrow("ONE-TIME SETUP"), fill(0, 0, 0, ui.dp(8)));
        a11y = ui.text("", 15, MUTED, false);
        a11yBtn = ui.button("Open Accessibility settings", 15, true,
                v -> openSettings(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        a11yRow = setupRow(a11y, a11yBtn);
        c.addView(a11yRow, fill(0, 0, 0, ui.dp(10)));
        overlay = ui.text("", 15, MUTED, false);
        overlayBtn = ui.button("Allow “Display over other apps”", 15, true, v -> openOverlaySettings());
        overlayRow = setupRow(overlay, overlayBtn);
        c.addView(overlayRow, fill(0, 0, 0, 0));
        return c;
    }

    /** Status text on top, its button below: never side by side, so long text can't squeeze the button. */
    private View setupRow(TextView status, Button b) {
        LinearLayout r = vbox();
        r.addView(status, fill(0, 0, 0, ui.dp(6)));
        r.addView(b, wrapLp());
        return r;
    }

    private View settingsCard() {
        LinearLayout c = cardBox();
        c.addView(eyebrow("SETTINGS"), fill(0, 0, 0, ui.dp(8)));
        awakeBtn = ui.button("", 15, false, v -> {
            boolean on = !Prefs.keepAwake(this);
            Prefs.setKeepAwake(this, on);
            ControlService svc = ControlService.instance;
            if (svc != null) svc.applyKeepAwake();
            refresh();
        });
        c.addView(awakeBtn, wrapLp());

        // Three actions share a row when there is room; each can wrap its label instead of overflowing.
        LinearLayout row = new LinearLayout(this);
        boolean roomy = ui.widthDp >= 600;
        row.setOrientation(roomy ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        renameBtn = ui.button("Rename TV", 15, false, v -> renameDialog());
        Button newCode = ui.button("New TV code", 15, false, v -> newCodeDialog());
        Button newPin = ui.button("New PIN", 15, false, v -> {
            Prefs.newPin(this);
            refresh();
        });
        Button[] bs = {renameBtn, newCode, newPin};
        for (int i = 0; i < bs.length; i++) {
            LinearLayout.LayoutParams lp = roomy
                    ? new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    : fill(0, 0, 0, 0);
            if (roomy) lp.setMargins(i == 0 ? 0 : ui.dp(6), 0, i == bs.length - 1 ? 0 : ui.dp(6), 0);
            else lp.setMargins(0, i == 0 ? 0 : ui.dp(8), 0, 0);
            row.addView(bs[i], lp);
        }
        c.addView(row, fill(0, ui.dp(12), 0, 0));
        return c;
    }

    /** Shows the Chrome tip if Chrome is installed; the check runs off the main thread. */
    private void checkChrome() {
        boolean done = false;
        try {
            done = getSharedPreferences(UI_PREFS, MODE_PRIVATE).getBoolean(TIP_DONE, false);
        } catch (RuntimeException ignored) {
        }
        if (done) return;
        final Context app = getApplicationContext();
        new Thread(() -> {
            boolean chrome = false;
            try {
                chrome = Actions.status(app).optBoolean("chrome");
            } catch (Throwable ignored) {
            }
            if (!chrome) {
                try {
                    app.getPackageManager().getPackageInfo("com.android.chrome", 0);
                    chrome = true;
                } catch (Throwable ignored) {
                }
            }
            final boolean show = chrome;
            runOnUiThread(() -> {
                if (show && !isFinishing() && tipCard != null) tipCard.setVisibility(View.VISIBLE);
            });
        }, "officetv-chrome-check").start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        ControlService.start(this);
        RelayManager.start(this);
        handler.post(tick);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(tick);
        super.onPause();
    }

    private void refresh() {
        String c = Prefs.pairCode(this);
        String name = Prefs.tvName(this);
        tvName.setText(name);
        code.setText(Pairing.display(c));

        Date now = new Date();
        clock.setText(android.text.format.DateFormat.getTimeFormat(this).format(now));
        date.setText(new SimpleDateFormat("EEEE, d MMMM yyyy", Locale.getDefault()).format(now));

        String qrText = Pairing.pairUrl(c, name, Prefs.relayUrl(this));
        if (!qrText.equals(lastQr)) {
            Bitmap b = qrCode(qrText, qrPx);
            if (b != null) qr.setImageBitmap(b);
            lastQr = qrText;
        }

        RelayClient.State s = RelayManager.state();
        int col;
        switch (s) {
            case CONNECTED:
                relay.setText("Online: control this TV from any laptop, anywhere");
                col = OK;
                break;
            case RATE_LIMITED:
                relay.setText("Today's free internet limit is used up. Use the same Wi-Fi link for now.");
                col = WARN;
                break;
            case OFFLINE:
                relay.setText("No internet, retrying… The same Wi-Fi link still works.");
                col = BAD;
                break;
            default:
                relay.setText("Connecting to the internet…");
                col = WARN;
                break;
        }
        relayDot.setTextColor(col);
        relayPill.setStroke(Math.max(1, ui.dp(1)), col);

        List<String> ips = lanIps();
        StringBuilder sb = new StringBuilder();
        if (ips.isEmpty()) {
            sb.append("This TV is not on a network. Check Wi-Fi or the LAN cable in Settings.");
        } else {
            for (int i = 0; i < ips.size(); i++) {
                sb.append(i == 0 ? "" : "\nor  ").append("http://").append(ips.get(i)).append(":").append(port());
            }
        }
        lan.setText(sb);
        pin.setText("PIN  " + Prefs.pin(this) + (ControlService.running() ? "" : "   (server starting…)"));

        boolean lite = "lite".equals(BuildConfig.FLAVOR);
        boolean a = RemoteA11yService.instance != null;
        if (lite) {
            a11yRow.setVisibility(View.GONE);
        } else {
            a11y.setText(a ? "✓  Accessibility is on (Back, Home and slide control work)"
                    : "✗  Accessibility is off: Settings → Accessibility → Office TV → On");
            a11y.setTextColor(a ? OK : WARN);
        }
        boolean overlayShown = Build.VERSION.SDK_INT >= 23;
        if (overlayShown) {
            boolean o = Settings.canDrawOverlays(this);
            overlay.setText(o ? "✓  Display over other apps: on"
                    : lite ? "✗  Display over other apps: off. Without it, links will not open on the TV."
                    : "✗  Display over other apps: off (not needed while Accessibility is on)");
            overlay.setTextColor(o ? OK : (lite || !a) ? WARN : MUTED);
        } else {
            overlayRow.setVisibility(View.GONE);
        }
        setupCard.setVisibility(lite && !overlayShown ? View.GONE : View.VISIBLE);

        awakeBtn.setText(Prefs.keepAwake(this) ? "Keep screen on: On" : "Keep screen on: Off");

        StringBuilder d = new StringBuilder();
        d.append("Android ").append(Build.VERSION.RELEASE).append("  ·  ").append(Build.MANUFACTURER).append(' ')
                .append(Build.MODEL).append("  ·  App ").append(BuildConfig.VERSION_NAME).append(" (")
                .append(BuildConfig.FLAVOR).append(")");
        String crash = CrashLog.last(this);
        if (crash != null) d.append("\nLast error: ").append(firstLine(crash));
        String detail = RelayManager.detail();
        if (detail != null && s != RelayClient.State.CONNECTED) d.append("\nInternet: ").append(detail);
        diag.setText(d);
    }

    private void renameDialog() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setFilters(new InputFilter[] {new InputFilter.LengthFilter(40)});
        input.setText(Prefs.tvName(this));
        input.setSelection(input.getText().length());
        try {
            new AlertDialog.Builder(this)
                    .setTitle("TV name (e.g. Conference Room)")
                    .setView(input)
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

    private void newCodeDialog() {
        try {
            new AlertDialog.Builder(this)
                    .setTitle("Create a new TV code?")
                    .setMessage("Laptops paired with the old code will no longer control this TV. "
                            + "They will need to enter the new code.")
                    .setPositiveButton("Yes, new code", (dlg, w) -> {
                        Prefs.newPairCode(this);
                        RelayManager.restart(this);
                        refresh();
                    })
                    .setNegativeButton("Cancel", null)
                    .show();
        } catch (RuntimeException e) {
            CrashLog.note(this, "New code dialog failed: " + e);
        }
    }

    private void openOverlaySettings() {
        if (Build.VERSION.SDK_INT >= 23) {
            openSettings(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
        }
    }

    private void openSettings(Intent i) {
        try {
            startActivity(i);
            return;
        } catch (ActivityNotFoundException | SecurityException ignored) {
        }
        try {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
            return;
        } catch (ActivityNotFoundException | SecurityException ignored) {
        }
        try {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        } catch (ActivityNotFoundException | SecurityException e) {
            diag.setText("This settings screen could not be opened on this TV. Please find it in the TV's Settings.");
        }
    }

    private static Bitmap qrCode(String text, int size) {
        try {
            Map<EncodeHintType, Object> hints = new HashMap<>();
            hints.put(EncodeHintType.MARGIN, 1);
            BitMatrix m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints);
            int[] px = new int[size * size];
            for (int y = 0; y < size; y++) {
                for (int x = 0; x < size; x++) px[y * size + x] = m.get(x, y) ? Color.BLACK : Color.WHITE;
            }
            Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            b.setPixels(px, 0, size, 0, 0, size, size);
            return b;
        } catch (WriterException | RuntimeException e) {
            return null;
        }
    }

    private static String firstLine(String s) {
        int nl = s.indexOf('\n');
        String line = nl < 0 ? s : s.substring(0, nl);
        return line.length() > 160 ? line.substring(0, 160) + "…" : line;
    }

    // ---------- small view helpers ----------

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
                size *= 0.93f;
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

    private LinearLayout cardBox() {
        LinearLayout l = vbox();
        l.setBackground(ui.card());
        l.setPadding(ui.dp(22), ui.dp(18), ui.dp(22), ui.dp(18));
        return l;
    }

    private TextView eyebrow(String s) {
        TextView t = ui.text(s, 13, UiKit.ACCENT, true);
        t.setLetterSpacing(0.12f);
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
}
