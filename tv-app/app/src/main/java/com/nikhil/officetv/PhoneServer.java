package com.nikhil.officetv;

import android.content.Context;
import android.content.Intent;
import android.os.Looper;
import android.os.SystemClock;

import com.nikhil.officetv.mirror.MirrorProtocol;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.ArrayDeque;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * TV side of phone mirroring (PROTOCOL.md section 10): a TCP server on port 47300 (47301-47309 if taken) that
 * accepts one authenticated phone at a time and hands its H.264 stream to PhoneMirrorActivity.
 * Runs inside ControlService on background threads and never throws into the caller.
 */
final class PhoneServer {
    private static final int HANDSHAKE_TIMEOUT_MS = 4000;
    private static final int READ_TIMEOUT_MS = 12000;
    private static final int PING_MS = 2000;
    /** The mirror screen must open within this time, or the phone is told why it cannot be shown. */
    private static final long OPEN_TIMEOUT_MS = 10000;
    private static final int MAX_HANDSHAKES = 4;

    private static final Object LOCK = new Object();
    private static ServerSocket server;
    private static volatile int port;
    private static volatile Context app;
    private static Session active;
    private static final AtomicInteger handshakes = new AtomicInteger();

    private PhoneServer() {}

    /** Listening port, or 0 if the server is not running. */
    static int port() {
        ServerSocket s = server;
        return s != null && !s.isClosed() ? port : 0;
    }

    static void start(Context c) {
        synchronized (LOCK) {
            app = c.getApplicationContext() != null ? c.getApplicationContext() : c;
            if (server != null && !server.isClosed()) return;
            IOException last = null;
            for (int p = MirrorProtocol.DEFAULT_PORT; p <= MirrorProtocol.LAST_PORT; p++) {
                ServerSocket s = null;
                try {
                    s = new ServerSocket();
                    s.setReuseAddress(true);
                    s.bind(new InetSocketAddress(p), 4);
                    server = s;
                    port = p;
                    break;
                } catch (IOException e) {
                    last = e;
                    closeQuietly(s);
                }
            }
            if (server == null) {
                CrashLog.note(app, "Phone mirroring server did not start: " + last);
                return;
            }
            final ServerSocket s = server;
            Thread t = new Thread(() -> acceptLoop(s), "otv-phone-accept");
            t.setDaemon(true);
            t.start();
            DebugHooks.event("phone=listening port=" + port);
            MainActivity.refreshNow();
        }
    }

    static void stop() {
        Session s;
        synchronized (LOCK) {
            closeQuietly(server);
            server = null;
            s = active;
        }
        if (s != null) s.end("The TV stopped mirroring.", false);
        MainActivity.refreshNow();
    }

    /** Ends the current phone session (e.g. the phone secret was replaced). */
    static void disconnectAll(String reason) {
        Session s;
        synchronized (LOCK) {
            s = active;
        }
        if (s != null) s.end(reason);
    }

    static Session current() {
        synchronized (LOCK) {
            return active;
        }
    }

