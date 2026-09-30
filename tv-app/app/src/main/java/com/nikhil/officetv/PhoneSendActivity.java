package com.nikhil.officetv;

import android.annotation.TargetApi;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.nikhil.officetv.mirror.MirrorProtocol;

/**
 * Phone screen: "Start mirroring to (TV name)". Opened by scanning the TV's QR code (https link or
 * officetvphone://connect?...), or from the launcher on a phone. Asks for sound (Android 10+) once when missing,
 * then for screen capture; PhoneSendService does the streaming.
 */
public class PhoneSendActivity extends Activity {
    private static final int REQ_CAPTURE = 1;
    private static final int REQ_PERMISSIONS = 2;
    private static final String RECORD_AUDIO = "android.permission.RECORD_AUDIO";
    private static final String KEY_ASKING = "asking";
    private static final String KEY_ASKING_SOUND = "askingSound";

    private UiKit ui;
    private MirrorProtocol.Link tv;
    private String linkError;
    private TextView tvName, status, emptyText;
    private Button primary, scan;
    private View tvCard;
    private GradientDrawable statusBg;
    private final Runnable changed = this::refresh;
    /** The permission dialog is up (its answer continues to the screen-capture request); kept across recreation. */
    private boolean asking, askingSound;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        ui = new UiKit(this, 1f);
        build();
        tv = Prefs.lastTv(this);
        if (state != null) {
            asking = state.getBoolean(KEY_ASKING);
            askingSound = state.getBoolean(KEY_ASKING_SOUND);
        }
        boolean fresh = state == null;
        handle(getIntent(), fresh);
        refresh();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putBoolean(KEY_ASKING, asking);
        out.putBoolean(KEY_ASKING_SOUND, askingSound);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handle(intent, true);
        refresh();
    }

    @Override
    protected void onResume() {
        super.onResume();
        PhoneSendService.setListener(changed);
        refresh();
    }

    @Override
    protected void onPause() {
        PhoneSendService.setListener(null);
        super.onPause();
    }

    /** A scanned link: remember that TV and start at once (the scan was the user's request). */
    private void handle(Intent intent, boolean autoStart) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null) return;
        MirrorProtocol.Link l = MirrorProtocol.Link.parse(data.toString());
        if (l == null) {
            linkError = "This QR code is incomplete or out of date. Scan the code on the TV's Office TV screen again.";
            return;
        }
        linkError = null;
        boolean same = tv != null && tv.host.equals(l.host) && tv.port == l.port
                && MirrorProtocol.constantTimeEquals(tv.secret, l.secret);
        tv = l;
        Prefs.setLastTv(this, l);
        PhoneSendService.State s = PhoneSendService.state();
        boolean busy = s == PhoneSendService.State.STREAMING || s == PhoneSendService.State.CONNECTING;
        if (autoStart && !(busy && same)) startMirroring();
    }

    private void startMirroring() {
        if (tv == null) return;
        PhoneSendService.State s = PhoneSendService.state();
        if (s == PhoneSendService.State.STREAMING || s == PhoneSendService.State.CONNECTING) {
            PhoneSendService.stop(this);
        }
        // The answer to a dialog that is already up continues to the capture request.
        if (asking || askPermissions()) {
            refresh();
            return;
        }
        askCapture();
    }

    private void askCapture() {
        if (tv == null) return;
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            // A new consent every time: Android 14 allows each one to be used for one session only.
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE);
        } catch (RuntimeException e) {
            linkError = "This phone does not support screen sharing.";
            refresh();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_CAPTURE) return;
        if (resultCode != RESULT_OK || data == null || tv == null) {
            linkError = "Screen sharing was not allowed. Tap Start mirroring and choose Start now.";
            refresh();
            return;
        }
        linkError = null;
        try {
            PhoneSendService.start(this, tv, resultCode, data);
        } catch (RuntimeException e) {
            CrashLog.note(this, "Phone service start: " + e);
            linkError = "Android did not allow screen sharing right now. Please try again.";
        }
        refresh();
    }

    /**
     * One dialog for what is missing: RECORD_AUDIO (Android 10+, the phone's sound). True if it was shown; its answer goes on to the capture request. If the user denied for good,
     * Android answers at once without a dialog, so mirroring is never blocked.
     */
    private boolean askPermissions() {
        if (Build.VERSION.SDK_INT < 29) return false;
        String[] missing = missingPermissions();
        if (missing.length == 0) return false;
        try {
            requestPermissions(missing, REQ_PERMISSIONS);
        } catch (RuntimeException e) {
            return false;
        }
        asking = true;
        askingSound = false;
        for (String p : missing) if (RECORD_AUDIO.equals(p)) askingSound = true;
        linkError = null;
        return true;
    }

    @TargetApi(29)
    private String[] missingPermissions() {
        // Only what mirroring needs, so the phone asks as little as possible: the sound. (Notifications are left
        // out on purpose: Android shows its own screen-sharing indicator, and Stop is in this screen.)
        String[] wanted = {RECORD_AUDIO};
        int n = 0;
        String[] missing = new String[wanted.length];
        for (String p : wanted) {
            try {
                if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing[n++] = p;
            } catch (RuntimeException ignored) {
            }
        }
        String[] out = new String[n];
        System.arraycopy(missing, 0, out, 0, n);
        return out;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQ_PERMISSIONS) return;
        asking = false;
        askingSound = false;
        // Whatever the answer: without RECORD_AUDIO only the screen is sent (PhoneSendService says so).
        askCapture();
        refresh();
    }

    private void scanAnother() {
        Intent[] tries = {
            new Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA),
            new Intent(MediaStore.ACTION_IMAGE_CAPTURE),
        };
        for (Intent t : tries) {
            try {
                startActivity(t);
                return;
            } catch (ActivityNotFoundException | SecurityException ignored) {
            }
        }
        linkError = "Open the camera app and point it at the QR code on the TV.";
        refresh();
    }

    // ---------- screen ----------

    private void build() {
        LinearLayout page = vbox();
        page.setPadding(ui.dp(20), ui.dp(24), ui.dp(20), ui.dp(24));

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.ic_launcher);
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(ui.dp(44), ui.dp(44));
        mlp.setMargins(0, 0, ui.dp(12), 0);
        head.addView(mark, mlp);
        LinearLayout names = vbox();
        names.addView(ui.text("Office TV", 22, UiKit.FG, true));
        names.addView(ui.text("Show this phone's screen on a TV", 14, UiKit.MUTED, false));
        head.addView(names);
        page.addView(head, fill(0, 0, 0, ui.dp(22)));

        LinearLayout card = cardBox();
        card.setBackground(ui.rounded(UiKit.CARD, UiKit.ACCENT_DARK, 18, 1.5f));
        TextView eyebrow = ui.text("TV", 12, UiKit.ACCENT, true);
        eyebrow.setLetterSpacing(0.14f);
        card.addView(eyebrow, fill(0, 0, 0, ui.dp(4)));
        tvName = ui.text("", 24, UiKit.FG, true);
        card.addView(tvName, fill(0, 0, 0, ui.dp(12)));
        status = ui.text("", 15, UiKit.FG, false);
        status.setPadding(ui.dp(12), ui.dp(10), ui.dp(12), ui.dp(10));
        statusBg = ui.rounded(UiKit.CARD_HI, UiKit.LINE, 12, 1);
        status.setBackground(statusBg);
        card.addView(status, fill(0, 0, 0, ui.dp(16)));
        primary = ui.button("", 18, true, v -> onPrimary());
        primary.setFocusableInTouchMode(false);
        primary.setPadding(ui.dp(18), ui.dp(14), ui.dp(18), ui.dp(14));
        card.addView(primary, fill(0, 0, 0, 0));
        tvCard = card;
        page.addView(card, fill(0, 0, 0, ui.dp(14)));

        emptyText = ui.text("", 15, UiKit.MUTED, false);
        page.addView(emptyText, fill(ui.dp(2), 0, ui.dp(2), ui.dp(14)));

        scan = ui.button("Scan another TV", 16, false, v -> scanAnother());
        page.addView(scan, fill(0, 0, 0, ui.dp(22)));

        LinearLayout how = cardBox();
        TextView h = ui.text("HOW IT WORKS", 12, UiKit.ACCENT, true);
        h.setLetterSpacing(0.14f);
        how.addView(h, fill(0, 0, 0, ui.dp(10)));
        String[] steps = {
            "Open Office TV on the TV. Its home screen shows a QR code.",
            "Scan the QR code with this phone's camera and open it with Office TV.",
            Build.VERSION.SDK_INT >= 29 ? "Tap Start now when Android asks. Your screen and sound appear on the TV."
                    : "Tap Start now when Android asks. Your screen appears on the TV.",
        };
        for (int i = 0; i < steps.length; i++) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            TextView n = ui.text(String.valueOf(i + 1), 13, UiKit.ON_ACCENT, true);
            n.setGravity(Gravity.CENTER);
            n.setIncludeFontPadding(false);
            n.setBackground(ui.rounded(UiKit.ACCENT, UiKit.ACCENT, 12, 0));
            LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(ui.dp(24), ui.dp(24));
            nlp.setMargins(0, ui.dp(1), ui.dp(12), 0);
            row.addView(n, nlp);
            row.addView(ui.text(steps[i], 15, UiKit.FG, false),
                    new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            how.addView(row, fill(0, 0, 0, i == steps.length - 1 ? 0 : ui.dp(10)));
        }
        page.addView(how, fill(0, 0, 0, ui.dp(14)));
        page.addView(ui.text("The phone and the TV must be on the same Wi-Fi. Only the TV in the QR code can "
                + "receive your screen.", 13, UiKit.MUTED, false), fill(ui.dp(2), 0, ui.dp(2), ui.dp(18)));
        // Safety net for a display that Android describes like a phone: turn this install into the TV.
        Button asTv = ui.button("This device is the TV: show the TV code", 14, false, v -> useAsTv());
        asTv.setAlpha(0.85f);
        page.addView(asTv, fill(0, 0, 0, 0));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[] {UiKit.BG_TOP, UiKit.BG}));
        scroll.addView(page, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);
    }

    private void useAsTv() {
        if (PhoneSendService.state() == PhoneSendService.State.STREAMING
                || PhoneSendService.state() == PhoneSendService.State.CONNECTING) {
            PhoneSendService.stop(this);
        }
        Prefs.setDeviceMode(this, "tv");
        try {
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
        } catch (RuntimeException e) {
            CrashLog.note(this, "TV screen: " + e);
        }
        finish();
    }

    private void onPrimary() {
        PhoneSendService.State s = PhoneSendService.state();
        if (s == PhoneSendService.State.STREAMING || s == PhoneSendService.State.CONNECTING) {
            PhoneSendService.stop(this);
        } else {
            linkError = null;
            // A tap means no dialog is up (a flag left over from a lost dialog must not block).
            asking = false;
            askingSound = false;
            startMirroring();
        }
        refresh();
    }

    private void refresh() {
        if (status == null) return;
        PhoneSendService.State s = PhoneSendService.state();
        boolean active = s == PhoneSendService.State.STREAMING || s == PhoneSendService.State.CONNECTING;
        String name = active && !PhoneSendService.tvName().isEmpty() ? PhoneSendService.tvName()
                : tv != null ? tv.name : null;
        tvCard.setVisibility(name != null ? View.VISIBLE : View.GONE);
        if (name != null) tvName.setText(name);

        String msg;
        int col;
        if (askingSound && !active) {
            msg = "To send the phone's sound to the TV, allow Office TV to record audio: only the sound of apps "
                    + "playing on this phone is sent, never the microphone.";
            col = UiKit.ACCENT;
        } else if (linkError != null && !active) {
            msg = linkError;
            col = UiKit.BAD;
        } else if (s == PhoneSendService.State.STREAMING) {
            msg = PhoneSendService.message();
            col = UiKit.OK;
        } else if (s == PhoneSendService.State.CONNECTING) {
            msg = PhoneSendService.message();
            col = UiKit.WARN;
        } else if (s == PhoneSendService.State.ERROR) {
            msg = PhoneSendService.message();
            col = UiKit.BAD;
        } else {
            String m = PhoneSendService.message();
            msg = m.isEmpty() ? "Ready. Tap the button to show this phone's screen on the TV." : m;
            col = UiKit.MUTED;
        }
        status.setText(msg);
        statusBg.setStroke(Math.max(1, ui.dp(1)), col);
        primary.setText(active ? "Stop mirroring" : name != null ? "Start mirroring to " + name : "Start mirroring");
        primary.setEnabled(active || tv != null);

        String empty = tv == null
                ? (linkError != null ? linkError + "\n\n" : "")
                        + "Scan the QR code on the TV with your camera. It is on the Office TV home screen."
                : "";
        emptyText.setText(empty);
        emptyText.setVisibility(empty.isEmpty() ? View.GONE : View.VISIBLE);
        scan.setText(tv == null ? "Open the camera" : "Scan another TV");
    }

    private LinearLayout vbox() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    private LinearLayout cardBox() {
        LinearLayout l = vbox();
        l.setBackground(ui.card());
        l.setPadding(ui.dp(18), ui.dp(16), ui.dp(18), ui.dp(18));
        return l;
    }

    private static LinearLayout.LayoutParams fill(int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(l, t, r, b);
        return lp;
    }
}
