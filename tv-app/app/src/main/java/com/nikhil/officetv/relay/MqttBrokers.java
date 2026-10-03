package com.nikhil.officetv.relay;

import java.io.EOFException;
import java.io.IOException;
import java.net.ConnectException;
import java.net.ProtocolException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocketFactory;

/**
 * Keeps one MQTT connection to each of several brokers, all at the same time (PROTOCOL.md section 6): a thread per
 * broker connects, subscribes to the topic and reads; a broken connection is retried after 1, 2, 4, 8, 15, 30 s
 * (reset after a CONNACK). {@link #publish} sends to every connected broker. One timer thread runs the keep-alive
 * pings of all of them. Used by {@link RelayClient} for 4-digit codes only.
 * <p>
 * One use: {@link #start} once, {@link #stop} once (returns at once; sockets are closed on a helper thread).
 * {@link #publish} blocks on the network: call it from a worker thread. Pure Java, safe on Android API 21.
 */
final class MqttBrokers {
    /** Public brokers with MQTT over secure WebSocket, in this order (PROTOCOL.md section 6). */
    static final String[] DEFAULT_URLS = {
            "wss://broker.emqx.io:8084/mqtt",
            "wss://broker.hivemq.com:8884/mqtt",
            "wss://mqtt.eclipseprojects.io:443/mqtt",
    };
    /** MQTT topic = this prefix + the relay topic. */
    static final String TOPIC_PREFIX = "officetv/";
    private static final long[] BACKOFF_S = {1, 2, 4, 8, 15, 30};

    interface Listener {
        /** An envelope (or anything else) published on the topic, from one broker's reading thread. */
        void onMessage(String text, String brokerUrl);

        /** The number of connected brokers changed. */
        void onChange(int connected, int total);
    }

    // Timings; package-private so JVM tests can shorten them (set before start()).
    volatile long backoffUnitMs = 1000;
    volatile long pingMs = 25000;
    volatile long pongTimeoutMs = 10000;
    volatile int connectTimeoutMs = 10000;
    volatile int handshakeTimeoutMs = 10000;
    volatile int readTimeoutMs = 60000;

    /** Connection attempts and CONNACKs over all brokers. For tests. */
    final AtomicInteger attempts = new AtomicInteger();
    final AtomicInteger connacks = new AtomicInteger();

    private final String topic;
    private final SSLSocketFactory ssl;
    private final Listener listener;
    private final Slot[] slots;
    private final Object lock = new Object();
    private volatile boolean running;
    private boolean started;
    private ScheduledThreadPoolExecutor timer;

    private static final class Slot {
        final String url;
        volatile MqttConnection conn;
        volatile String lastError;
        Thread thread;

        Slot(String url) {
            this.url = url;
        }
    }

    /**
     * @param urls  broker WebSocket URLs (wss://, or ws:// in tests)
     * @param topic the full MQTT topic (TOPIC_PREFIX + relay topic)
     * @param ssl   socket factory for wss:// (null = the platform default)
     */
    MqttBrokers(String[] urls, String topic, SSLSocketFactory ssl, Listener listener) {
        if (listener == null) throw new IllegalArgumentException("listener");
        this.topic = topic;
        this.ssl = ssl;
        this.listener = listener;
        slots = new Slot[urls == null ? 0 : urls.length];
        for (int i = 0; i < slots.length; i++) slots[i] = new Slot(urls[i]);
    }

    int size() {
        return slots.length;
    }

    String topic() {
        return topic;
    }

    int connectedCount() {
        int n = 0;
        for (Slot s : slots) {
            MqttConnection c = s.conn;
            if (c != null && c.isUp()) n++;
        }
        return n;
    }

    /** The last connection problem of broker i ("" if none yet). For diagnostics. */
    String lastError(int i) {
        String e = slots[i].lastError;
        return e == null ? "" : e;
    }

    void start() {
        synchronized (lock) {
            if (started) return;
            started = true;
            running = true;
            timer = new ScheduledThreadPoolExecutor(1, r -> {
                Thread t = new Thread(r, "otv-mqtt-timer");
                t.setDaemon(true);
                return t;
            });
            for (int i = 0; i < slots.length; i++) {
                final Slot s = slots[i];
                s.thread = new Thread(() -> loop(s), "otv-mqtt-" + i);
                s.thread.setDaemon(true);
                s.thread.start();
            }
        }
    }

