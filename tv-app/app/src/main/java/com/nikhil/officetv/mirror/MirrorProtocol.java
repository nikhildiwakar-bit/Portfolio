package com.nikhil.officetv.mirror;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.List;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Phone to TV mirroring wire protocol, used by both roles of the app (TV receiver and phone sender) (pure Java, no android.*,
 * Java 8 language level and only APIs present on Android 5). See tv-app/PROTOCOL.md section 10.
 *
 * <pre>
 * Handshake (phone = client, TV = server, plain TCP on the local network):
 *   phone -> TV   "OTVP1" | nonce[16] | HMAC-SHA256(secret, nonce || "phone")          (53 bytes)
 *   TV -> phone   "OK" | HMAC-SHA256(secret, nonce || "tv")                             (34 bytes)
 *            or   "NO" | reason u8   (REJECT_AUTH, REJECT_BUSY, REJECT_VERSION)         (3 bytes)
 * Then messages in both directions: type u8 | length u32 big-endian | payload.
 *   CONFIG  phone -> TV  width u32 | height u32 | rotation u8 (0..3) | flags u8 | spsLen u32 | sps | ppsLen u32 | pps
 *                        (SPS and PPS in Annex-B form, start codes included)
 *   FRAME   phone -> TV  flags u8 (FLAG_KEY) | pts i64 (microseconds) | one Annex-B access unit
 *   PING    both ways    empty (keep-alive)
 *   BYE     both ways    empty, or kind u8 (BYE_NORMAL, BYE_ERROR) | reason text UTF-8 (session over)
 *   KEYREQ  TV -> phone  empty (send a sync frame as soon as possible)
 * </pre>
 */
public final class MirrorProtocol {
    public static final int DEFAULT_PORT = 47300;
    public static final int LAST_PORT = 47309;
    public static final int SECRET_LEN = 32;
    public static final int NONCE_LEN = 16;
    public static final int MAC_LEN = 32;
    public static final byte[] MAGIC = {'O', 'T', 'V', 'P', '1'};
    public static final int HELLO_LEN = MAGIC.length + NONCE_LEN + MAC_LEN;
    public static final int OK_REPLY_LEN = 2 + MAC_LEN;

    public static final int REJECT_AUTH = 1;
    public static final int REJECT_BUSY = 2;
    public static final int REJECT_VERSION = 3;

    public static final int T_CONFIG = 1;
    public static final int T_FRAME = 2;
    public static final int T_PING = 3;
    public static final int T_BYE = 4;
    public static final int T_KEYREQ = 5;

    public static final int FLAG_KEY = 1;
    public static final int BYE_NORMAL = 0;
    public static final int BYE_ERROR = 1;
    /** Largest accepted message payload (a 1080p IDR at a high bitrate is well below 1 MB). */
    public static final int MAX_PAYLOAD = 8 * 1024 * 1024;
    public static final int FRAME_HEADER_LEN = 1 + 8;

    private MirrorProtocol() {}

    // ---------- handshake ----------

