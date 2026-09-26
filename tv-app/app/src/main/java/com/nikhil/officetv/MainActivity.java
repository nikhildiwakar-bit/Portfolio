package com.nikhil.officetv;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
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
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** TV screen: shows the QR code / link for phones and the one-time permission buttons. */
public class MainActivity extends Activity {
    private static final int BG = Color.parseColor("#0F172A");
    private static final int FG = Color.parseColor("#E5E7EB");
    private static final int MUTED = Color.parseColor("#94A3B8");
    private static final int OK = Color.parseColor("#22C55E");
    private static final int WARN = Color.parseColor("#F59E0B");

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            refresh();
            handler.postDelayed(this, 5000);
        }
    };

    static volatile android.content.Context appContext;

    private ImageView qr;
    private TextView link, others, pin, server, a11y, overlay;
    private Button overlayBtn;
    private String lastQr;

    /** Interfaces that belong to the TV's own hotspot / screen-share, not the office network. */
    private static boolean isHotspot(String name) {
        return name.startsWith("ap") || name.startsWith("p2p") || name.startsWith("swlan")
                || name.startsWith("softap") || name.startsWith("wlan1") || name.startsWith("rndis");
    }

    /** IPv4 of the network the TV actually uses for internet (the office Wi-Fi/LAN). */
    static String ip() {
        if (appContext != null && Build.VERSION.SDK_INT >= 23) {
            try {
                ConnectivityManager cm = (ConnectivityManager) appContext.getSystemService(CONNECTIVITY_SERVICE);
                Network n = cm.getActiveNetwork();
                LinkProperties lp = n == null ? null : cm.getLinkProperties(n);
                if (lp != null) {
                    for (LinkAddress la : lp.getLinkAddresses()) {
                        InetAddress a = la.getAddress();
                        if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a.getHostAddress();
                    }
                }
            } catch (Exception ignored) {
            }
        }
        List<String> all = allIps();
        return all.isEmpty() ? null : all.get(0);
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

    static String address() {
        String ip = ip();
        return ip == null ? "(Wi-Fi se connect nahi)" : "http://" + ip + ":" + WebServer.PORT;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        appContext = getApplicationContext();
        ControlService.start(this);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(48, 40, 48, 40);

        col.addView(text("📺 Office TV Control", 34, FG, true));
        col.addView(text("Phone se yeh QR scan karein (phone aur TV ek hi Wi-Fi par hon)", 20, MUTED, false));

        qr = new ImageView(this);
        LinearLayout.LayoutParams qrLp = new LinearLayout.LayoutParams(420, 420);
        qrLp.setMargins(0, 24, 0, 16);
        col.addView(qr, qrLp);

        link = text("", 26, FG, true);
        pin = text("", 24, FG, false);
        server = text("", 20, MUTED, false);
        col.addView(link);
        others = text("", 17, MUTED, false);
        col.addView(others);
        col.addView(pin);
        col.addView(server);

        col.addView(text("Ek baar ki setup", 24, FG, true), topMargin(32));
        a11y = text("", 19, MUTED, false);
        col.addView(a11y);
        col.addView(button("Accessibility settings kholo", v -> openSettings(
                new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))));

        overlay = text("", 19, MUTED, false);
        col.addView(overlay, topMargin(16));
        overlayBtn = button("'Display over other apps' permission do", v -> {
            if (Build.VERSION.SDK_INT >= 23) {
                openSettings(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName())));
            }
        });
        col.addView(overlayBtn);

        CheckBox awake = new CheckBox(this);
        awake.setText("Screen hamesha on rakho (TV apne aap band na ho)");
        awake.setTextColor(FG);
        awake.setTextSize(20);
        awake.setChecked(Prefs.keepAwake(this));
        awake.setOnCheckedChangeListener((b, on) -> {
            Prefs.setKeepAwake(this, on);
            ControlService svc = ControlService.instance;
            if (svc != null) svc.applyKeepAwake();
        });
        col.addView(awake, topMargin(24));

        col.addView(button("Naya PIN banao", v -> {
            Prefs.newPin(this);
            refresh();
        }), topMargin(16));

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.addView(col);
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(tick);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(tick);
        super.onPause();
    }

    private void refresh() {
        String addr = address();
        String p = Prefs.pin(this);
        link.setText(addr);
        List<String> ips = allIps();
        String me = ip();
        StringBuilder sb = new StringBuilder();
        for (String a : ips) {
            if (a.equals(me)) continue;
            sb.append(sb.length() == 0 ? "Na khule to yeh try karein: " : "  ·  ")
              .append("http://").append(a).append(":").append(WebServer.PORT);
        }
        others.setText(sb);
        others.setVisibility(sb.length() == 0 ? View.GONE : View.VISIBLE);
        pin.setText("PIN: " + p);
        server.setText(ControlService.running() ? "● Server chal raha hai" : "● Server shuru ho raha hai…");
        server.setTextColor(ControlService.running() ? OK : WARN);

        boolean a = RemoteA11yService.instance != null;
        a11y.setText(a ? "✓ Accessibility on hai (Back/Home/Slide control chalega)"
                : "✗ Accessibility off hai: Settings → Accessibility → Office TV → On karein");
        a11y.setTextColor(a ? OK : WARN);

        if (Build.VERSION.SDK_INT >= 23) {
            boolean o = Settings.canDrawOverlays(this);
            overlay.setText(o ? "✓ Display over other apps: on"
                    : "✗ Display over other apps: off (Android 10+ par links kholne ke liye yeh ya Accessibility chahiye)");
            overlay.setTextColor(o ? OK : WARN);
        } else {
            overlay.setVisibility(View.GONE);
            overlayBtn.setVisibility(View.GONE);
        }

        String qrText = addr.startsWith("http") ? addr + "/?pin=" + p : null;
        if (qrText != null && !qrText.equals(lastQr)) {
            qr.setImageBitmap(qrCode(qrText, 420));
            lastQr = qrText;
        }
    }

    private void openSettings(Intent i) {
        try {
            startActivity(i);
        } catch (ActivityNotFoundException | SecurityException e) {
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getPackageName())));
            } catch (ActivityNotFoundException ignored) {
                a11y.setText("Is TV par yeh settings screen nahi khuli. TV ki Settings mein khud dhoondhein.");
            }
        }
    }

    private static Bitmap qrCode(String text, int size) {
        try {
            BitMatrix m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size);
            int[] px = new int[size * size];
            for (int y = 0; y < size; y++) {
                for (int x = 0; x < size; x++) px[y * size + x] = m.get(x, y) ? Color.BLACK : Color.WHITE;
            }
            Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            b.setPixels(px, 0, size, 0, 0, size, size);
            return b;
        } catch (WriterException e) {
            return null;
        }
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, 6, 0, 6);
        return t;
    }

    private Button button(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(20);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        return b;
    }

    private static LinearLayout.LayoutParams topMargin(int px) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, px, 0, 0);
        return lp;
    }
}