    private static void acceptLoop(ServerSocket s) {
        while (!s.isClosed()) {
            final Socket c;
            try {
                c = s.accept();
            } catch (IOException e) {
                if (s.isClosed()) return;
                SystemClock.sleep(200);
                continue;
            } catch (Throwable t) {
                CrashLog.note(app, "Phone accept: " + t);
                SystemClock.sleep(500);
                continue;
            }
            if (handshakes.incrementAndGet() > MAX_HANDSHAKES) {
                handshakes.decrementAndGet();
                closeQuietly(c);
                continue;
            }
            Thread t = new Thread(() -> {
                try {
                    handle(c);
                } catch (Throwable e) {
                    closeQuietly(c);
                    CrashLog.note(app, "Phone connection: " + e);
                }
            }, "otv-phone-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    private static void handle(Socket c) throws IOException {
        Session session;
        try {
            c.setSoTimeout(HANDSHAKE_TIMEOUT_MS);
            c.setTcpNoDelay(true);
            InputStream in = c.getInputStream();
            OutputStream out = c.getOutputStream();
            byte[] hello = new byte[MirrorProtocol.HELLO_LEN];
            MirrorProtocol.readFully(in, hello, 0, MirrorProtocol.MAGIC.length);
            if (!MirrorProtocol.hasMagic(hello)) {
                closeQuietly(c);
                return;
            }
            MirrorProtocol.readFully(in, hello, MirrorProtocol.MAGIC.length,
                    MirrorProtocol.HELLO_LEN - MirrorProtocol.MAGIC.length);
            byte[] secret = Prefs.phoneSecret(app);
            if (!MirrorProtocol.verifyHello(secret, hello)) {
                DebugHooks.event("phone=rejected reason=auth");
                out.write(MirrorProtocol.rejectReply(MirrorProtocol.REJECT_AUTH));
                out.flush();
                closeQuietly(c);
                return;
            }
            synchronized (LOCK) {
                if (active != null && !active.ended) {
                    session = null;
                } else {
                    session = new Session(c);
                    active = session;
                }
            }
            if (session == null) {
                DebugHooks.event("phone=rejected reason=busy");
                out.write(MirrorProtocol.rejectReply(MirrorProtocol.REJECT_BUSY));
                out.flush();
                closeQuietly(c);
                return;
            }
            out.write(MirrorProtocol.okReply(secret, MirrorProtocol.nonceOf(hello)));
            out.flush();
            c.setSoTimeout(READ_TIMEOUT_MS);
        } catch (IOException e) {
            closeQuietly(c);
            return;
        } finally {
            handshakes.decrementAndGet();
        }
        DebugHooks.event("phone=connected from=" + c.getInetAddress().getHostAddress());
        session.run();
    }

    private static void openScreen(Session s) {
        Context c = app;
        Actions.wake(c);
        try {
            c.startActivity(new Intent(c, PhoneMirrorActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
        } catch (RuntimeException e) {
            CrashLog.note(c, "Phone mirror screen did not start: " + e);
            s.end("The TV could not open the mirroring screen. Please restart Office TV on the TV.");
        }
    }

    // ---------- one phone session ----------

    /** A connected, authenticated phone. Frames wait here (few, newest wins) until the decoder takes them. */
    static final class Session {
        /** More frames than this waiting means the decoder is behind: drop until the next key frame. */
        private static final int MAX_QUEUE = 6;

        private final Socket socket;
        private final OutputStream out;
        private final ArrayDeque<MirrorProtocol.Frame> queue = new ArrayDeque<>();
        private MirrorProtocol.Config config;
        private int configSeq;
        private boolean waitKey;
        private long lastKeyReq;
        volatile boolean ended;
        volatile boolean attached;
        private volatile Runnable onEnd;
        private volatile Runnable onConfig;
        final long startedMs = SystemClock.elapsedRealtime();
        final String peer;
        volatile int received, dropped;

        Session(Socket s) throws IOException {
            socket = s;
            out = new BufferedOutputStream(s.getOutputStream(), 64);
            peer = s.getInetAddress() == null ? "" : s.getInetAddress().getHostAddress();
        }

        void run() {
            openScreen(this);
            Thread pinger = new Thread(this::pingLoop, "otv-phone-ping");
            pinger.setDaemon(true);
            pinger.start();
            String reason = "";
            try {
                DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 256 * 1024));
                while (!ended) {
                    MirrorProtocol.Message m = MirrorProtocol.readMessage(in);
                    switch (m.type) {
                        case MirrorProtocol.T_CONFIG:
                            onConfigMessage(MirrorProtocol.Config.decode(m.payload));
                            break;
                        case MirrorProtocol.T_FRAME:
                            offer(MirrorProtocol.Frame.decode(m.payload, SystemClock.elapsedRealtime()));
                            break;
                        case MirrorProtocol.T_BYE:
                            reason = "bye";
                            ended = true;
                            break;
                        default:
                            break; // PING and unknown types: nothing to do
                    }
                }
            } catch (SocketTimeoutException e) {
                reason = "timeout";
            } catch (EOFException e) {
                reason = "closed";
            } catch (IOException e) {
                reason = ended ? "ended" : "error " + e.getMessage();
            } catch (Throwable t) {
                reason = "error " + t;
                CrashLog.note(app, "Phone session: " + t);
            }
            DebugHooks.event("phone=disconnected reason=" + reason + " frames=" + received + " dropped=" + dropped);
            end(null);
        }

        private void onConfigMessage(MirrorProtocol.Config c) {
            Runnable cb;
            synchronized (this) {
                config = c;
                configSeq++;
                queue.clear();
                waitKey = false;
                cb = onConfig;
                notifyAll();
            }
            DebugHooks.event("phone=config " + c.width + "x" + c.height + " rotation=" + c.rotation);
            if (cb != null) cb.run();
        }

        private void offer(MirrorProtocol.Frame f) {
            boolean ask = false;
            synchronized (this) {
                received++;
                if (f.key) {
                    queue.clear();
                    waitKey = false;
                    queue.add(f);
                } else if (waitKey) {
                    dropped++;
                } else if (queue.size() >= MAX_QUEUE) {
                    // Behind: the waiting frames are late anyway. Keep nothing until a key frame.
                    dropped += queue.size() + 1;
                    queue.clear();
                    waitKey = true;
                    ask = true;
                } else {
                    queue.add(f);
                }
                notifyAll();
            }
            if (ask) requestKeyFrame();
        }

        /** Next frame for the decoder, or null after ms. */
        MirrorProtocol.Frame poll(long ms) throws InterruptedException {
            synchronized (this) {
                if (queue.isEmpty() && !ended && ms > 0) wait(ms);
                return queue.poll();
            }
        }

        synchronized MirrorProtocol.Config config() {
            return config;
        }

        synchronized int configSeq() {
            return configSeq;
        }

        /** Throws away waiting frames until the next key frame and asks the phone for one. */
        void resync() {
            synchronized (this) {
                queue.clear();
                waitKey = true;
            }
            requestKeyFrame();
        }

        void requestKeyFrame() {
            long now = SystemClock.elapsedRealtime();
            synchronized (this) {
                if (now - lastKeyReq < 300) return;
                lastKeyReq = now;
            }
            send(MirrorProtocol.T_KEYREQ, null);
        }

        void setListeners(Runnable onConfig, Runnable onEnd) {
            this.onConfig = onConfig;
            this.onEnd = onEnd;
            attached = onEnd != null;
            if (onEnd != null && ended) onEnd.run();
        }

        private void pingLoop() {
            while (!ended) {
                SystemClock.sleep(PING_MS);
                if (ended) return;
                if (!attached && SystemClock.elapsedRealtime() - startedMs > OPEN_TIMEOUT_MS) {
                    end(Actions.canOpenFromBackground(app)
                            ? "The TV could not open the mirroring screen. Open Office TV on the TV, then try again."
                            : "The TV needs its one-time setup first. Open Office TV on the TV and follow the steps.");
                    return;
                }
                send(MirrorProtocol.T_PING, null);
            }
        }

        private void send(int type, byte[] payload) {
            if (ended && type != MirrorProtocol.T_BYE) return;
            try {
                synchronized (out) {
                    MirrorProtocol.writeMessage(out, type, payload);
                    out.flush();
                }
            } catch (IOException | RuntimeException e) {
                if (type != MirrorProtocol.T_BYE) end(null);
            }
        }

        /** Ends the session because of a problem: the phone shows the reason as an error. */
        void end(String reason) {
            end(reason, true);
        }

        /** Ends the session: tells the phone why (reason null = the connection is already gone). */
        void end(String reason, boolean error) {
            Runnable cb;
            synchronized (this) {
                boolean was = ended;
                ended = true;
                notifyAll();
                if (was && reason == null && socket.isClosed()) return;
                cb = onEnd;
            }
            final byte[] bye = reason != null && !socket.isClosed() ? MirrorProtocol.byePayload(error, reason) : null;
            Runnable close = () -> {
                if (bye != null) send(MirrorProtocol.T_BYE, bye);
                closeQuietly(socket);
            };
            // Back, onStop and "New TV code" end the session on the main thread, where Android forbids network
            // writes (NetworkOnMainThreadException): send the BYE from a short-lived thread there.
            if (Looper.myLooper() == Looper.getMainLooper()) {
                Thread t = new Thread(close, "otv-phone-bye");
                t.setDaemon(true);
                t.start();
            } else {
                close.run();
            }
            synchronized (LOCK) {
                if (active == this) active = null;
            }
            if (cb != null) {
                onEnd = null;
                cb.run();
            }
        }
    }

    static void closeQuietly(java.io.Closeable c) {
        try {
            if (c != null) c.close();
        } catch (IOException ignored) {
        }
    }

    static void closeQuietly(Socket c) {
        try {
            if (c != null) c.close();
        } catch (IOException ignored) {
        }
    }

    static void closeQuietly(ServerSocket c) {
        try {
            if (c != null) c.close();
        } catch (IOException ignored) {
        }
    }
}
