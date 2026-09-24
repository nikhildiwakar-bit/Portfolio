package com.nikhil.officetv;

import android.content.Context;
import android.content.SharedPreferences;

import java.security.SecureRandom;
import java.util.Locale;

/** Small settings store: the access PIN and the keep-screen-on switch. */
final class Prefs {
    private Prefs() {}

    private static SharedPreferences p(Context c) {
        return c.getSharedPreferences("cfg", Context.MODE_PRIVATE);
    }

    static String pin(Context c) {
        String v = p(c).getString("pin", null);
        return v != null ? v : newPin(c);
    }

    static String newPin(Context c) {
        String v = String.format(Locale.US, "%04d", new SecureRandom().nextInt(10000));
        p(c).edit().putString("pin", v).apply();
        return v;
    }

    static boolean keepAwake(Context c) {
        return p(c).getBoolean("keep_awake", true);
    }

    static void setKeepAwake(Context c, boolean on) {
        p(c).edit().putBoolean("keep_awake", on).apply();
    }
}
