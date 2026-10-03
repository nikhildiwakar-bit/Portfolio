package com.nikhil.officetv.relay;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A small MQTT 3.1.1 broker over WebSocket for the JVM tests (ws://127.0.0.1:port/mqtt, or wss:// with a
 * {@link TestTls}). Written independently of the relay package's client (own frame and packet parsing), so the
 * tests do not check the client against itself. It speaks what Office TV uses: CONNECT / CONNACK, SUBSCRIBE /
 * SUBACK, PUBLISH fan-out to every subscriber of the exact topic (the publisher included, as in MQTT 3.1.1),
 * PINGREQ / PINGRESP, DISCONNECT, and records everything.
 * <p>
 * Knobs (set any time): refuse (close new sockets at once), httpStatus (answer the upgrade with it, e.g. 503),
 * badAccept, protocolReply (null = no Sec-WebSocket-Protocol header), connackCode, refuseSubscribe, noPong,
 * silent (never answer CONNECT), splitAt (send every packet in pieces of at most n bytes) and fragment (those pieces
 * as continuation frames of one message instead of separate messages).
 */
final class FakeMqtt implements Closeable {
    static final int CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4, SUBSCRIBE = 8, SUBACK = 9;
    static final int PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    volatile boolean refuse;
    volatile int httpStatus = 101;
    volatile boolean badAccept;
    volatile String protocolReply = "mqtt";
    volatile int connackCode;
    volatile boolean refuseSubscribe;
    volatile boolean noPong;
    volatile boolean silent;
    volatile int splitAt;
    volatile boolean fragment;

    /** Every client PUBLISH: {topic, text, clientId}. */
    final List<String[]> published = Collections.synchronizedList(new ArrayList<>());
    /** Every CONNECT: protocol, level, flags, keepAlive, clientId, extra (bytes after the client id). */
    final List<Map<String, Object>> connects = Collections.synchronizedList(new ArrayList<>());
    /** Every SUBSCRIBE: {packetId, topic, qos, flags}. */
    final List<int[]> subscribeIds = Collections.synchronizedList(new ArrayList<>());
    final List<String> subscribeTopics = Collections.synchronizedList(new ArrayList<>());
    /** Every upgrade request's headers (lower-case names) plus "request-line". */
    final List<Map<String, String>> requests = Collections.synchronizedList(new ArrayList<>());
    /** Times (ms) a TCP connection was accepted. */
    final List<Long> accepts = Collections.synchronizedList(new ArrayList<>());
    final List<Integer> pubacks = Collections.synchronizedList(new ArrayList<>());
    final List<String> pongs = Collections.synchronizedList(new ArrayList<>());
    final AtomicInteger pingreqs = new AtomicInteger();
    final AtomicInteger disconnects = new AtomicInteger();
    final AtomicInteger closeFrames = new AtomicInteger();
    final AtomicInteger unmaskedFrames = new AtomicInteger();
    final AtomicInteger clientFrames = new AtomicInteger();

    private final ServerSocket server;
    private final boolean tls;
    private final String hostName;
    private final List<Client> clients = new ArrayList<>();
    private volatile boolean closed;

    final class Client {
        final Socket s;
        final OutputStream out;
        volatile String id = "";
        final List<String> topics = Collections.synchronizedList(new ArrayList<>());
        volatile boolean mqtt; // CONNACK sent

        Client(Socket s) throws IOException {
            this.s = s;
            this.out = s.getOutputStream();
        }

        synchronized void sendRawFrame(byte[] frame) throws IOException {
            out.write(frame);
            out.flush();
        }

        /** One MQTT packet, framed according to splitAt / fragment. */
        void sendPacket(byte[] p) throws IOException {
            int n = splitAt;
            if (n <= 0 || n >= p.length) {
                sendRawFrame(frame(true, 2, p, 0, p.length));
                return;
            }
            synchronized (this) {
                for (int off = 0; off < p.length; off += n) {
                    int len = Math.min(n, p.length - off);
                    boolean last = off + len >= p.length;
                    if (fragment) out.write(frame(last, off == 0 ? 2 : 0, p, off, len));
                    else out.write(frame(true, 2, p, off, len));
                }
                out.flush();
            }
        }

        void close() {
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
    }

    private FakeMqtt(TestTls t) throws IOException {
        tls = t != null;
        InetAddress lo = InetAddress.getByName("127.0.0.1");
        server = t != null ? t.server.getServerSocketFactory().createServerSocket(0, 50, lo) : new ServerSocket(0, 50, lo);
        hostName = t != null ? "localhost" : "127.0.0.1";
        Thread a = new Thread(this::acceptLoop, "fake-mqtt-accept");
        a.setDaemon(true);
        a.start();
    }

