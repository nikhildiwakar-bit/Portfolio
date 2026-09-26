package com.nikhil.officetv.relay;

import java.io.UnsupportedEncodingException;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Locale;

/** Pairing code helpers (PROTOCOL.md sections 1, 2, 7). Pure Java, safe on Android API 21. */
public final class Pairing {
    public static final String ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    public static final String CONTROLLER_URL = "https://nikhildiwakar-bit.github.io/Portfolio/tv/";
    public static final String DEFAULT_RELAY = "https://ntfy.sh";
    public static final int LENGTH = 10;

    static final Charset UTF8 = Charset.forName("UTF-8");
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private Pairing() {}

    /** A new random 10-symbol code (50 bits). */
    public static String newCode(SecureRandom r) {
        if (r == null) r = new SecureRandom();
        char[] c = new char[LENGTH];
        for (int i = 0; i < LENGTH; i++) c[i] = ALPHABET.charAt(r.nextInt(ALPHABET.length()));
        return new String(c);
    }

    /**
     * Uppercase, drop whitespace and '-', map O->0 and I/L->1. Returns the 10-char code or null if invalid.
     */
    public static String normalize(String input) {
        if (input == null) return null;
        String up = input.toUpperCase(Locale.ROOT);
        StringBuilder b = new StringBuilder(LENGTH);
        for (int i = 0; i < up.length(); i++) {
            char ch = up.charAt(i);
            if (isSeparator(ch)) continue;
            if (ch == 'O') ch = '0';
            else if (ch == 'I' || ch == 'L') ch = '1';
            if (ALPHABET.indexOf(ch) < 0) return null;
            b.append(ch);
            if (b.length() > LENGTH) return null;
        }
        return b.length() == LENGTH ? b.toString() : null;
    }

    /** Whitespace and dashes users may type or paste between the groups (same set as the controller page). */
    private static boolean isSeparator(char ch) {
        return ch == '-' || (ch >= '\u2010' && ch <= '\u2015') || ch == '\uFEFF'
                || Character.isWhitespace(ch) || Character.isSpaceChar(ch);
    }

    /** "7K3M9QX2TD" -> "7K3M9-QX2TD"; "" for invalid input (same as the controller page). */
    public static String display(String code) {
        String n = normalize(code);
        return n == null ? "" : n.substring(0, 5) + "-" + n.substring(5);
    }

    /** "otv" + first 16 bytes of SHA-256("officetv/topic/v1:" + code) as lowercase hex (35 chars). */
    public static String topic(String code) {
        byte[] h = sha256("officetv/topic/v1:" + canonical(code));
        return "otv" + hex(h, 16);
    }

    /** 32-byte AES-256-GCM key: SHA-256("officetv/key/v1:" + code). */
    public static byte[] key(String code) {
        return sha256("officetv/key/v1:" + canonical(code));
    }

    /**
     * Controller link with the code in the URL fragment:
     * CONTROLLER_URL#pair=CODE&name=NAME[&relay=URL]. The relay is omitted when null/empty/default.
     */
    public static String pairUrl(String code, String tvName, String relayOrNull) {
        StringBuilder b = new StringBuilder(CONTROLLER_URL).append("#pair=").append(canonical(code));
        if (tvName != null && !tvName.trim().isEmpty()) b.append("&name=").append(encode(tvName.trim()));
        if (!isDefaultRelay(relayOrNull)) b.append("&relay=").append(encode(relayOrNull.trim()));
        return b.toString();
    }

    /** True for null, "" and https://ntfy.sh (any case, trailing slashes ignored). */
    public static boolean isDefaultRelay(String relay) {
        if (relay == null) return true;
        String r = stripSlashes(relay.trim());
        return r.isEmpty() || r.equalsIgnoreCase(DEFAULT_RELAY);
    }

    static String stripSlashes(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }

    /** Normalized code when valid, otherwise the raw input (never throws). */
    private static String canonical(String code) {
        String n = normalize(code);
        return n != null ? n : (code == null ? "" : code);
    }

    /** Percent-encodes everything except RFC 3986 unreserved characters (spaces become %20, not +). */
    static String encode(String s) {
        byte[] bytes;
        try {
            bytes = s.getBytes("UTF-8");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
        StringBuilder b = new StringBuilder(bytes.length * 3);
        for (byte x : bytes) {
            int c = x & 0xff;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '.' || c == '_' || c == '~') {
                b.append((char) c);
            } else {
                b.append('%').append(Character.toUpperCase(HEX[c >> 4])).append(Character.toUpperCase(HEX[c & 15]));
            }
        }
        return b.toString();
    }

    static byte[] sha256(String s) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(UTF8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static String hex(byte[] b, int n) {
        char[] out = new char[n * 2];
        for (int i = 0; i < n; i++) {
            out[2 * i] = HEX[(b[i] >> 4) & 15];
            out[2 * i + 1] = HEX[b[i] & 15];
        }
        return new String(out);
    }
}
