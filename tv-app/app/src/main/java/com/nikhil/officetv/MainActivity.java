package com.nikhil.officetv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
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
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.CheckBox;
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
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * TV screen: the TV code + QR for the fixed controller website (no IP needed), the same-Wi-Fi
 * fallback link, connection status and the one-time permission buttons.
 */
public class MainActivity extends Activity {
    private static final int BG = Color.parseColor("#0F172A");
    private static final int CARD = Color.parseColor("#16213B");
    private static final int FG = Color.parseColor("#E5E7EB");
    private static final int MUTED = Color.parseColor("#94A3B8");
    private static final int OK = Color.parseColor("#22C55E");
    private static final int WARN = Color.parseColor("#F59E0B");
    private static final int BAD = Color.parseColor("#F87171");
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

    private ImageView qr;
    private TextView tvName, code, relay, lan, pin, a11y, overlay, diag;
    private Button a11yBtn, overlayBtn;
    private String lastQr;

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
        return ip == null ? "(Wi-Fi se connect nahi)" : "http://" + ip + ":" + port();
    }

    // ---------- UI ----------

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        appContext = getApplicationContext();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        ControlService.start(this);
        RelayManager.start(this);

        boolean wide = getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        root.setPadding(dp(32), dp(24), dp(32), dp(24));
        root.setGravity(Gravity.CENTER_HORIZONTAL);

        // Left: how to connect (the part people look at from across the room).
        LinearLayout left = column();
        left.setGravity(Gravity.CENTER_HORIZONTAL);
        left.addView(text("Office TV", 30, FG, true));
        tvName = text("", 20, MUTED, false);
        left.addView(tvName);
        qr = new ImageView(this);
        qr.setBackgroundColor(Color.WHITE);
        qr.setPadding(dp(8), dp(8), dp(8), dp(8));
        left.addView(qr, sized(dp(220), dp(220), dp(14)));
        left.addView(text("TV code", 18, MUTED, false));
        code = text("", 46, FG, true);
        code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        code.setLetterSpacing(0.06f);
        left.addView(code);
        TextView how = text("Laptop / Chromebook par kholein:\n" + SITE + "\naur yeh TV code daalein. Phone se QR scan bhi kar sakte hain.",
                19, FG, false);
        left.addView(how, margins(0, dp(10), 0, 0));
        relay = text("", 19, MUTED, true);
        left.addView(relay, margins(0, dp(10), 0, 0));

        // Right: fallbacks, permissions, diagnostics.
        LinearLayout right = column();
        right.addView(heading("Same Wi-Fi link (backup)"));
        lan = text("", 18, FG, false);
        lan.setGravity(Gravity.START);
        right.addView(lan);
        pin = text("", 18, FG, true);
        pin.setGravity(Gravity.START);
        right.addView(pin);

        right.addView(heading("Ek baar ki setup"));
        a11y = left(text("", 17, MUTED, false));
        right.addView(a11y);
        a11yBtn = button("Accessibility settings kholo", v -> openSettings(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        right.addView(a11yBtn);
        overlay = left(text("", 17, MUTED, false));
        right.addView(overlay, margins(0, dp(8), 0, 0));
        overlayBtn = button("'Display over other apps' permission do", v -> openOverlaySettings());
        right.addView(overlayBtn);

        CheckBox awake = new CheckBox(this);
        awake.setText("Screen hamesha on rakho (TV apne aap band na ho)");
        awake.setTextColor(FG);
        awake.setTextSize(17);
        awake.setChecked(Prefs.keepAwake(this));
        awake.setOnCheckedChangeListener((b, on) -> {
            Prefs.setKeepAwake(this, on);
            ControlService svc = ControlService.instance;
            if (svc != null) svc.applyKeepAwake();
        });
        right.addView(awake, margins(0, dp(10), 0, 0));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.addView(button("TV ka naam badlo", v -> renameDialog()));
        row.addView(button("Naya TV code", v -> newCodeDialog()));
        row.addView(button("Naya PIN", v -> {
            Prefs.newPin(this);
            refresh();
        }));
        right.addView(row, margins(0, dp(10), 0, 0));

        diag = left(text("", 14, MUTED, false));
        right.addView(diag, margins(0, dp(12), 0, 0));

        LinearLayout.LayoutParams half = wide
                ? new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                : new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        half.setMargins(dp(12), dp(8), dp(12), dp(8));
        root.addView(card(left), half);
        root.addView(card(right), new LinearLayout.LayoutParams(half));

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);
        scroll.addView(root);
        setContentView(scroll);
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

        String qrText = Pairing.pairUrl(c, name, Prefs.relayUrl(this));
        if (!qrText.equals(lastQr)) {
            Bitmap b = qrCode(qrText, dp(204));
            if (b != null) qr.setImageBitmap(b);
            lastQr = qrText;
        }

        RelayClient.State s = RelayManager.state();
        switch (s) {
            case CONNECTED:
                relay.setText("● Internet se juda hai: laptop se kahin se bhi chala sakte hain");
                relay.setTextColor(OK);
                break;
            case RATE_LIMITED:
                relay.setText("● Aaj ki free internet limit poori ho gayi. Abhi same Wi-Fi link use karein.");
                relay.setTextColor(WARN);
                break;
            case OFFLINE:
                relay.setText("● Internet nahi mila, dobara koshish ho rahi hai. Tab tak same Wi-Fi link chalega.");
                relay.setTextColor(BAD);
                break;
            default:
                relay.setText("● Internet se jud raha hai…");
                relay.setTextColor(WARN);
                break;
        }

        List<String> ips = lanIps();
        StringBuilder sb = new StringBuilder();
        if (ips.isEmpty()) {
            sb.append("TV kisi network se nahi juda. Settings mein Wi-Fi ya LAN cable check karein.");
        } else {
            for (int i = 0; i < ips.size(); i++) {
                sb.append(i == 0 ? "" : "\nya: ").append("http://").append(ips.get(i)).append(":").append(port());
            }
        }
        lan.setText(sb);
        pin.setText("PIN: " + Prefs.pin(this) + (ControlService.running() ? "" : "   (server shuru ho raha hai…)"));

        boolean lite = "lite".equals(BuildConfig.FLAVOR);
        boolean a = RemoteA11yService.instance != null;
        if (lite) {
            a11y.setVisibility(View.GONE);
            a11yBtn.setVisibility(View.GONE);
        } else {
            a11y.setText(a ? "✓ Accessibility on hai (Back/Home/slide control chalega)"
                    : "✗ Accessibility off: Settings → Accessibility → Office TV → On karein");
            a11y.setTextColor(a ? OK : WARN);
        }
        if (Build.VERSION.SDK_INT >= 23) {
            boolean o = Settings.canDrawOverlays(this);
            overlay.setText(o ? "✓ Display over other apps: on"
                    : lite ? "✗ Display over other apps: off. Iske bina links TV par nahi khulenge."
                    : "✗ Display over other apps: off (Accessibility on ho to zaroori nahi)");
            overlay.setTextColor(o ? OK : (lite || !a) ? WARN : MUTED);
        } else {
            overlay.setVisibility(View.GONE);
            overlayBtn.setVisibility(View.GONE);
        }

        StringBuilder d = new StringBuilder();
        d.append("Android ").append(Build.VERSION.RELEASE).append(" · ").append(Build.MANUFACTURER).append(' ')
                .append(Build.MODEL).append(" · App ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.FLAVOR).append(")");
        String crash = CrashLog.last(this);
        if (crash != null) d.append("\nPichhli error: ").append(firstLine(crash));
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
                    .setTitle("TV ka naam (jaise: Conference Room)")
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
                    .setTitle("Naya TV code banayein?")
                    .setMessage("Jin laptops par purana code juda hai, woh is TV ko nahi chala payenge. Unhe naya code dobara daalna hoga.")
                    .setPositiveButton("Haan, naya code", (dlg, w) -> {
                        Prefs.newPairCode(this);
                        RelayManager.restart(this);
                        refresh();
                    })
                    .setNegativeButton("Nahi", null)
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
            diag.setText("Is TV par yeh settings screen nahi khuli. TV ki Settings mein khud dhoondhein.");
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

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private LinearLayout column() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(dp(20), dp(16), dp(20), dp(16));
        return l;
    }

    private View card(LinearLayout content) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(CARD);
        bg.setCornerRadius(dp(16));
        content.setBackground(bg);
        return content;
    }

    private TextView heading(String s) {
        TextView t = text(s, 20, FG, true);
        t.setGravity(Gravity.START);
        t.setPadding(0, dp(14), 0, dp(4));
        return t;
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(3), 0, dp(3));
        return t;
    }

    private static TextView left(TextView t) {
        t.setGravity(Gravity.START);
        return t;
    }

    private Button button(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(16);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        return b;
    }

    private static LinearLayout.LayoutParams sized(int w, int h, int vMargin) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(w, h);
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        lp.setMargins(0, vMargin, 0, vMargin);
        return lp;
    }

    private static LinearLayout.LayoutParams margins(int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(l, t, r, b);
        return lp;
    }
}