    static FakeMqtt start() throws IOException {
        return new FakeMqtt(null);
    }

    static FakeMqtt startTls(TestTls t) throws IOException {
        return new FakeMqtt(t);
    }

    int port() {
        return server.getLocalPort();
    }

    String url() {
        return (tls ? "wss://" : "ws://") + hostName + ":" + port() + "/mqtt";
    }

    /** Clients that finished CONNECT (live sockets). */
    int clientCount() {
        int n = 0;
        synchronized (clients) {
            for (Client c : clients) if (c.mqtt && !c.s.isClosed()) n++;
        }
        return n;
    }

    int subscribers(String topic) {
        int n = 0;
        synchronized (clients) {
            for (Client c : clients) if (!c.s.isClosed() && c.topics.contains(topic)) n++;
        }
        return n;
    }

    /** Published texts on a topic (in order). */
    List<String> texts(String topic) {
        List<String> out = new ArrayList<>();
        synchronized (published) {
            for (String[] p : published) if (p[0].equals(topic)) out.add(p[1]);
        }
        return out;
    }

    /** Server-side publish (QoS 0) to every subscriber of the topic, as if another client had published it. */
    int publish(String topic, String text) {
        return deliver(topic, publishBytes(topic, text, 0, 0));
    }

    /** Server-side publish with QoS 1 and a packet id (the client must PUBACK and drop it). */
    int publishQos1(String topic, String text, int packetId) {
        return deliver(topic, publishBytes(topic, text, 1, packetId));
    }

    /** Sends raw bytes as one binary WebSocket message to every MQTT client (e.g. two packets in one frame). */
    void sendRaw(byte[] payload) {
        for (Client c : snapshot()) {
            try {
                c.sendRawFrame(frame(true, 2, payload, 0, payload.length));
            } catch (IOException ignored) {
            }
        }
    }

    /** Sends an already built WebSocket frame (any opcode) to every MQTT client. */
    void sendFrame(byte[] frame) {
        for (Client c : snapshot()) {
            try {
                c.sendRawFrame(frame);
            } catch (IOException ignored) {
            }
        }
    }

    /** Cuts every client's socket (no close frame). */
    int drop() {
        List<Client> all;
        synchronized (clients) {
            all = new ArrayList<>(clients);
            clients.clear();
        }
        for (Client c : all) c.close();
        return all.size();
    }

    @Override
    public void close() {
        closed = true;
        try {
            server.close();
        } catch (IOException ignored) {
        }
        drop();
    }

    private List<Client> snapshot() {
        List<Client> out = new ArrayList<>();
        synchronized (clients) {
            for (Client c : clients) if (c.mqtt && !c.s.isClosed()) out.add(c);
        }
        return out;
    }

    private int deliver(String topic, byte[] packet) {
        int n = 0;
        List<Client> all;
        synchronized (clients) {
            all = new ArrayList<>(clients);
        }
        for (Client c : all) {
            if (c.s.isClosed() || !c.topics.contains(topic)) continue;
            try {
                c.sendPacket(packet);
                n++;
            } catch (IOException ignored) {
            }
        }
        return n;
    }

    // ---------------------------------------------------------------- server side