    public static byte[] hmac(byte[] secret, byte[] nonce, String label) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(secret, "HmacSHA256"));
            m.update(nonce);
            m.update(label.getBytes("UTF-8"));
            return m.doFinal();
        } catch (GeneralSecurityException | UnsupportedEncodingException e) {
            throw new IllegalStateException("HMAC-SHA256 unavailable", e);
        }
    }

    public static byte[] clientHello(byte[] secret, byte[] nonce) {
        if (nonce.length != NONCE_LEN) throw new IllegalArgumentException("nonce");
        byte[] out = new byte[HELLO_LEN];
        System.arraycopy(MAGIC, 0, out, 0, MAGIC.length);
        System.arraycopy(nonce, 0, out, MAGIC.length, NONCE_LEN);
        System.arraycopy(hmac(secret, nonce, "phone"), 0, out, MAGIC.length + NONCE_LEN, MAC_LEN);
        return out;
    }

    /** True if the first bytes are the protocol magic (anything else: close at once). */
    public static boolean hasMagic(byte[] hello) {
        if (hello == null || hello.length < MAGIC.length) return false;
        for (int i = 0; i < MAGIC.length; i++) if (hello[i] != MAGIC[i]) return false;
        return true;
    }

    public static byte[] nonceOf(byte[] hello) {
        byte[] n = new byte[NONCE_LEN];
        System.arraycopy(hello, MAGIC.length, n, 0, NONCE_LEN);
        return n;
    }

    /** Server side: magic and HMAC are right (constant-time comparison). */
    public static boolean verifyHello(byte[] secret, byte[] hello) {
        if (secret == null || hello == null || hello.length != HELLO_LEN || !hasMagic(hello)) return false;
        byte[] want = hmac(secret, nonceOf(hello), "phone");
        byte[] got = new byte[MAC_LEN];
        System.arraycopy(hello, MAGIC.length + NONCE_LEN, got, 0, MAC_LEN);
        return constantTimeEquals(want, got);
    }

    public static byte[] okReply(byte[] secret, byte[] nonce) {
        byte[] out = new byte[OK_REPLY_LEN];
        out[0] = 'O';
        out[1] = 'K';
        System.arraycopy(hmac(secret, nonce, "tv"), 0, out, 2, MAC_LEN);
        return out;
    }

    public static byte[] rejectReply(int reason) {
        return new byte[] {'N', 'O', (byte) reason};
    }

    /**
     * Client side: reads the TV's answer. Returns 0 if it is OK and proves the TV knows the secret, the reject
     * reason if the TV said no, or -1 if the answer is not from the right TV.
     */
    public static int readReply(InputStream in, byte[] secret, byte[] nonce) throws IOException {
        byte[] head = new byte[2];
        readFully(in, head, 0, 2);
        if (head[0] == 'N' && head[1] == 'O') {
            int r = in.read();
            return r <= 0 ? -1 : r;
        }
        if (head[0] != 'O' || head[1] != 'K') return -1;
        byte[] mac = new byte[MAC_LEN];
        readFully(in, mac, 0, MAC_LEN);
        return constantTimeEquals(hmac(secret, nonce, "tv"), mac) ? 0 : -1;
    }

    public static boolean constantTimeEquals(byte[] a, byte[] b) {
        if (a == null || b == null || a.length != b.length) return false;
        int d = 0;
        for (int i = 0; i < a.length; i++) d |= a[i] ^ b[i];
        return d == 0;
    }

    // ---------- framing ----------

    public static final class Message {
        public final int type;
        public final byte[] payload;

        public Message(int type, byte[] payload) {
            this.type = type;
            this.payload = payload;
        }
    }

    public static void writeHeader(OutputStream out, int type, int len) throws IOException {
        byte[] h = new byte[5];
        h[0] = (byte) type;
        putInt(h, 1, len);
        out.write(h);
    }

    public static void writeMessage(OutputStream out, int type, byte[] payload) throws IOException {
        int len = payload == null ? 0 : payload.length;
        byte[] buf = new byte[5 + len];
        buf[0] = (byte) type;
        putInt(buf, 1, len);
        if (len > 0) System.arraycopy(payload, 0, buf, 5, len);
        out.write(buf);
    }

    /** Writes FRAME in one write call (header and data together, so TCP_NODELAY sends few packets). */
    public static void writeFrame(OutputStream out, boolean key, long ptsUs, byte[] data, int off, int len)
            throws IOException {
        byte[] buf = new byte[5 + FRAME_HEADER_LEN + len];
        buf[0] = (byte) T_FRAME;
        putInt(buf, 1, FRAME_HEADER_LEN + len);
        buf[5] = (byte) (key ? FLAG_KEY : 0);
        putLong(buf, 6, ptsUs);
        System.arraycopy(data, off, buf, 5 + FRAME_HEADER_LEN, len);
        out.write(buf);
    }

    /** Reads one message; EOFException at a clean end of stream, IOException for bad lengths. */
    public static Message readMessage(DataInputStream in) throws IOException {
        int type = in.read();
        if (type < 0) throw new EOFException();
        int len = in.readInt();
        if (len < 0 || len > MAX_PAYLOAD) throw new IOException("Bad message length " + len);
        byte[] p = new byte[len];
        in.readFully(p);
        return new Message(type, p);
    }

    /** BYE payload: kind byte + UTF-8 reason shown on the other side. */
    public static byte[] byePayload(boolean error, String reason) {
        byte[] t;
        try {
            t = (reason == null ? "" : reason).getBytes("UTF-8");
        } catch (UnsupportedEncodingException e) {
            t = new byte[0];
        }
        byte[] out = new byte[1 + t.length];
        out[0] = (byte) (error ? BYE_ERROR : BYE_NORMAL);
        System.arraycopy(t, 0, out, 1, t.length);
        return out;
    }

    /** True if a BYE payload marks an error. */
    public static boolean byeIsError(byte[] p) {
        return p != null && p.length > 0 && p[0] == BYE_ERROR;
    }

    /** Reason text of a BYE payload ("" if none). */
    public static String byeReason(byte[] p) {
        if (p == null || p.length <= 1) return "";
        try {
            return new String(p, 1, p.length - 1, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            return "";
        }
    }

    // ---------- CONFIG ----------

    public static final class Config {
        public final int width, height, rotation, flags;
        public final byte[] sps, pps;

        public Config(int width, int height, int rotation, int flags, byte[] sps, byte[] pps) {
            this.width = width;
            this.height = height;
            this.rotation = rotation;
            this.flags = flags;
            this.sps = sps == null ? new byte[0] : sps;
            this.pps = pps == null ? new byte[0] : pps;
        }

        public byte[] encode() {
            byte[] out = new byte[4 + 4 + 1 + 1 + 4 + sps.length + 4 + pps.length];
            putInt(out, 0, width);
            putInt(out, 4, height);
            out[8] = (byte) rotation;
            out[9] = (byte) flags;
            putInt(out, 10, sps.length);
            System.arraycopy(sps, 0, out, 14, sps.length);
            putInt(out, 14 + sps.length, pps.length);
            System.arraycopy(pps, 0, out, 18 + sps.length, pps.length);
            return out;
        }

        public static Config decode(byte[] p) throws IOException {
            if (p == null || p.length < 18) throw new IOException("CONFIG too short");
            int w = getInt(p, 0), h = getInt(p, 4);
            int rot = p[8] & 3, flags = p[9] & 0xFF;
            int sl = getInt(p, 10);
            if (sl < 0 || 14 + sl + 4 > p.length) throw new IOException("CONFIG bad SPS length");
            int pl = getInt(p, 14 + sl);
            if (pl < 0 || 18 + sl + pl != p.length) throw new IOException("CONFIG bad PPS length");
            if (w < 16 || h < 16 || w > 8192 || h > 8192) throw new IOException("CONFIG bad size " + w + "x" + h);
            byte[] sps = new byte[sl], pps = new byte[pl];
            System.arraycopy(p, 14, sps, 0, sl);
            System.arraycopy(p, 18 + sl, pps, 0, pl);
            return new Config(w, h, rot, flags, sps, pps);
        }

        public boolean sameStream(Config o) {
            return o != null && o.width == width && o.height == height && java.util.Arrays.equals(o.sps, sps)
                    && java.util.Arrays.equals(o.pps, pps);
        }
    }

    public static final class Frame {
        public final boolean key;
        public final long ptsUs;
        /** Access unit data: payload[FRAME_HEADER_LEN..]. */
        public final byte[] payload;
        public final long receivedMs;

        public Frame(boolean key, long ptsUs, byte[] payload, long receivedMs) {
            this.key = key;
            this.ptsUs = ptsUs;
            this.payload = payload;
            this.receivedMs = receivedMs;
        }

        public int dataOffset() {
            return FRAME_HEADER_LEN;
        }

        public int dataLength() {
            return payload.length - FRAME_HEADER_LEN;
        }

        public static Frame decode(byte[] p, long nowMs) throws IOException {
            if (p == null || p.length <= FRAME_HEADER_LEN) throw new IOException("FRAME too short");
            return new Frame((p[0] & FLAG_KEY) != 0, getLong(p, 1), p, nowMs);
        }
    }

    // ---------- Annex-B ----------

    /** NAL units of an Annex-B buffer, each returned with its start code (00 00 00 01 or 00 00 01). */
    public static List<byte[]> splitAnnexB(byte[] b, int off, int len) {
        List<byte[]> out = new ArrayList<>();
        int end = off + len;
        int start = -1;
        int i = off;
        while (i + 2 < end) {
            if (b[i] == 0 && b[i + 1] == 0 && (b[i + 2] == 1 || (i + 3 < end && b[i + 2] == 0 && b[i + 3] == 1))) {
                if (start >= 0) {
                    out.add(copy(b, start, i - start));
                }
                start = i;
                i += b[i + 2] == 1 ? 3 : 4;
            } else {
                i++;
            }
        }
        if (start >= 0) out.add(copy(b, start, end - start));
        return out;
    }

    /** H.264 NAL unit type of a unit that starts with a start code, or -1. */
    public static int nalType(byte[] unit) {
        int i = 0;
        while (i < unit.length && unit[i] == 0) i++;
        if (i >= unit.length - 1 || unit[i] != 1) return -1;
        return unit[i + 1] & 0x1F;
    }

    /** {sps, pps} found in an encoder's codec-config buffer (either may be empty if absent). */
    public static byte[][] spsPps(byte[] b, int off, int len) {
        ByteArrayOutputStream sps = new ByteArrayOutputStream(), pps = new ByteArrayOutputStream();
        for (byte[] u : splitAnnexB(b, off, len)) {
            int t = nalType(u);
            if (t == 7) sps.write(u, 0, u.length);
            else if (t == 8) pps.write(u, 0, u.length);
        }
        return new byte[][] {sps.toByteArray(), pps.toByteArray()};
    }

    // ---------- link (QR code) ----------

    /** TV address from the QR link: https://.../tv/phone.html#h=IP&p=PORT&k=SECRET&n=NAME (or officetvphone://connect?...). */
    public static final class Link {
        public final String host;
        public final int port;
        public final byte[] secret;
        public final String name;

        public Link(String host, int port, byte[] secret, String name) {
            this.host = host;
            this.port = port;
            this.secret = secret;
            this.name = name;
        }

        /** Parses the fragment or query of a link; null if host, port or secret are missing or invalid. */
        public static Link parse(String url) {
            if (url == null) return null;
            int hash = url.indexOf('#');
            int q = url.indexOf('?');
            String params;
            if (hash >= 0 && url.indexOf("h=", hash) > 0) params = url.substring(hash + 1);
            else if (q >= 0) params = url.substring(q + 1, hash > q ? hash : url.length());
            else return null;
            String h = null, p = null, k = null, n = null;
            for (String part : params.split("&")) {
                int eq = part.indexOf('=');
                if (eq <= 0) continue;
                String key = part.substring(0, eq), val = decode(part.substring(eq + 1));
                if ("h".equals(key)) h = val;
                else if ("p".equals(key)) p = val;
                else if ("k".equals(key)) k = val;
                else if ("n".equals(key)) n = val;
            }
            if (h == null || !validHost(h) || p == null || k == null) return null;
            int port;
            try {
                port = Integer.parseInt(p);
            } catch (NumberFormatException e) {
                return null;
            }
            if (port < 1 || port > 65535) return null;
            byte[] secret = base64UrlDecode(k);
            if (secret == null || secret.length != SECRET_LEN) return null;
            if (n != null) {
                n = n.trim();
                if (n.length() > 40) n = n.substring(0, 40);
            }
            return new Link(h, port, secret, n == null || n.isEmpty() ? "Office TV" : n);
        }

        /** Query string h=..&p=..&k=..&n=.. (for officetvphone://connect?...). */
        public String query() {
            return "h=" + encode(host) + "&p=" + port + "&k=" + base64UrlEncode(secret) + "&n=" + encode(name);
        }
    }

    /** IPv4 dotted quad or a simple hostname: letters, digits, '.', '-', ':' (IPv6). */
    public static boolean validHost(String h) {
        if (h.isEmpty() || h.length() > 253) return false;
        for (int i = 0; i < h.length(); i++) {
            char c = h.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.'
                    || c == '-' || c == ':';
            if (!ok) return false;
        }
        return true;
    }

    public static String encode(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    static String decode(String s) {
        try {
            return URLDecoder.decode(s.replace("+", "%2B"), "UTF-8");
        } catch (UnsupportedEncodingException | IllegalArgumentException e) {
            return s;
        }
    }

    // ---------- base64url (the JDK Base64 class needs API 26) ----------

    private static final String B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    public static String base64UrlEncode(byte[] b) {
        StringBuilder s = new StringBuilder((b.length * 4 + 2) / 3);
        for (int i = 0; i < b.length; i += 3) {
            int n = (b[i] & 0xFF) << 16 | (i + 1 < b.length ? (b[i + 1] & 0xFF) << 8 : 0)
                    | (i + 2 < b.length ? b[i + 2] & 0xFF : 0);
            s.append(B64.charAt(n >> 18 & 63)).append(B64.charAt(n >> 12 & 63));
            if (i + 1 < b.length) s.append(B64.charAt(n >> 6 & 63));
            if (i + 2 < b.length) s.append(B64.charAt(n & 63));
        }
        return s.toString();
    }

    /** Decodes base64url (padding and standard '+' '/' also accepted); null if invalid. */
    public static byte[] base64UrlDecode(String s) {
        if (s == null) return null;
        s = s.trim();
        while (s.endsWith("=")) s = s.substring(0, s.length() - 1);
        if (s.length() % 4 == 1) return null;
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length() * 3 / 4);
        int acc = 0, bits = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '+') c = '-';
            else if (c == '/') c = '_';
            int v = B64.indexOf(c);
            if (v < 0) return null;
            acc = acc << 6 | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out.write(acc >> bits & 0xFF);
            }
        }
        return out.toByteArray();
    }

    // ---------- encoder size ----------

    /**
     * Encoder size for a screen of w x h pixels: aspect ratio kept, long side at most maxLong, never upscaled,
     * both sides rounded down to a multiple of align (2 = even, 16 = macroblock aligned). Returns {width, height}.
     */
    public static int[] fitSize(int w, int h, int maxLong, int align) {
        if (w <= 0 || h <= 0) throw new IllegalArgumentException("size");
        double s = Math.min(1.0, (double) maxLong / Math.max(w, h));
        int ow = (int) Math.floor(w * s + 1e-6), oh = (int) Math.floor(h * s + 1e-6);
        ow = Math.max(align, ow - ow % align);
        oh = Math.max(align, oh - oh % align);
        return new int[] {ow, oh};
    }

    // ---------- bytes ----------

    public static void readFully(InputStream in, byte[] b, int off, int len) throws IOException {
        while (len > 0) {
            int n = in.read(b, off, len);
            if (n < 0) throw new EOFException();
            off += n;
            len -= n;
        }
    }

    static byte[] copy(byte[] b, int off, int len) {
        byte[] o = new byte[len];
        System.arraycopy(b, off, o, 0, len);
        return o;
    }

    static void putInt(byte[] b, int o, int v) {
        b[o] = (byte) (v >>> 24);
        b[o + 1] = (byte) (v >>> 16);
        b[o + 2] = (byte) (v >>> 8);
        b[o + 3] = (byte) v;
    }

    static int getInt(byte[] b, int o) {
        return (b[o] & 0xFF) << 24 | (b[o + 1] & 0xFF) << 16 | (b[o + 2] & 0xFF) << 8 | (b[o + 3] & 0xFF);
    }

    static void putLong(byte[] b, int o, long v) {
        putInt(b, o, (int) (v >>> 32));
        putInt(b, o + 4, (int) v);
    }

    static long getLong(byte[] b, int o) {
        return ((long) getInt(b, o) << 32) | (getInt(b, o + 4) & 0xFFFFFFFFL);
    }
}
