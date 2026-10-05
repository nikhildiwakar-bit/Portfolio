package com.nikhil.officetv;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import com.nikhil.officetv.mirror.MirrorProtocol;
import com.nikhil.officetv.relay.Pairing;

import java.security.SecureRandom;
import java.util.Locale;

/**
 * Small settings store: pairing code, TV name, relay URL, the keep-screen-on switch, the phone mirroring secret
 * (TV) and the last TV a phone shared to (phone).
 */
final class Prefs {
    static final String DEFAULT_RELAY = "https://ntfy.sh";
    static final int NAME_MAX = 40;

    private static final SecureRandom RNG = new SecureRandom();

    private Prefs() {}

    private static SharedPreferences p(Context c) {
        return c.getSharedPreferences("cfg", Context.MODE_PRIVATE);
    }

    static boolean keepAwake(Context c) {
        return p(c).getBoolean("keep_awake", true);
    }

    static void setKeepAwake(Context c, boolean on) {
        p(c).edit().putBoolean("keep_awake", on).apply();
    }

    /**
     * The TV's 4-digit code (PROTOCOL.md section 1). Created on first use; a code from an older app version
     * (10 symbols) is replaced by a 4-digit one.
     */
    static synchronized String pairCode(Context c) {
        String raw = p(c).getString("pair_code", null);
        String v = Pairing.normalize(raw);
        if (!Pairing.isShort(v)) return newPairCode(c);
        if (!v.equals(raw)) p(c).edit().putString("pair_code", v).apply();
        return v;
    }

    /** Makes a new 4-digit code (never the current one). Laptops have to enter the new one. */
    static synchronized String newPairCode(Context c) {
        String old = p(c).getString("pair_code", null);
        String v;
        do {
            v = Pairing.newShortCode(RNG);
        } while (v.equals(old));
        p(c).edit().putString("pair_code", v).apply();
        return v;
    }

    /** Name shown to controllers, e.g. "Conference Dahua". Defaults to the TV's maker and model. */
    static String tvName(Context c) {
        String v = cleanName(p(c).getString("tv_name", null));
        return v != null ? v : defaultTvName();
    }

    /** Saves a new TV name (empty resets to the default). Returns the name now in use. */
    static String setTvName(Context c, String name) {
        String v = cleanName(name);
        if (v == null) p(c).edit().remove("tv_name").apply();
        else p(c).edit().putString("tv_name", v).apply();
        return v != null ? v : defaultTvName();
    }

    /** Until someone renames it (Rename TV), e.g. to the room: "Board Room", "Class 5A". */
    static String defaultTvName() {
        return "Office TV";
    }

    /** Relay base URL (PROTOCOL.md section 6): ntfy.sh unless prefs key relay_url overrides it. */
    static String relayUrl(Context c) {
        String v = p(c).getString("relay_url", null);
        return v == null || v.trim().isEmpty() ? DEFAULT_RELAY : v.trim();
    }

    /** Trimmed, single-spaced, no control characters, at most 40 chars; null if nothing is left. */
    static String cleanName(String s) {
        if (s == null) return null;
        StringBuilder b = new StringBuilder(s.length());
        boolean space = false;
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (Character.isWhitespace(ch) || Character.isSpaceChar(ch) || Character.isISOControl(ch)) {
                space = b.length() > 0;
                continue;
            }
            if (space) b.append(' ');
            space = false;
            b.append(ch);
        }
        String v = b.toString();
        if (v.length() > NAME_MAX) {
            int end = NAME_MAX;
            if (Character.isHighSurrogate(v.charAt(end - 1))) end--;
            v = v.substring(0, end).trim();
        }
        return v.isEmpty() ? null : v;
    }

    // ---------- phone mirroring ----------

    /** The TV's 32-byte phone mirroring secret (in the QR code). Created on first use. */
    static synchronized byte[] phoneSecret(Context c) {
        byte[] k = MirrorProtocol.base64UrlDecode(p(c).getString("phone_secret", null));
        if (k != null && k.length == MirrorProtocol.SECRET_LEN) return k;
        return newPhoneSecret(c);
    }

    /** New secret: phones that scanned the old QR code must scan again. Made together with a new TV code. */
    static synchronized byte[] newPhoneSecret(Context c) {
        byte[] k = new byte[MirrorProtocol.SECRET_LEN];
        RNG.nextBytes(k);
        p(c).edit().putString("phone_secret", MirrorProtocol.base64UrlEncode(k)).apply();
        return k;
    }

    /** Phone: the TV it last shared to, or null. */
    static MirrorProtocol.Link lastTv(Context c) {
        String q = p(c).getString("last_tv", null);
        return q == null ? null : MirrorProtocol.Link.parse("officetvphone://connect?" + q);
    }

    static void setLastTv(Context c, MirrorProtocol.Link l) {
        if (l == null) p(c).edit().remove("last_tv").apply();
        else p(c).edit().putString("last_tv", l.query()).apply();
    }

    /** "tv", "phone" or null (detect). Lets tests and odd devices override the automatic choice. */
    static String deviceMode(Context c) {
        return p(c).getString("device_mode", null);
    }

    static void setDeviceMode(Context c, String mode) {
        if (mode == null) p(c).edit().remove("device_mode").apply();
        else p(c).edit().putString("device_mode", mode).apply();
    }
}
