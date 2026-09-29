package com.nikhil.officetv;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import com.nikhil.officetv.mirror.MirrorProtocol;

import java.security.SecureRandom;
import java.util.Locale;

/**
 * Small settings store: pairing code, TV name, relay URL, the keep-screen-on switch, the phone mirroring secret
 * (TV) and the last TV a phone shared to (phone).
 */
final class Prefs {
    /** Crockford base32 (PROTOCOL.md section 1). */
    static final String PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    static final int PAIR_LENGTH = 10;
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

    /** The TV's 10-symbol pairing code (normalized, no dash). Created on first use. */
    static synchronized String pairCode(Context c) {
        String raw = p(c).getString("pair_code", null);
        String v = normalizePairCode(raw);
        if (v == null) return newPairCode(c);
        if (!v.equals(raw)) p(c).edit().putString("pair_code", v).apply();
        return v;
    }

    /** Makes a new pairing code; every laptop that used the old one has to enter the new one. */
    static synchronized String newPairCode(Context c) {
        char[] out = new char[PAIR_LENGTH];
        for (int i = 0; i < out.length; i++) out[i] = PAIR_ALPHABET.charAt(RNG.nextInt(PAIR_ALPHABET.length()));
        String v = new String(out);
        p(c).edit().putString("pair_code", v).apply();
        return v;
    }

    /** Uppercase, drop spaces and dashes, O->0, I/L->1; null unless exactly 10 alphabet symbols remain. */
    static String normalizePairCode(String s) {
        if (s == null) return null;
        String up = s.toUpperCase(Locale.ROOT);
        StringBuilder b = new StringBuilder(PAIR_LENGTH);
        for (int i = 0; i < up.length(); i++) {
            char ch = up.charAt(i);
            if (ch == '-' || Character.isWhitespace(ch) || Character.isSpaceChar(ch)) continue;
            if (ch == 'O') ch = '0';
            else if (ch == 'I' || ch == 'L') ch = '1';
            if (PAIR_ALPHABET.indexOf(ch) < 0 || b.length() >= PAIR_LENGTH) return null;
            b.append(ch);
        }
        return b.length() == PAIR_LENGTH ? b.toString() : null;
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

    static String defaultTvName() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        // Avoid "Xiaomi Xiaomi TV" when the model already starts with the maker.
        String n = model.toLowerCase(Locale.US).startsWith(maker.toLowerCase(Locale.US)) ? model : maker + " " + model;
        n = cleanName(n);
        return n != null ? n : "Office TV";
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
