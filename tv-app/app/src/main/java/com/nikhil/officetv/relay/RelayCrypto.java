package com.nikhil.officetv.relay;

import java.security.GeneralSecurityException;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * End-to-end envelope crypto (PROTOCOL.md sections 2, 3): AES-256-GCM, 12-byte IV, 128-bit tag,
 * AAD = topic for messages and topic + ":file" for file attachments. Thread-safe.
 */
public final class RelayCrypto {
    public static final String PREFIX = "otv1.";
    public static final int IV_BYTES = 12;
    public static final int TAG_BYTES = 16;

    private static final String ALG = "AES/GCM/NoPadding";
    private static final char[] B64 =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();
    private static final int[] UNB64 = new int[128];
    private static final SecureRandom RNG = new SecureRandom();

    static {
        for (int i = 0; i < UNB64.length; i++) UNB64[i] = -1;
        for (int i = 0; i < B64.length; i++) UNB64[B64[i]] = i;
    }

    private final String topic;
    private final SecretKeySpec key;
    private final byte[] aad;
    private final byte[] fileAad;

    /** Derives topic and key from a normalized pairing code. */
    public RelayCrypto(String code) {
        topic = Pairing.topic(code);
        key = new SecretKeySpec(Pairing.key(code), "AES");
        aad = topic.getBytes(Pairing.UTF8);
        fileAad = (topic + ":file").getBytes(Pairing.UTF8);
    }

    public String topic() {
        return topic;
    }

    /** Encrypts a JSON plaintext into an "otv1.<iv>.<ct>" envelope with a random IV. */
    public String seal(String plaintext) {
        return sealWithIv(plaintext, randomIv());
    }

    /** Same as {@link #seal} with a caller-chosen 12-byte IV (tests / vectors only; never reuse an IV). */
    public String sealWithIv(String plaintext, byte[] iv) {
        if (iv == null || iv.length != IV_BYTES) throw new IllegalArgumentException("IV must be 12 bytes");
        try {
            byte[] ct = crypt(Cipher.ENCRYPT_MODE, iv, aad, plaintext.getBytes(Pairing.UTF8), 0, -1);
            return PREFIX + b64url(iv) + "." + b64url(ct);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("AES-GCM not available", e);
        }
    }

    /** Returns the plaintext, or null if the text is not an otv1 envelope, is tampered or uses another key. */
    public String open(String envelope) {
        if (envelope == null || !envelope.startsWith(PREFIX)) return null;
        try {
            String rest = envelope.substring(PREFIX.length()).trim();
            int dot = rest.indexOf('.');
            if (dot < 0 || rest.indexOf('.', dot + 1) >= 0) return null;
            byte[] iv = unb64url(rest.substring(0, dot));
            byte[] ct = unb64url(rest.substring(dot + 1));
            if (iv.length != IV_BYTES || ct.length < TAG_BYTES) return null;
            return new String(crypt(Cipher.DECRYPT_MODE, iv, aad, ct, 0, -1), Pairing.UTF8);
        } catch (Exception e) {
            return null;
        }
    }

    /** Decrypts a file attachment (ciphertext || tag). Throws AEADBadTagException if tampered. */
    public byte[] openFile(byte[] ciphertext, byte[] iv) throws GeneralSecurityException {
        return openFile(ciphertext, 0, ciphertext == null ? 0 : ciphertext.length, iv);
    }

    byte[] openFile(byte[] buf, int off, int len, byte[] iv) throws GeneralSecurityException {
        if (iv == null || iv.length != IV_BYTES) throw new GeneralSecurityException("File IV galat hai.");
        if (buf == null || len < TAG_BYTES) throw new GeneralSecurityException("File adhoori hai.");
        return crypt(Cipher.DECRYPT_MODE, iv, fileAad, buf, off, len);
    }

    /** Encrypts file bytes the way the controller does (AAD topic + ":file"). Used by tests and tools. */
    public byte[] sealFile(byte[] plaintext, byte[] iv) throws GeneralSecurityException {
        if (iv == null || iv.length != IV_BYTES) throw new GeneralSecurityException("IV must be 12 bytes");
        return crypt(Cipher.ENCRYPT_MODE, iv, fileAad, plaintext, 0, -1);
    }

    public static byte[] randomIv() {
        byte[] iv = new byte[IV_BYTES];
        RNG.nextBytes(iv);
        return iv;
    }

    /** Envelope length in bytes (ASCII) for a plaintext of the given UTF-8 size. */
    public static int envelopeLength(int plaintextBytes) {
        return PREFIX.length() + b64Length(IV_BYTES) + 1 + b64Length(plaintextBytes + TAG_BYTES);
    }

    private byte[] crypt(int mode, byte[] iv, byte[] ad, byte[] in, int off, int len)
            throws GeneralSecurityException {
        Cipher c = Cipher.getInstance(ALG);
        c.init(mode, key, new GCMParameterSpec(TAG_BYTES * 8, iv));
        c.updateAAD(ad);
        return c.doFinal(in, off, len < 0 ? in.length - off : len);
    }

    static int b64Length(int n) {
        return (n * 4 + 2) / 3;
    }

    /** base64url without padding (RFC 4648 section 5). */
    public static String b64url(byte[] b) {
        char[] out = new char[b64Length(b.length)];
        int o = 0;
        int i = 0;
        for (; i + 2 < b.length; i += 3) {
            int v = (b[i] & 0xff) << 16 | (b[i + 1] & 0xff) << 8 | (b[i + 2] & 0xff);
            out[o++] = B64[v >>> 18];
            out[o++] = B64[(v >>> 12) & 63];
            out[o++] = B64[(v >>> 6) & 63];
            out[o++] = B64[v & 63];
        }
        int rem = b.length - i;
        if (rem == 1) {
            int v = (b[i] & 0xff) << 16;
            out[o++] = B64[v >>> 18];
            out[o++] = B64[(v >>> 12) & 63];
        } else if (rem == 2) {
            int v = (b[i] & 0xff) << 16 | (b[i + 1] & 0xff) << 8;
            out[o++] = B64[v >>> 18];
            out[o++] = B64[(v >>> 12) & 63];
            out[o++] = B64[(v >>> 6) & 63];
        }
        return new String(out, 0, o);
    }

    /** Decodes base64url with or without '=' padding. Throws IllegalArgumentException on bad input. */
    public static byte[] unb64url(String s) {
        if (s == null) throw new IllegalArgumentException("null base64url");
        int len = s.length();
        while (len > 0 && s.charAt(len - 1) == '=') len--;
        if (len % 4 == 1) throw new IllegalArgumentException("bad base64url length");
        byte[] out = new byte[len * 3 / 4];
        int o = 0;
        int acc = 0;
        int bits = 0;
        for (int i = 0; i < len; i++) {
            char ch = s.charAt(i);
            int v = ch < 128 ? UNB64[ch] : -1;
            if (v < 0) throw new IllegalArgumentException("bad base64url character");
            acc = (acc << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[o++] = (byte) (acc >> bits);
                acc &= (1 << bits) - 1;
            }
        }
        return out;
    }
}
