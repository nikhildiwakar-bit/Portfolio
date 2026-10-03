package com.nikhil.officetv.relay;

import java.io.EOFException;
import java.io.IOException;
import java.net.ProtocolException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLSocketFactory;

/**
 * One MQTT 3.1.1 session over a WebSocket (PROTOCOL.md section 6): CONNECT (clean session, keep-alive 30 s, client
 * id "otv" + 16 random [a-z0-9]) and CONNACK, SUBSCRIBE to one topic at QoS 0 and SUBACK, then QoS 0 PUBLISH both
 * ways, PINGREQ every {@code pingMs} (no PINGRESP within {@code pongTimeoutMs} = broken) and DISCONNECT. Incoming
 * QoS 1 or 2 publishes are acknowledged and dropped (we subscribe at QoS 0, so a broker should never send them).
 * Packets bigger than {@link #MAX_PACKET} or malformed ones break the connection.
 * <p>
 * One use only: {@link #run} connects and then reads on the calling thread until the connection breaks;
 * {@link #publish} and {@link #close} may be called from any thread. The timer runs the pings and the handshake
 * watchdog. Pure Java, safe on Android API 21.
 */
final class MqttConnection {
    static final int CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4, PUBREC = 5, PUBREL = 6, PUBCOMP = 7;
    static final int SUBSCRIBE = 8, SUBACK = 9, PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;
    /** Largest remaining length accepted from a broker (an envelope is under 4 KB). */
    static final int MAX_PACKET = 64 * 1024;
    static final int KEEPALIVE_S = 30;
    private static final String ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
    private static final SecureRandom RNG = new SecureRandom();

    interface Listener {
        /** Subscribed: publishes go out from now on. Called on the reading thread. */
        void onUp(MqttConnection c);

        /** A QoS 0 message on our topic (UTF-8 payload). Called on the reading thread. */
        void onMessage(String text);
    }

    // Timings; set by MqttBrokers (tests shorten them).
    int connectTimeoutMs = 10000;
    int handshakeTimeoutMs = 10000;
    int readTimeoutMs = 60000;
    long pingMs = 25000;
    long pongTimeoutMs = 10000;

    private final WebSocketClient ws;
    private final String topic;
    private final String clientId;
    private final ScheduledExecutorService timer;
    private final Object lock = new Object();
    private volatile boolean up;
    private volatile boolean connacked;
    private volatile boolean closed;
    private volatile String error;
    private long pingSentAt; // guarded by lock; 0 = no PINGREQ outstanding
    private ScheduledFuture<?> pinger;

    MqttConnection(String url, String topic, SSLSocketFactory ssl, ScheduledExecutorService timer) throws IOException {
        this.ws = new WebSocketClient(url, "mqtt", ssl);
        this.topic = topic;
        this.clientId = newClientId();
        this.timer = timer;
    }

    String url() {
        return ws.url();
    }

    String clientId() {
        return clientId;
    }

    /** Subscribed and not broken. */
    boolean isUp() {
        return up && !closed;
    }

    /** The broker accepted CONNECT at some point (resets the back-off). */
    boolean gotConnack() {
        return connacked;
    }

    /** Why the connection ended when the reason was ours (no PINGRESP), else null. */
    String error() {
        return error;
    }

    // ---------------------------------------------------------------- lifecycle

    /**
     * Connects, subscribes and reads until the connection breaks or {@link #close} is called. Returns normally
     * when the broker or we closed it, throws on errors. The socket is always closed on return.
     */
    void run(Listener l) throws IOException {
        ScheduledFuture<?> watchdog = null;
        try {
            ws.connect(connectTimeoutMs);
            // TLS, upgrade, CONNACK and SUBACK together must not take longer than the handshake timeout.
            watchdog = schedule(new Runnable() {
                @Override
                public void run() {
                    if (!up) fail("The broker did not answer in time.");
                }
            }, handshakeTimeoutMs);
            ws.handshake(handshakeTimeoutMs);
            ws.sendBinary(connectPacket(clientId, KEEPALIVE_S));
            PacketReader reader = new PacketReader(MAX_PACKET);
            while (true) {
                byte[] data = ws.read();
                if (data == null) {
                    if (!up && !closed) throw new EOFException("The broker closed the connection.");
                    return;
                }
                for (Packet p : reader.push(data)) {
                    if (closed) return;
                    handle(p, l);
                }
            }
        } finally {
            if (watchdog != null) watchdog.cancel(false);
            close();
        }
    }

