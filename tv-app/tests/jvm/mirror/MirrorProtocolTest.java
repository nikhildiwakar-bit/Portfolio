package com.nikhil.officetv.mirror;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Random;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Phone mirroring protocol (PROTOCOL.md section 10): handshake, framing, CONFIG/FRAME payloads, Annex-B
 * parsing, QR link parsing, base64url and encoder sizes; plus a real TCP loopback session. No JUnit needed.
 */
public final class MirrorProtocolTest {
    private static int pass, fail;

    public static void main(String[] args) throws Exception {
        handshake();
        framing();
        config();
        annexB();
        link();
        base64();
        sizes();
        audio();
        loopback();
        System.out.println(pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }

    static void ok(boolean c, String name) {
        if (c) pass++;
        else fail++;
        System.out.println((c ? "  ok   " : "  FAIL ") + name);
    }

    static byte[] bytes(int n, int seed) {
        byte[] b = new byte[n];
        new Random(seed).nextBytes(b);
        return b;
    }

    static void handshake() throws IOException {
        System.out.println("-- handshake");
        byte[] secret = bytes(32, 1), other = bytes(32, 2), nonce = bytes(16, 3);
        byte[] hello = MirrorProtocol.clientHello(secret, nonce);
        ok(hello.length == 53, "hello is 53 bytes");
        ok(new String(hello, 0, 5, "US-ASCII").equals("OTVP1"), "hello starts with OTVP1");
        ok(MirrorProtocol.verifyHello(secret, hello), "right secret verifies");
        ok(!MirrorProtocol.verifyHello(other, hello), "wrong secret is rejected");
        byte[] bad = hello.clone();
        bad[52] ^= 1;
        ok(!MirrorProtocol.verifyHello(secret, bad), "tampered MAC is rejected");
        bad = hello.clone();
        bad[0] = 'X';
        ok(!MirrorProtocol.hasMagic(bad) && !MirrorProtocol.verifyHello(secret, bad), "bad magic is rejected");
        ok(!MirrorProtocol.verifyHello(secret, Arrays.copyOf(hello, 40)), "short hello is rejected");
        // The phone label and the TV label give different MACs (a reply can not be replayed as a hello).
        ok(!Arrays.equals(MirrorProtocol.hmac(secret, nonce, "phone"), MirrorProtocol.hmac(secret, nonce, "tv")),
                "phone and tv MACs differ");
        byte[] reply = MirrorProtocol.okReply(secret, nonce);
        ok(reply.length == 34, "OK reply is 34 bytes");
        ok(MirrorProtocol.readReply(new ByteArrayInputStream(reply), secret, nonce) == 0, "phone accepts the right TV");
        ok(MirrorProtocol.readReply(new ByteArrayInputStream(MirrorProtocol.okReply(other, nonce)), secret, nonce) == -1,
                "phone rejects a TV without the secret");
        ok(MirrorProtocol.readReply(new ByteArrayInputStream(MirrorProtocol.okReply(secret, bytes(16, 9))), secret, nonce)
                == -1, "phone rejects a replayed reply for another nonce");
        ok(MirrorProtocol.readReply(new ByteArrayInputStream(MirrorProtocol.rejectReply(MirrorProtocol.REJECT_BUSY)),
                secret, nonce) == MirrorProtocol.REJECT_BUSY, "busy reason is read");
        ok(MirrorProtocol.readReply(new ByteArrayInputStream(MirrorProtocol.rejectReply(MirrorProtocol.REJECT_AUTH)),
                secret, nonce) == MirrorProtocol.REJECT_AUTH, "auth reason is read");
        ok(MirrorProtocol.readReply(new ByteArrayInputStream(new byte[] {'H', 'T', 'T', 'P'}), secret, nonce) == -1,
                "garbage reply is rejected");
        ok(MirrorProtocol.constantTimeEquals(new byte[] {1, 2}, new byte[] {1, 2})
                && !MirrorProtocol.constantTimeEquals(new byte[] {1, 2}, new byte[] {1, 3})
                && !MirrorProtocol.constantTimeEquals(new byte[] {1}, new byte[] {1, 2}), "constantTimeEquals");
    }

    static void framing() throws IOException {
        System.out.println("-- framing");
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] au = bytes(5000, 4);
        MirrorProtocol.writeMessage(bo, MirrorProtocol.T_PING, null);
        MirrorProtocol.writeFrame(bo, true, 123456789012L, au, 10, 4000);
        MirrorProtocol.writeMessage(bo, MirrorProtocol.T_BYE, MirrorProtocol.byePayload(true, "TV busy \u2013 later"));
        byte[] wire = bo.toByteArray();
        ok(wire[0] == 3 && wire[1] == 0 && wire[4] == 0, "PING header: type 3, length 0 (big-endian)");
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(wire));
        MirrorProtocol.Message m = MirrorProtocol.readMessage(in);
        ok(m.type == MirrorProtocol.T_PING && m.payload.length == 0, "PING read back");
        m = MirrorProtocol.readMessage(in);
        ok(m.type == MirrorProtocol.T_FRAME && m.payload.length == 9 + 4000, "FRAME length = 9 + data");
        MirrorProtocol.Frame f = MirrorProtocol.Frame.decode(m.payload, 0);
        ok(f.key && f.ptsUs == 123456789012L, "FRAME key flag and pts");
        ok(Arrays.equals(Arrays.copyOfRange(f.payload, f.dataOffset(), f.dataOffset() + f.dataLength()),
                Arrays.copyOfRange(au, 10, 4010)), "FRAME data");
        m = MirrorProtocol.readMessage(in);
        ok(m.type == MirrorProtocol.T_BYE && MirrorProtocol.byeIsError(m.payload)
                && MirrorProtocol.byeReason(m.payload).equals("TV busy \u2013 later"), "BYE with error kind and reason");
        ok(!MirrorProtocol.byeIsError(new byte[0]) && MirrorProtocol.byeReason(new byte[0]).isEmpty()
                && !MirrorProtocol.byeIsError(MirrorProtocol.byePayload(false, "x")), "empty and normal BYE");
        boolean eof = false;
        try {
            MirrorProtocol.readMessage(in);
        } catch (EOFException e) {
            eof = true;
        }
        ok(eof, "clean end of stream is EOFException");
        boolean tooBig = false;
        try {
            MirrorProtocol.readMessage(new DataInputStream(new ByteArrayInputStream(
                    new byte[] {2, (byte) 0x7F, (byte) 0xFF, (byte) 0xFF, (byte) 0xFF})));
        } catch (EOFException e) {
            tooBig = false;
        } catch (IOException e) {
            tooBig = true;
        }
        ok(tooBig, "oversized length is refused before allocating");
        boolean truncated = false;
        try {
            MirrorProtocol.readMessage(new DataInputStream(new ByteArrayInputStream(new byte[] {2, 0, 0, 0, 20, 1, 2})));
        } catch (EOFException e) {
            truncated = true;
        }
        ok(truncated, "truncated payload is EOFException");
        boolean shortFrame = false;
        try {
            MirrorProtocol.Frame.decode(new byte[9], 0);
        } catch (IOException e) {
            shortFrame = true;
        }
        ok(shortFrame, "FRAME without data is refused");
    }

    static void config() throws IOException {
        System.out.println("-- CONFIG");
        byte[] sps = {0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1F}, pps = {0, 0, 0, 1, 0x68, (byte) 0xCE, 0x3C, (byte) 0x80};
        MirrorProtocol.Config c = new MirrorProtocol.Config(1080, 1920, 1, 0, sps, pps);
        MirrorProtocol.Config d = MirrorProtocol.Config.decode(c.encode());
        ok(d.width == 1080 && d.height == 1920 && d.rotation == 1, "size and rotation round-trip");
        ok(Arrays.equals(d.sps, sps) && Arrays.equals(d.pps, pps), "SPS and PPS round-trip");
        ok(c.sameStream(d) && !c.sameStream(new MirrorProtocol.Config(1920, 1080, 0, 0, sps, pps)), "sameStream");
        byte[] enc = c.encode();
        String[] names = {"too short", "bad SPS length", "trailing bytes", "tiny size"};
        byte[][] bads = {Arrays.copyOf(enc, 10), enc.clone(), Arrays.copyOf(enc, enc.length + 1),
            new MirrorProtocol.Config(8, 8, 0, 0, sps, pps).encode()};
        bads[1][13] = 100;
        for (int i = 0; i < bads.length; i++) {
            boolean refused = false;
            try {
                MirrorProtocol.Config.decode(bads[i]);
            } catch (IOException e) {
                refused = true;
            }
            ok(refused, "CONFIG " + names[i] + " is refused");
        }
    }

    static void annexB() {
        System.out.println("-- Annex-B");
        byte[] b = {0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 1, 0x68, 4, 5, 0, 0, 0, 1, 0x65, 9, 9, 9};
        List<byte[]> units = MirrorProtocol.splitAnnexB(b, 0, b.length);
        ok(units.size() == 3, "three NAL units");
        ok(MirrorProtocol.nalType(units.get(0)) == 7 && MirrorProtocol.nalType(units.get(1)) == 8
                && MirrorProtocol.nalType(units.get(2)) == 5, "types SPS, PPS, IDR");
        byte[][] sp = MirrorProtocol.spsPps(b, 0, b.length);
        ok(Arrays.equals(sp[0], new byte[] {0, 0, 0, 1, 0x67, 1, 2, 3}), "SPS kept with its start code");
        ok(Arrays.equals(sp[1], new byte[] {0, 0, 1, 0x68, 4, 5}), "PPS kept with its start code");
        ok(MirrorProtocol.splitAnnexB(new byte[] {1, 2, 3}, 0, 3).isEmpty(), "no start code: no units");
    }

    static void link() {
        System.out.println("-- QR link");
        byte[] secret = bytes(32, 5);
        String k = MirrorProtocol.base64UrlEncode(secret);
        ok(k.length() == 43 && k.matches("[A-Za-z0-9_-]+"), "secret is 43 base64url chars");
        String url = "https://nikhildiwakar-bit.github.io/Portfolio/tv/phone.html#h=192.168.1.20&p=47300&k=" + k
                + "&n=Conference%20Room%20%E2%80%93%203";
        MirrorProtocol.Link l = MirrorProtocol.Link.parse(url);
        ok(l != null && l.host.equals("192.168.1.20") && l.port == 47300 && Arrays.equals(l.secret, secret),
                "fragment link parses");
        ok(l != null && l.name.equals("Conference Room – 3"), "name is URL-decoded (spaces, unicode)");
        MirrorProtocol.Link q = MirrorProtocol.Link.parse("officetvphone://connect?" + l.query());
        ok(q != null && q.host.equals(l.host) && q.port == l.port && Arrays.equals(q.secret, secret)
                && q.name.equals(l.name), "custom scheme query round-trips");
        ok(MirrorProtocol.Link.parse(url.replace("p=47300", "p=70000")) == null, "port out of range");
        ok(MirrorProtocol.Link.parse(url.replace("k=" + k, "k=" + k.substring(3))) == null, "short secret");
        ok(MirrorProtocol.Link.parse(url.replace("h=192.168.1.20", "h=evil/host")) == null, "bad host");
        ok(MirrorProtocol.Link.parse("https://nikhildiwakar-bit.github.io/Portfolio/tv/phone.html") == null, "no params");
        MirrorProtocol.Link noName = MirrorProtocol.Link.parse("officetvphone://connect?h=10.0.0.2&p=47301&k=" + k);
        ok(noName != null && noName.name.equals("Office TV"), "missing name defaults to Office TV");
    }

    static void base64() {
        System.out.println("-- base64url");
        boolean all = true;
        for (int n = 0; n < 70; n++) {
            byte[] b = bytes(n, 100 + n);
            String mine = MirrorProtocol.base64UrlEncode(b);
            String jdk = Base64.getUrlEncoder().withoutPadding().encodeToString(b);
            if (!mine.equals(jdk) || !Arrays.equals(MirrorProtocol.base64UrlDecode(mine), b)) all = false;
            String padded = Base64.getEncoder().encodeToString(b);
            if (!Arrays.equals(MirrorProtocol.base64UrlDecode(padded), b)) all = false;
        }
        ok(all, "matches java.util.Base64 for 0..69 bytes (url and standard input)");
        ok(MirrorProtocol.base64UrlDecode("ab$d") == null && MirrorProtocol.base64UrlDecode("a") == null,
                "invalid input is null");
    }

    static void sizes() {
        System.out.println("-- encoder size");
        ok(Arrays.equals(MirrorProtocol.fitSize(1080, 2400, 1920, 2), new int[] {864, 1920}), "1080x2400 -> 864x1920");
        ok(Arrays.equals(MirrorProtocol.fitSize(2400, 1080, 1920, 16), new int[] {1920, 864}), "landscape, 16-aligned");
        ok(Arrays.equals(MirrorProtocol.fitSize(720, 1280, 1920, 2), new int[] {720, 1280}), "never upscaled");
        ok(Arrays.equals(MirrorProtocol.fitSize(1081, 1921, 1920, 2), new int[] {1080, 1920}), "odd sides made even"); ok(Arrays.equals(MirrorProtocol.fitSize(721, 1281, 1920, 2), new int[] {720, 1280}), "odd sides made even (no scaling)");
        int[] s = MirrorProtocol.fitSize(1440, 3200, 1920, 16);
        ok(s[0] % 16 == 0 && s[1] % 16 == 0 && s[1] <= 1920, "1440x3200 16-aligned within 1920: " + s[0] + "x" + s[1]);
    }

    /** A TV-like server and a phone-like client over real TCP on 127.0.0.1. */
    static void audio() throws IOException {
        MirrorProtocol.AudioConfig c = new MirrorProtocol.AudioConfig(48000, 2, MirrorProtocol.AUDIO_PCM16);
        MirrorProtocol.AudioConfig d = MirrorProtocol.AudioConfig.decode(c.encode());
        ok(d.sampleRate == 48000 && d.channels == 2 && d.encoding == MirrorProtocol.AUDIO_PCM16, "AUDIO_CONFIG round trip");
        ok(d.frameBytes() == 4 && d.bytesFor(10) == 1920, "48 kHz stereo: 1920 bytes per 10 ms");
        for (byte[] bad : new byte[][] {
            null, new byte[5],
            new MirrorProtocol.AudioConfig(4000, 2, 1).encode(),
            new MirrorProtocol.AudioConfig(48000, 3, 1).encode(),
            new MirrorProtocol.AudioConfig(48000, 0, 1).encode(),
            new MirrorProtocol.AudioConfig(48000, 2, 9).encode(),
        }) {
            boolean threw = false;
            try {
                MirrorProtocol.AudioConfig.decode(bad);
            } catch (IOException e) {
                threw = true;
            }
            ok(threw, "bad AUDIO_CONFIG refused (" + (bad == null ? "null" : bad.length + " bytes") + ")");
        }
        byte[] pcm = bytes(1920, 21);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        MirrorProtocol.writeAudio(bo, 123456789L, pcm, 0, pcm.length);
        MirrorProtocol.Message m = MirrorProtocol.readMessage(new DataInputStream(new ByteArrayInputStream(bo.toByteArray())));
        ok(m.type == MirrorProtocol.T_AUDIO && m.payload.length == 8 + 1920, "AUDIO framing");
        ok(MirrorProtocol.getLong(m.payload, 0) == 123456789L, "AUDIO pts");
        ok(Arrays.equals(MirrorProtocol.audioData(m.payload), pcm), "AUDIO data");
        ok(MirrorProtocol.audioData(new byte[8]) == null && MirrorProtocol.audioData(null) == null, "empty AUDIO ignored");
        ok(MirrorProtocol.pcmRms(new byte[1920], 0, 1920) == 0, "silence has RMS 0");
        byte[] loud = new byte[4];
        loud[0] = (byte) 0xFF; loud[1] = 0x7F; loud[2] = 0x01; loud[3] = (byte) 0x80; // +32767, -32767
        ok(Math.abs(MirrorProtocol.pcmRms(loud, 0, 4) - 32767) < 0.01, "full scale RMS 32767");
        ok(MirrorProtocol.T_AUDIO_CONFIG == 6 && MirrorProtocol.T_AUDIO == 7 && MirrorProtocol.T_CAPS == 8,
                "sound message types 6, 7 and CAPS 8");
        ok(MirrorProtocol.capsFlags(MirrorProtocol.capsPayload(MirrorProtocol.CAP_AUDIO)) == MirrorProtocol.CAP_AUDIO,
                "CAPS round trip");
        ok(MirrorProtocol.capsFlags(new byte[0]) == 0 && MirrorProtocol.capsFlags(null) == 0, "empty CAPS: no sound");
    }

    static void loopback() throws Exception {
        System.out.println("-- TCP loopback session");
        final byte[] secret = bytes(32, 7);
        final ServerSocket ss = new ServerSocket(0, 2, InetAddress.getByName("127.0.0.1"));
        final AtomicReference<String> got = new AtomicReference<>("");
        Thread server = new Thread(() -> {
            try {
                for (int round = 0; round < 2; round++) {
                    try (Socket c = ss.accept()) {
                        c.setSoTimeout(3000);
                        InputStream in = c.getInputStream();
                        OutputStream out = c.getOutputStream();
                        byte[] hello = new byte[MirrorProtocol.HELLO_LEN];
                        MirrorProtocol.readFully(in, hello, 0, hello.length);
                        if (!MirrorProtocol.verifyHello(secret, hello)) {
                            out.write(MirrorProtocol.rejectReply(MirrorProtocol.REJECT_AUTH));
                            got.set(got.get() + "rejected;");
                            continue;
                        }
                        out.write(MirrorProtocol.okReply(secret, MirrorProtocol.nonceOf(hello)));
                        DataInputStream din = new DataInputStream(in);
                        StringBuilder sb = new StringBuilder();
                        while (true) {
                            MirrorProtocol.Message m = MirrorProtocol.readMessage(din);
                            if (m.type == MirrorProtocol.T_CONFIG) {
                                MirrorProtocol.Config cfg = MirrorProtocol.Config.decode(m.payload);
                                sb.append("config ").append(cfg.width).append('x').append(cfg.height).append(';');
                                MirrorProtocol.writeMessage(out, MirrorProtocol.T_KEYREQ, null);
                            } else if (m.type == MirrorProtocol.T_FRAME) {
                                MirrorProtocol.Frame f = MirrorProtocol.Frame.decode(m.payload, 0);
                                sb.append(f.key ? "K" : "f");
                            } else if (m.type == MirrorProtocol.T_BYE) {
                                sb.append(";bye");
                                break;
                            }
                        }
                        got.set(got.get() + sb);
                    }
                }
            } catch (IOException e) {
                got.set(got.get() + "server error " + e);
            }
        });
        server.start();
        // 1) wrong secret: rejected with REJECT_AUTH.
        try (Socket c = new Socket("127.0.0.1", ss.getLocalPort())) {
            byte[] nonce = bytes(16, 11);
            c.getOutputStream().write(MirrorProtocol.clientHello(bytes(32, 8), nonce));
            ok(MirrorProtocol.readReply(c.getInputStream(), bytes(32, 8), nonce) == MirrorProtocol.REJECT_AUTH,
                    "old QR code (wrong secret) gets REJECT_AUTH");
        }
        // 2) right secret: CONFIG, KEYREQ back, frames, BYE.
        try (Socket c = new Socket("127.0.0.1", ss.getLocalPort())) {
            c.setTcpNoDelay(true);
            c.setSoTimeout(3000);
            byte[] nonce = bytes(16, 12);
            OutputStream out = c.getOutputStream();
            out.write(MirrorProtocol.clientHello(secret, nonce));
            ok(MirrorProtocol.readReply(c.getInputStream(), secret, nonce) == 0, "handshake OK and TV proven");
            MirrorProtocol.writeMessage(out, MirrorProtocol.T_CONFIG,
                    new MirrorProtocol.Config(864, 1920, 0, 0, new byte[] {0, 0, 0, 1, 0x67}, new byte[] {0, 0, 0, 1, 0x68})
                            .encode());
            MirrorProtocol.Message m = MirrorProtocol.readMessage(new DataInputStream(c.getInputStream()));
            ok(m.type == MirrorProtocol.T_KEYREQ, "TV asks for a key frame");
            byte[] au = bytes(30000, 13);
            MirrorProtocol.writeFrame(out, true, 0, au, 0, au.length);
            for (int i = 1; i <= 3; i++) MirrorProtocol.writeFrame(out, false, i * 16666L, au, 0, 1000);
            MirrorProtocol.writeMessage(out, MirrorProtocol.T_BYE, null);
        }
        server.join(5000);
        ss.close();
        ok(got.get().equals("rejected;config 864x1920;Kfff;bye"), "server saw: " + got.get());
    }
}