    private void acceptLoop() {
        while (!closed) {
            Socket s;
            try {
                s = server.accept();
            } catch (IOException e) {
                return;
            }
            accepts.add(System.currentTimeMillis());
            if (refuse) {
                try {
                    s.close();
                } catch (IOException ignored) {
                }
                continue;
            }
            Thread t = new Thread(() -> serve(s), "fake-mqtt-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    private void serve(Socket s) {
        Client c = null;
        try {
            s.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(s.getInputStream());
            Map<String, String> h = readRequest(in);
            requests.add(h);
            c = new Client(s);
            if (httpStatus != 101) {
                c.sendRawFrame(("HTTP/1.1 " + httpStatus + " Nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .getBytes(StandardCharsets.US_ASCII));
                return;
            }
            String key = h.get("sec-websocket-key");
            if (key == null || !"websocket".equalsIgnoreCase(h.get("upgrade")) || !"13".equals(h.get("sec-websocket-version"))) {
                c.sendRawFrame("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                return;
            }
            String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                    .digest((key + GUID).getBytes(StandardCharsets.US_ASCII)));
            if (badAccept) accept = Base64.getEncoder().encodeToString(new byte[20]);
            StringBuilder r = new StringBuilder("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n");
            r.append("Sec-WebSocket-Accept: ").append(accept).append("\r\n");
            if (protocolReply != null) r.append("Sec-WebSocket-Protocol: ").append(protocolReply).append("\r\n");
            c.sendRawFrame(r.append("\r\n").toString().getBytes(StandardCharsets.US_ASCII));
            synchronized (clients) {
                clients.add(c);
            }
            readFrames(c, in);
        } catch (Exception ignored) {
            // Client went away, or a test cut it.
        } finally {
            if (c != null) {
                synchronized (clients) {
                    clients.remove(c);
                }
            }
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
    }

    private static Map<String, String> readRequest(InputStream in) throws IOException {
        Map<String, String> h = new HashMap<>();
        String first = line(in);
        h.put("request-line", first);
        while (true) {
            String l = line(in);
            if (l.isEmpty()) return h;
            int c = l.indexOf(':');
            if (c > 0) h.put(l.substring(0, c).trim().toLowerCase(Locale.ROOT), l.substring(c + 1).trim());
        }
    }

    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        while (true) {
            int c = in.read();
            if (c < 0) throw new EOFException();
            if (c == '\n') return b.toString("UTF-8").replace("\r", "");
            b.write(c);
        }
    }

    private void readFrames(Client c, InputStream in) throws Exception {
        ByteArrayOutputStream stream = new ByteArrayOutputStream();
        while (true) {
            int b0 = in.read();
            if (b0 < 0) return;
            int b1 = readByte(in);
            clientFrames.incrementAndGet();
            int op = b0 & 15;
            boolean masked = (b1 & 0x80) != 0;
            if (!masked) unmaskedFrames.incrementAndGet();
            long len = b1 & 127;
            if (len == 126) len = (readByte(in) << 8) | readByte(in);
            else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in);
            }
            byte[] mask = new byte[4];
            if (masked) readFully(in, mask);
            byte[] p = new byte[(int) len];
            readFully(in, p);
            if (masked) for (int i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
            if (op == 8) {
                closeFrames.incrementAndGet();
                c.sendRawFrame(frame(true, 8, p, 0, Math.min(p.length, 2)));
                return;
            }
            if (op == 9) {
                c.sendRawFrame(frame(true, 10, p, 0, p.length));
                continue;
            }
            if (op == 10) {
                pongs.add(new String(p, StandardCharsets.UTF_8));
                continue;
            }
            if (op != 0 && op != 2) continue;
            stream.write(p);
            byte[] buf = stream.toByteArray();
            int off = 0;
            while (true) {
                int[] rl = remainingLength(buf, off + 1);
                if (buf.length - off < 2 || rl == null) break;
                int start = off + 1 + rl[1];
                if (buf.length < start + rl[0]) break;
                byte[] body = new byte[rl[0]];
                System.arraycopy(buf, start, body, 0, rl[0]);
                if (!packet(c, (buf[off] & 0xff) >> 4, buf[off] & 15, body)) return;
                off = start + rl[0];
            }
            stream.reset();
            stream.write(buf, off, buf.length - off);
        }
    }

    /** {value, bytes} or null if incomplete. */
    private static int[] remainingLength(byte[] b, int off) {
        int v = 0;
        int mul = 1;
        for (int i = 0; i < 4; i++) {
            if (off + i >= b.length) return null;
            int x = b[off + i] & 0xff;
            v += (x & 127) * mul;
            if ((x & 128) == 0) return new int[] {v, i + 1};
            mul *= 128;
        }
        throw new IllegalStateException("malformed remaining length from client");
    }

    /** Handles one client packet; false = close the connection. */
    private boolean packet(Client c, int type, int flags, byte[] b) throws IOException {
        switch (type) {
            case CONNECT: {
                int o = 0;
                int pl = u16(b, o);
                String protocol = new String(b, 2, pl, StandardCharsets.UTF_8);
                o = 2 + pl;
                int level = b[o++] & 0xff;
                int cflags = b[o++] & 0xff;
                int keepAlive = u16(b, o);
                o += 2;
                int il = u16(b, o);
                String id = new String(b, o + 2, il, StandardCharsets.UTF_8);
                Map<String, Object> m = new HashMap<>();
                m.put("protocol", protocol);
                m.put("level", level);
                m.put("flags", cflags);
                m.put("keepAlive", keepAlive);
                m.put("clientId", id);
                m.put("extra", b.length - (o + 2 + il));
                connects.add(m);
                c.id = id;
                if (silent) return true;
                c.sendPacket(new byte[] {(byte) (CONNACK << 4), 2, 0, (byte) connackCode});
                if (connackCode != 0) return false;
                c.mqtt = true;
                return true;
            }
            case SUBSCRIBE: {
                int id = u16(b, 0);
                int o = 2;
                ByteArrayOutputStream codes = new ByteArrayOutputStream();
                while (o < b.length) {
                    int tl = u16(b, o);
                    String topic = new String(b, o + 2, tl, StandardCharsets.UTF_8);
                    int qos = b[o + 2 + tl] & 0xff;
                    o += 3 + tl;
                    subscribeIds.add(new int[] {id, qos, flags});
                    subscribeTopics.add(topic);
                    if (!refuseSubscribe) c.topics.add(topic);
                    codes.write(refuseSubscribe ? 0x80 : 0);
                }
                byte[] cs = codes.toByteArray();
                byte[] ack = new byte[4 + cs.length];
                ack[0] = (byte) (SUBACK << 4);
                ack[1] = (byte) (2 + cs.length);
                ack[2] = (byte) (id >> 8);
                ack[3] = (byte) id;
                System.arraycopy(cs, 0, ack, 4, cs.length);
                c.sendPacket(ack);
                return true;
            }
            case PUBLISH: {
                int qos = (flags >> 1) & 3;
                int tl = u16(b, 0);
                String topic = new String(b, 2, tl, StandardCharsets.UTF_8);
                int o = 2 + tl + (qos > 0 ? 2 : 0);
                String text = new String(b, o, b.length - o, StandardCharsets.UTF_8);
                published.add(new String[] {topic, text, c.id});
                deliver(topic, publishBytes(topic, text, 0, 0));
                return true;
            }
            case PUBACK:
                pubacks.add(u16(b, 0));
                return true;
            case PINGREQ:
                pingreqs.incrementAndGet();
                if (!noPong) c.sendPacket(new byte[] {(byte) (PINGRESP << 4), 0});
                return true;
            case DISCONNECT:
                disconnects.incrementAndGet();
                return false;
            default:
                return true;
        }
    }

    private static int u16(byte[] b, int o) {
        return ((b[o] & 0xff) << 8) | (b[o + 1] & 0xff);
    }

    private static int readByte(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) throw new EOFException();
        return b;
    }

    private static void readFully(InputStream in, byte[] b) throws IOException {
        int o = 0;
        while (o < b.length) {
            int n = in.read(b, o, b.length - o);
            if (n < 0) throw new EOFException();
            o += n;
        }
    }

    // ---------------------------------------------------------------- bytes

    static byte[] remainingLengthBytes(int n) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        do {
            int b = n % 128;
            n /= 128;
            if (n > 0) b |= 128;
            o.write(b);
        } while (n > 0);
        return o.toByteArray();
    }

    /** A PUBLISH packet (QoS 0, or QoS 1/2 with a packet id). */
    static byte[] publishBytes(String topic, String text, int qos, int id) {
        byte[] t = topic.getBytes(StandardCharsets.UTF_8);
        byte[] m = text.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write(t.length >> 8);
        body.write(t.length & 255);
        body.write(t, 0, t.length);
        if (qos > 0) {
            body.write(id >> 8);
            body.write(id & 255);
        }
        body.write(m, 0, m.length);
        return packetBytes(0x30 | (qos << 1), body.toByteArray());
    }

    static byte[] packetBytes(int first, byte[] body) {
        byte[] len = remainingLengthBytes(body.length);
        byte[] out = new byte[1 + len.length + body.length];
        out[0] = (byte) first;
        System.arraycopy(len, 0, out, 1, len.length);
        System.arraycopy(body, 0, out, 1 + len.length, body.length);
        return out;
    }

    /** An unmasked server frame. */
    static byte[] frame(boolean fin, int opcode, byte[] p, int off, int len) {
        ByteArrayOutputStream o = new ByteArrayOutputStream(len + 10);
        o.write((fin ? 0x80 : 0) | opcode);
        if (len < 126) {
            o.write(len);
        } else if (len < 65536) {
            o.write(126);
            o.write(len >> 8);
            o.write(len & 255);
        } else {
            o.write(127);
            for (int i = 7; i >= 0; i--) o.write(i >= 4 ? 0 : (len >>> (8 * i)) & 255);
        }
        o.write(p, off, len);
        return o.toByteArray();
    }

    /** "host:port" this broker listens on. */
    InetSocketAddress address() {
        return new InetSocketAddress(server.getInetAddress(), port());
    }
}