    private void handle(Packet p, Listener l) throws IOException {
        switch (p.type) {
            case CONNACK:
                if (connacked) return;
                if (p.body.length < 2) throw new ProtocolException("Bad CONNACK");
                if (p.body[1] != 0) throw new ProtocolException("The broker refused the connection (code " + p.body[1] + ").");
                connacked = true;
                ws.sendBinary(subscribePacket(1, topic));
                return;
            case SUBACK:
                if (up || !connacked) return;
                if (p.body.length < 3 || (p.body[2] & 0xff) == 0x80) throw new ProtocolException("The broker refused the subscription.");
                ws.setReadTimeout(readTimeoutMs);
                up = true;
                startPings();
                l.onUp(this);
                return;
            case PUBLISH: {
                int qos = (p.flags >> 1) & 3;
                if (qos == 3 || p.body.length < 2) throw new ProtocolException("Bad PUBLISH");
                int tlen = ((p.body[0] & 0xff) << 8) | (p.body[1] & 0xff);
                int off = 2 + tlen;
                if (p.body.length < off + (qos > 0 ? 2 : 0)) throw new ProtocolException("Bad PUBLISH");
                if (qos > 0) {
                    int id = ((p.body[off] & 0xff) << 8) | (p.body[off + 1] & 0xff);
                    ws.sendBinary(ack(qos == 1 ? PUBACK : PUBREC, id));
                    return;
                }
                if (!up) return;
                String t = new String(p.body, 2, tlen, Pairing.UTF8);
                if (!t.equals(topic)) return;
                l.onMessage(new String(p.body, off, p.body.length - off, Pairing.UTF8));
                return;
            }
            case PUBREL:
                if (p.body.length >= 2) ws.sendBinary(ack(PUBCOMP, ((p.body[0] & 0xff) << 8) | (p.body[1] & 0xff)));
                return;
            case PINGRESP:
                synchronized (lock) {
                    pingSentAt = 0;
                }
                return;
            default:
                // PUBACK, PUBREC, PUBCOMP, UNSUBACK and packets a broker should not send: nothing to do.
        }
    }

    /** QoS 0 publish to our topic. False when not connected or the write failed (the connection is then closed). */
    boolean publish(String text) {
        if (!isUp()) return false;
        try {
            ws.sendBinary(publishPacket(topic, text));
            return true;
        } catch (IOException | RuntimeException e) {
            fail("Could not send to the broker.");
            return false;
        }
    }

    /** Ends the session at once (the reading thread returns). Safe from any thread, repeatedly. */
    void close() {
        ScheduledFuture<?> p;
        synchronized (lock) {
            closed = true;
            p = pinger;
            pinger = null;
        }
        if (p != null) p.cancel(false);
        up = false;
        ws.close();
    }

    /** Polite end: DISCONNECT and a WebSocket close frame (best effort), then {@link #close}. Blocks on the network. */
    void disconnect() {
        if (isUp()) {
            try {
                ws.sendBinary(new byte[] {(byte) (DISCONNECT << 4), 0});
                ws.sendClose(new byte[] {0x03, (byte) 0xe8}); // 1000 = normal closure
            } catch (IOException | RuntimeException ignored) {
            }
        }
        close();
    }

    private void fail(String why) {
        if (closed) return;
        error = why;
        close();
    }

    // ---------------------------------------------------------------- keep-alive

    private void startPings() {
        ScheduledFuture<?> f = null;
        try {
            if (timer != null) {
                f = timer.scheduleAtFixedRate(new Runnable() {
                    @Override
                    public void run() {
                        ping();
                    }
                }, pingMs, pingMs, TimeUnit.MILLISECONDS);
            }
        } catch (RejectedExecutionException e) {
            return; // Stopped meanwhile.
        }
        synchronized (lock) {
            if (!closed) {
                pinger = f;
                return;
            }
        }
        if (f != null) f.cancel(false);
    }

    private void ping() {
        final long sent = System.currentTimeMillis();
        synchronized (lock) {
            if (closed || !up || pingSentAt != 0) return;
            pingSentAt = sent;
        }
        try {
            ws.sendBinary(new byte[] {(byte) (PINGREQ << 4), 0});
        } catch (IOException | RuntimeException e) {
            fail("Could not send to the broker.");
            return;
        }
        schedule(new Runnable() {
            @Override
            public void run() {
                boolean late;
                synchronized (lock) {
                    late = pingSentAt == sent;
                }
                if (late) fail("The broker stopped answering (no PINGRESP).");
            }
        }, pongTimeoutMs);
    }

