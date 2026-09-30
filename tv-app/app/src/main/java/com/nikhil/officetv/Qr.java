package com.nikhil.officetv;

import android.graphics.Bitmap;
import android.graphics.Color;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Locale;
import java.util.Map;

/** The phone QR code on the TV home screen, and the TV's address on the local network. */
final class Qr {
    static final String PHONE_PAGE = "https://nikhildiwakar-bit.github.io/Portfolio/tv/phone.html";

    private Qr() {}

    /** Link in the QR code: PHONE_PAGE#h=IP&p=PORT&k=SECRET&n=NAME&c=CODE (the fragment never reaches a server). */
    static String phoneLink(String ip, int port, byte[] secret, String name, String code) {
        // c = the TV code: lets the phone's browser share its screen without the app (same as a laptop).
        return PHONE_PAGE + "#" + new com.nikhil.officetv.mirror.MirrorProtocol.Link(ip, port, secret, name).query()
                + "&c=" + code;
    }

    /** Black-on-white QR code, one pixel per module plus a 2-module quiet zone (scale it without filtering). */
    static Bitmap bitmap(String text) {
        try {
            Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
            hints.put(EncodeHintType.MARGIN, 2);
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            BitMatrix m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints);
            int w = m.getWidth(), h = m.getHeight();
            int[] px = new int[w * h];
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) px[y * w + x] = m.get(x, y) ? Color.BLACK : Color.WHITE;
            }
            Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            b.setPixels(px, 0, w, 0, 0, w, h);
            return b;
        } catch (WriterException | RuntimeException e) {
            return null;
        }
    }

    /** The TV's IPv4 address on the local network (Wi-Fi or Ethernet first), or null. */
    static String lanAddress() {
        String best = null;
        int bestScore = -1;
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String n = ni.getName() == null ? "" : ni.getName().toLowerCase(Locale.US);
                if (n.startsWith("tun") || n.startsWith("rmnet") || n.startsWith("dummy") || n.startsWith("p2p")) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    int score = (a.isSiteLocalAddress() ? 2 : 0)
                            + (n.startsWith("wlan") || n.startsWith("eth") ? 1 : 0);
                    if (score > bestScore) {
                        bestScore = score;
                        best = a.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return best;
    }
}
