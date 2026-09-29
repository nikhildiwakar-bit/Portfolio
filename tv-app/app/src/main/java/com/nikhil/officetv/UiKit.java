package com.nikhil.officetv;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.TextView;

/**
 * Shared look for the TV screens: one dark navy palette with a single teal accent, and sizes scaled
 * to the screen so the same layout fits 720p panels and 4K TVs at any density.
 */
final class UiKit {
    static final int BG = Color.parseColor("#0B1220");
    static final int BG_TOP = Color.parseColor("#111C33");
    static final int CARD = Color.parseColor("#15213A");
    static final int CARD_HI = Color.parseColor("#1C2A48");
    static final int LINE = Color.parseColor("#2A3A5C");
    static final int FG = Color.parseColor("#F1F5F9");
    static final int MUTED = Color.parseColor("#94A3B8");
    static final int ACCENT = Color.parseColor("#2DD4BF");
    static final int ACCENT_DARK = Color.parseColor("#0F766E");
    static final int ON_ACCENT = Color.parseColor("#04201D");
    static final int OK = Color.parseColor("#34D399");
    static final int WARN = Color.parseColor("#FBBF24");
    static final int BAD = Color.parseColor("#F87171");
    static final int SCRIM = Color.parseColor("#CC0B1220");

    private final Context ctx;
    private final float density;
    /** Multiplier on top of dp/sp: 1.0 at a 540dp-tall screen, clamped so nothing gets silly. */
    final float scale;
    final float widthDp, heightDp;

    UiKit(Context c) {
        this(c, 0);
    }

    /** fixedScale > 0: use it instead of the screen-based scale (the phone screens use 1.0). */
    UiKit(Context c, float fixedScale) {
        ctx = c;
        DisplayMetrics dm = c.getResources().getDisplayMetrics();
        density = dm.density <= 0 ? 1f : dm.density;
        widthDp = dm.widthPixels / density;
        heightDp = dm.heightPixels / density;
        float small = Math.min(widthDp, heightDp);
        scale = fixedScale > 0 ? fixedScale : Math.max(0.75f, Math.min(1.5f, small / 540f));
    }

    int dp(float v) {
        return Math.round(v * scale * density);
    }

    /** Text size in px (applied with COMPLEX_UNIT_PX), scaled like dp but honouring the font scale. */
    float sp(float v) {
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v * scale, ctx.getResources().getDisplayMetrics());
    }

    TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(ctx);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(sp));
        t.setTextColor(color);
        t.setIncludeFontPadding(true);
        t.setLineSpacing(0, 1.12f);
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        t.setGravity(Gravity.START);
        return t;
    }

    GradientDrawable rounded(int fill, int stroke, float radiusDp, float strokeDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radiusDp));
        if (strokeDp > 0) g.setStroke(Math.max(1, dp(strokeDp)), stroke);
        return g;
    }

    Drawable card() {
        return rounded(CARD, LINE, 18, 1);
    }

    /** Focused: bright accent fill + white ring (easy to see from the sofa). Pressed: dark accent. */
    Drawable buttonBg(boolean primary) {
        StateListDrawable s = new StateListDrawable();
        s.addState(new int[] {android.R.attr.state_focused}, rounded(ACCENT, Color.WHITE, 12, 3));
        s.addState(new int[] {android.R.attr.state_pressed}, rounded(ACCENT_DARK, ACCENT, 12, 2));
        s.addState(new int[] {}, primary ? rounded(ACCENT_DARK, ACCENT_DARK, 12, 2) : rounded(CARD_HI, LINE, 12, 2));
        return s;
    }

    Button button(String label, float sp, boolean primary, android.view.View.OnClickListener l) {
        Button b = new Button(ctx);
        b.setText(label);
        b.setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(sp));
        b.setAllCaps(false);
        b.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        b.setBackground(buttonBg(primary));
        b.setTextColor(new android.content.res.ColorStateList(
                new int[][] {{android.R.attr.state_focused}, {}}, new int[] {ON_ACCENT, FG}));
        b.setPadding(dp(18), dp(10), dp(18), dp(10));
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setFocusable(true);
        b.setFocusableInTouchMode(false);
        b.setOnClickListener(l);
        if (android.os.Build.VERSION.SDK_INT >= 21) b.setStateListAnimator(null);
        return b;
    }
}