    private ScheduledFuture<?> schedule(Runnable r, long ms) {
        if (timer == null) return null;
        try {
            return timer.schedule(r, ms, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- packets

    static String newClientId() {
        char[] c = new char[19];
        c[0] = 'o';
        c[1] = 't';
        c[2] = 'v';
        for (int i = 3; i < c.length; i++) c[i] = ID_CHARS.charAt(RNG.nextInt(ID_CHARS.length()));
        return new String(c);
    }

    /** MQTT "remaining length": 1-4 bytes, 7 bits each, least significant first. */
    static byte[] encodeLength(int n) {
        if (n < 0 || n > 268435455) throw new IllegalArgumentException("bad remaining length");
        byte[] tmp = new byte[4];
        int k = 0;
        do {
            int b = n % 128;
            n /= 128;
            if (n > 0) b |= 128;
            tmp[k++] = (byte) b;
        } while (n > 0);
        byte[] out = new byte[k];
        System.arraycopy(tmp, 0, out, 0, k);
        return out;
    }

    private static byte[] packet(int type, int flags, byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] len = encodeLength(n);
        byte[] out = new byte[1 + len.length + n];
        out[0] = (byte) ((type << 4) | flags);
        System.arraycopy(len, 0, out, 1, len.length);
        int o = 1 + len.length;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, out, o, p.length);
            o += p.length;
        }
        return out;
    }

    /** A UTF-8 string with its 2-byte length. */
    private static byte[] lp(String s) {
        byte[] b = s.getBytes(Pairing.UTF8);
        if (b.length > 65535) throw new IllegalArgumentException("string too long");
        byte[] out = new byte[2 + b.length];
        out[0] = (byte) (b.length >> 8);
        out[1] = (byte) b.length;
        System.arraycopy(b, 0, out, 2, b.length);
        return out;
    }

    /** CONNECT: protocol "MQTT" level 4, flags clean session only (0x02), no will, username or password. */
    static byte[] connectPacket(String clientId, int keepAliveS) {
        byte[] head = {4, 0x02, (byte) (keepAliveS >> 8), (byte) keepAliveS};
        return packet(CONNECT, 0, lp("MQTT"), head, lp(clientId));
    }

    /** SUBSCRIBE (fixed header flags 0b0010) to one topic at QoS 0. */
    static byte[] subscribePacket(int id, String topic) {
        return packet(SUBSCRIBE, 2, new byte[] {(byte) (id >> 8), (byte) id}, lp(topic), new byte[] {0});
    }

    /** PUBLISH at QoS 0, retain 0 (no packet id). */
    static byte[] publishPacket(String topic, String text) {
        return packet(PUBLISH, 0, lp(topic), text.getBytes(Pairing.UTF8));
    }

    private static byte[] ack(int type, int id) {
        return new byte[] {(byte) (type << 4), 2, (byte) (id >> 8), (byte) id};
    }

    static final class Packet {
        final int type;
        final int flags;
        final byte[] body;

        Packet(int type, int flags, byte[] body) {
            this.type = type;
            this.flags = flags;
            this.body = body;
        }
    }

    /**
     * Splits a connection's byte stream into MQTT packets. WebSocket frames need not line up with packets: one
     * frame may hold several, and one packet may span frames.
     */
    static final class PacketReader {
        private final int max;
        private byte[] buf = new byte[1024];
        private int len;

        PacketReader(int max) {
            this.max = max;
        }

        /** Adds bytes and returns the packets completed so far. Throws on a malformed length or a too big packet. */
        List<Packet> push(byte[] data) throws ProtocolException {
            if (len + data.length > buf.length) {
                int cap = buf.length;
                while (cap < len + data.length) cap *= 2;
                byte[] b = new byte[cap];
                System.arraycopy(buf, 0, b, 0, len);
                buf = b;
            }
            System.arraycopy(data, 0, buf, len, data.length);
            len += data.length;
            List<Packet> out = new ArrayList<>();
            int off = 0;
            while (len - off >= 2) {
                int value = 0;
                int mul = 1;
                int n = 0;
                boolean done = false;
                while (n < 4 && off + 1 + n < len) {
                    int b = buf[off + 1 + n] & 0xff;
                    value += (b & 127) * mul;
                    mul *= 128;
                    n++;
                    if ((b & 128) == 0) {
                        done = true;
                        break;
                    }
                }
                if (!done) {
                    if (n >= 4) throw new ProtocolException("Malformed MQTT remaining length");
                    break; // Need more bytes.
                }
                if (value > max) throw new ProtocolException("MQTT packet too large (" + value + " bytes)");
                int start = off + 1 + n;
                if (len - start < value) break;
                byte[] body = new byte[value];
                System.arraycopy(buf, start, body, 0, value);
                out.add(new Packet((buf[off] & 0xff) >> 4, buf[off] & 15, body));
                off = start + value;
            }
            if (off > 0) {
                System.arraycopy(buf, off, buf, 0, len - off);
                len -= off;
            }
            if (buf.length > 4 * 1024 && len < 1024) buf = copyOf(buf, len, 1024);
            return out;
        }

        /** Bytes waiting for the rest of their packet (tests). */
        int pending() {
            return len;
        }

        private static byte[] copyOf(byte[] b, int n, int cap) {
            byte[] out = new byte[cap];
            System.arraycopy(b, 0, out, 0, n);
            return out;
        }
    }
}