    /** Stops every connection. Returns at once; DISCONNECT and closing happen on a helper thread. */
    void stop() {
        final MqttConnection[] open = new MqttConnection[slots.length];
        ScheduledThreadPoolExecutor t;
        synchronized (lock) {
            if (!running) return;
            running = false;
            t = timer;
            timer = null;
            for (int i = 0; i < slots.length; i++) open[i] = slots[i].conn;
            lock.notifyAll();
        }
        if (t != null) t.shutdownNow();
        Thread closer = new Thread(() -> {
            for (MqttConnection c : open) if (c != null) c.disconnect();
        }, "otv-mqtt-close");
        closer.setDaemon(true);
        closer.start();
    }

    /** For tests: the reading thread of broker i (kept after stop). */
    Thread thread(int i) {
        synchronized (lock) {
            return slots[i].thread;
        }
    }

    /** QoS 0 publish to every connected broker. Returns how many it went to (0 = none connected). */
    int publish(String text) {
        int n = 0;
        for (Slot s : slots) {
            MqttConnection c = s.conn;
            if (c != null && c.publish(text)) n++;
        }
        return n;
    }

    // ---------------------------------------------------------------- per broker

    private void loop(final Slot s) {
        int retry = 0;
        while (running) {
            MqttConnection c;
            try {
                c = new MqttConnection(s.url, topic, ssl, timer());
            } catch (IOException e) {
                s.lastError = e.getMessage();
                return; // A bad URL stays bad.
            }
            c.connectTimeoutMs = connectTimeoutMs;
            c.handshakeTimeoutMs = handshakeTimeoutMs;
            c.readTimeoutMs = readTimeoutMs;
            c.pingMs = pingMs;
            c.pongTimeoutMs = pongTimeoutMs;
            synchronized (lock) {
                if (!running) break;
                s.conn = c;
            }
            attempts.incrementAndGet();
            try {
                c.run(new MqttConnection.Listener() {
                    @Override
                    public void onUp(MqttConnection conn) {
                        // lastError keeps the previous problem for diagnostics; it is replaced by the next one.
                        changed();
                    }

                    @Override
                    public void onMessage(String text) {
                        if (!running) return;
                        try {
                            listener.onMessage(text, s.url);
                        } catch (Throwable ignored) {
                            // A listener bug must not break the connection.
                        }
                    }
                });
                if (s.lastError == null && c.error() != null) s.lastError = c.error();
            } catch (Throwable t) {
                s.lastError = c.error() != null ? c.error() : describe(t);
            } finally {
                c.close();
            }
            boolean wasUp = c.gotConnack();
            if (wasUp) connacks.incrementAndGet();
            synchronized (lock) {
                if (s.conn == c) s.conn = null;
            }
            if (wasUp) changed();
            if (!running) break;
            if (wasUp) retry = 0;
            sleep(BACKOFF_S[Math.min(retry++, BACKOFF_S.length - 1)] * backoffUnitMs);
        }
    }

    private ScheduledThreadPoolExecutor timer() {
        synchronized (lock) {
            return timer;
        }
    }

    /** Synchronized so that counts are delivered in order: the last call always reports the current count. */
    private synchronized void changed() {
        if (!running) return;
        try {
            listener.onChange(connectedCount(), slots.length);
        } catch (Throwable ignored) {
            // UI callbacks must never break the connections.
        }
    }

    private void sleep(long ms) {
        long end = System.currentTimeMillis() + ms;
        synchronized (lock) {
            while (running) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) return;
                try {
                    lock.wait(left);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }
    }

    static String describe(Throwable t) {
        if (t instanceof UnknownHostException) return "Broker not found (no internet?).";
        if (t instanceof SocketTimeoutException) return "The broker did not respond (timeout).";
        if (t instanceof ConnectException) return "Could not connect to the broker.";
        if (t instanceof SSLException) return "Secure connection failed (" + t.getClass().getSimpleName() + ").";
        if (t instanceof ProtocolException && t.getMessage() != null) return t.getMessage();
        if (t instanceof EOFException) return "The broker closed the connection.";
        return "Lost connection to the broker (" + t.getClass().getSimpleName() + ").";
    }
}
