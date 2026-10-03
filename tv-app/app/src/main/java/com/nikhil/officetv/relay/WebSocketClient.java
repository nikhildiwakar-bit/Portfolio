package com.nikhil.officetv.relay;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ProtocolException;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateParsingException;
import java.security.cert.X509Certificate;
import java.util.Collection;
import java.util.List;
import java.util.Locale;

import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Client side of RFC 6455 WebSockets, just what the MQTT relay needs (PROTOCOL.md section 6): wss:// (TLS with
 * SNI and a hostname check against the certificate) or ws:// (tests only), one subprotocol, masked client frames,
 * and binary messages read as one byte stream: {@link #read()} returns the payload of each binary frame (a message
 * split into continuation frames simply arrives in pieces), answers pings, skips text messages and pongs, and
 * returns null once the server closed. Frames bigger than {@link #MAX_FRAME} are a protocol error.
 * <p>
 * Use: {@link #connect} (TCP), {@link #handshake} (TLS + HTTP upgrade), then one thread calls {@link #read()} while
 * any thread may {@link #sendBinary}. {@link #close()} works from any thread at any time, also during connect and
 * handshake, and makes a blocked call throw. Every call blocks on the network: never use it on a UI thread.
 * Pure Java, safe on Android API 21.
 */
final class WebSocketClient {
    static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    /** Largest frame payload accepted: one 64 KB MQTT packet with its fixed header. */
    static final int MAX_FRAME = 64 * 1024 + 5;
    private static final int MAX_HEADERS = 16 * 1024;
    private static final String UA = "OfficeTV-relay/1";
    private static final SecureRandom RNG = new SecureRandom();

    static final int OP_CONT = 0, OP_TEXT = 1, OP_BINARY = 2, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;

    private final String url;
    private final boolean tls;
    private final String host;
    private final int port;
    private final String hostHeader;
    private final String path;
    private final String subprotocol;
    private final SSLSocketFactory ssl;

    private final Object lock = new Object();
    private final Object writeLock = new Object();
    private Socket raw;
    private Socket sock;
    private InputStream in;
    private OutputStream out;
    private volatile boolean closed;
    private boolean closeSent;
    /** Opcode of the message whose continuation frames are expected (OP_TEXT / OP_BINARY), or -1. */
    private int continuing = -1;
    /** Subprotocol the server selected ("" if it named none). */
    volatile String protocol = "";

    /**
     * @param url         ws:// or wss:// URL
     * @param subprotocol Sec-WebSocket-Protocol to ask for (null = none)
     * @param ssl         socket factory for wss:// (null = the platform default)
     */
    WebSocketClient(String url, String subprotocol, SSLSocketFactory ssl) throws IOException {
        URI u;
        try {
            u = new URI(url);
        } catch (URISyntaxException e) {
            throw new IOException("Bad WebSocket URL: " + url);
        }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("ws") && !scheme.equals("wss")) throw new IOException("Not a WebSocket URL: " + url);
        String h = u.getHost();
        if (h == null || h.isEmpty()) throw new IOException("No host in " + url);
        this.url = url;
        this.tls = scheme.equals("wss");
        this.host = h.startsWith("[") && h.endsWith("]") ? h.substring(1, h.length() - 1) : h;
        int defPort = tls ? 443 : 80;
        this.port = u.getPort() > 0 ? u.getPort() : defPort;
        this.hostHeader = h + (this.port == defPort ? "" : ":" + this.port);
        String p = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
        this.path = u.getRawQuery() != null ? p + "?" + u.getRawQuery() : p;
        this.subprotocol = subprotocol;
        this.ssl = ssl != null ? ssl : (SSLSocketFactory) SSLSocketFactory.getDefault();
    }

    String url() {
        return url;
    }

    String host() {
        return host;
    }

    boolean isClosed() {
        return closed;
    }

    // ---------------------------------------------------------------- opening

    /** TCP connect (host name lookup included). */
    void connect(int timeoutMs) throws IOException {
        Socket s = new Socket();
        synchronized (lock) {
            if (closed) throw new SocketException("WebSocket closed");
            raw = s;
        }
        s.setTcpNoDelay(true);
        s.connect(new InetSocketAddress(host, port), timeoutMs);
        if (closed) throw new SocketException("WebSocket closed");
    }

    /** TLS (for wss://) and the HTTP upgrade. Every read may wait at most timeoutMs, the headers as a whole too. */
    void handshake(int timeoutMs) throws IOException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        Socket r;
        synchronized (lock) {
            r = raw;
        }
        if (r == null) throw new SocketException("Not connected");
        r.setSoTimeout(timeoutMs);
        Socket s = r;
        if (tls) {
            // Passing the host name makes the TLS stack send it as SNI (Android and desktop Java alike).
            SSLSocket t = (SSLSocket) ssl.createSocket(r, host, port, true);
            synchronized (lock) {
                if (closed) {
                    closeQuietly(t);
                    throw new SocketException("WebSocket closed");
                }
                sock = t;
            }
            t.setSoTimeout(timeoutMs);
            t.startHandshake();
            verifyHost(t);
            s = t;
        }
        InputStream i = new BufferedInputStream(s.getInputStream(), 8192);
        OutputStream o = new BufferedOutputStream(s.getOutputStream(), 8192);
        synchronized (lock) {
            if (closed) throw new SocketException("WebSocket closed");
            sock = s;
            in = i;
            out = o;
        }

        byte[] nonce = new byte[16];
        RNG.nextBytes(nonce);
        String key = base64(nonce);
        StringBuilder req = new StringBuilder(256);
        req.append("GET ").append(path).append(" HTTP/1.1\r\n")
                .append("Host: ").append(hostHeader).append("\r\n")
                .append("Upgrade: websocket\r\n")
                .append("Connection: Upgrade\r\n")
                .append("Sec-WebSocket-Key: ").append(key).append("\r\n")
                .append("Sec-WebSocket-Version: 13\r\n");
        if (subprotocol != null) req.append("Sec-WebSocket-Protocol: ").append(subprotocol).append("\r\n");
        req.append("User-Agent: ").append(UA).append("\r\n\r\n");
        synchronized (writeLock) {
            o.write(req.toString().getBytes(Pairing.UTF8));
            o.flush();
        }

        String status = readHeaderLine(i, deadline);
        String[] sp = status.split(" ", 3);
        if (sp.length < 2 || !sp[0].startsWith("HTTP/")) throw new ProtocolException("Not an HTTP response");
        if (!sp[1].equals("101")) throw new ProtocolException("WebSocket upgrade refused (HTTP " + sp[1] + ")");
        String upgrade = null, connection = null, accept = null, proto = null;
        int total = status.length();
        while (true) {
            String line = readHeaderLine(i, deadline);
            if (line.isEmpty()) break;
            total += line.length();
            if (total > MAX_HEADERS) throw new ProtocolException("Response headers too large");
            int c = line.indexOf(':');
            if (c <= 0) continue;
            String name = line.substring(0, c).trim().toLowerCase(Locale.ROOT);
            String value = line.substring(c + 1).trim();
            if (name.equals("upgrade")) upgrade = value;
            else if (name.equals("connection")) connection = value;
            else if (name.equals("sec-websocket-accept")) accept = value;
            else if (name.equals("sec-websocket-protocol")) proto = value;
        }
        if (upgrade == null || !upgrade.equalsIgnoreCase("websocket")) throw new ProtocolException("No Upgrade: websocket");
        if (connection == null || !hasToken(connection, "upgrade")) throw new ProtocolException("No Connection: Upgrade");
        if (accept == null || !accept.equals(acceptKey(key))) throw new ProtocolException("Wrong Sec-WebSocket-Accept");
        if (proto != null && !proto.isEmpty() && (subprotocol == null || !proto.equalsIgnoreCase(subprotocol))) {
            throw new ProtocolException("Server chose another subprotocol: " + proto);
        }
        protocol = proto == null ? "" : proto;
        if (closed) throw new SocketException("WebSocket closed");
    }

    /** SO_TIMEOUT for reads after the handshake (0 = none). */
    void setReadTimeout(int ms) throws IOException {
        Socket r, s;
        synchronized (lock) {
            r = raw;
            s = sock;
        }
        if (r != null) r.setSoTimeout(ms);
        if (s != null && s != r) s.setSoTimeout(ms);
    }

    private static String readHeaderLine(InputStream i, long deadline) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(128);
        while (true) {
            if (System.currentTimeMillis() > deadline) throw new SocketTimeoutException("WebSocket handshake timeout");
            int c = i.read();
            if (c < 0) throw new EOFException("Connection closed during the WebSocket handshake");
            if (c == '\n') break;
            if (c == '\r') continue;
            if (b.size() >= MAX_HEADERS) throw new ProtocolException("Header line too long");
            b.write(c);
        }
        return new String(b.toByteArray(), Pairing.UTF8);
    }

    private static boolean hasToken(String list, String token) {
        for (String t : list.split(",")) if (t.trim().equalsIgnoreCase(token)) return true;
        return false;
    }

    /** base64(SHA-1(key + GUID)), the Sec-WebSocket-Accept the server must answer. */
    static String acceptKey(String key) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            return base64(sha1.digest((key + GUID).getBytes(Pairing.UTF8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Standard base64 with padding (RFC 4648 section 4). */
    static String base64(byte[] b) {
        StringBuilder s = new StringBuilder(RelayCrypto.b64url(b).replace('-', '+').replace('_', '/'));
        while (s.length() % 4 != 0) s.append('=');
        return s.toString();
    }

    // ---------------------------------------------------------------- host name check

    /** Like HttpsURLConnection's check: the server certificate must be issued for the host we connected to. */
    private void verifyHost(SSLSocket t) throws IOException {
        Certificate[] chain = t.getSession().getPeerCertificates();
        if (chain.length == 0 || !(chain[0] instanceof X509Certificate) || !hostMatches(host, (X509Certificate) chain[0])) {
            throw new SSLPeerUnverifiedException("Certificate is not valid for " + host);
        }
    }

    /** RFC 6125 style: DNS names (a wildcard only as the whole left-most label) or IP addresses from subjectAltName. */
    static boolean hostMatches(String host, X509Certificate cert) {
        Collection<List<?>> names;
        try {
            names = cert.getSubjectAlternativeNames();
        } catch (CertificateParsingException e) {
            return false;
        }
        if (names == null) return false;
        boolean ip = isIpLiteral(host);
        for (List<?> e : names) {
            if (e == null || e.size() < 2 || !(e.get(0) instanceof Integer) || !(e.get(1) instanceof String)) continue;
            int type = (Integer) e.get(0);
            String v = (String) e.get(1);
            if (ip && type == 7 && sameIp(host, v)) return true;
            if (!ip && type == 2 && dnsMatches(host, v)) return true;
        }
        return false;
    }

    static boolean isIpLiteral(String h) {
        return h.indexOf(':') >= 0 || h.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}");
    }

    private static boolean sameIp(String a, String b) {
        if (!isIpLiteral(b)) return false;
        try {
            // Literals only, so no name lookup happens here.
            return InetAddress.getByName(a).equals(InetAddress.getByName(b));
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    static boolean dnsMatches(String host, String pattern) {
        String h = trimDot(host.toLowerCase(Locale.ROOT));
        String p = trimDot(pattern.toLowerCase(Locale.ROOT));
        if (h.isEmpty() || p.isEmpty()) return false;
        if (!p.startsWith("*.")) return h.equals(p);
        String suffix = p.substring(1); // ".example.com"
        if (suffix.indexOf('*') >= 0 || suffix.indexOf('.', 1) < 0) return false; // no "*.com"
        if (!h.endsWith(suffix)) return false;
        String label = h.substring(0, h.length() - suffix.length());
        return !label.isEmpty() && label.indexOf('.') < 0;
    }

    private static String trimDot(String s) {
        return s.endsWith(".") ? s.substring(0, s.length() - 1) : s;
    }

    // ---------------------------------------------------------------- frames

    /**
     * Next piece of binary data: the payload of a binary frame or of a continuation frame of a binary message
     * (possibly empty). Answers pings, skips pongs and text messages. Returns null when the server closed the
     * connection (close frame or end of stream). Throws on protocol errors and timeouts.
     */
    byte[] read() throws IOException {
        InputStream i;
        synchronized (lock) {
            i = in;
        }
        if (i == null) throw new SocketException("Not connected");
        while (true) {
            int b0 = i.read();
            if (b0 < 0) return null;
            int b1 = readByte(i);
            boolean fin = (b0 & 0x80) != 0;
            int op = b0 & 0x0f;
            if ((b0 & 0x70) != 0) throw new ProtocolException("WebSocket frame with reserved bits set");
            if ((b1 & 0x80) != 0) throw new ProtocolException("Masked WebSocket frame from the server");
            long len = b1 & 0x7f;
            if (len == 126) {
                len = (readByte(i) << 8) | readByte(i);
            } else if (len == 127) {
                len = 0;
                for (int k = 0; k < 8; k++) len = (len << 8) | readByte(i);
                if (len < 0) throw new ProtocolException("Bad WebSocket frame length");
            }
            if (len > MAX_FRAME) throw new ProtocolException("WebSocket frame too large (" + len + " bytes)");
            if (op >= 8 && (!fin || len > 125)) throw new ProtocolException("Bad WebSocket control frame");
            byte[] payload = new byte[(int) len];
            readFully(i, payload);
            switch (op) {
                case OP_CONT: {
                    if (continuing < 0) throw new ProtocolException("Unexpected WebSocket continuation frame");
                    int of = continuing;
                    if (fin) continuing = -1;
                    if (of == OP_BINARY) return payload;
                    break;
                }
                case OP_TEXT:
                case OP_BINARY:
                    if (continuing >= 0) throw new ProtocolException("WebSocket message interleaved with another");
                    if (!fin) continuing = op;
                    if (op == OP_BINARY) return payload;
                    break; // Text is not MQTT: ignore it.
                case OP_CLOSE:
                    try {
                        // Echo the status code, as RFC 6455 section 5.5.1 asks.
                        byte[] code = payload.length >= 2 ? new byte[] {payload[0], payload[1]} : new byte[0];
                        sendClose(code);
                    } catch (IOException ignored) {
                    }
                    close();
                    return null;
                case OP_PING:
                    send(OP_PONG, payload, 0, payload.length);
                    break;
                case OP_PONG:
                    break;
                default:
                    throw new ProtocolException("Unknown WebSocket opcode " + op);
            }
        }
    }

    private static int readByte(InputStream i) throws IOException {
        int b = i.read();
        if (b < 0) throw new EOFException("Connection closed in a WebSocket frame");
        return b;
    }

    private static void readFully(InputStream i, byte[] b) throws IOException {
        int off = 0;
        while (off < b.length) {
            int n = i.read(b, off, b.length - off);
            if (n < 0) throw new EOFException("Connection closed in a WebSocket frame");
            off += n;
        }
    }

    /** Sends one binary message (one frame). */
    void sendBinary(byte[] b) throws IOException {
        send(OP_BINARY, b, 0, b.length);
    }

    /** Sends a close frame once (best effort before closing). */
    void sendClose(byte[] payload) throws IOException {
        synchronized (writeLock) {
            if (closeSent) return;
            closeSent = true;
        }
        send(OP_CLOSE, payload, 0, payload.length);
    }

    void send(int opcode, byte[] b, int off, int len) throws IOException {
        OutputStream o;
        synchronized (lock) {
            o = out;
        }
        if (o == null || closed) throw new SocketException("WebSocket not open");
        byte[] frame = frame(opcode, b, off, len, true);
        synchronized (writeLock) {
            o.write(frame);
            o.flush();
        }
    }

    /** One final frame; masked with a random key when mask is true (every client frame is). */
    static byte[] frame(int opcode, byte[] b, int off, int len, boolean mask) {
        int head = 2 + (len < 126 ? 0 : len < 65536 ? 2 : 8) + (mask ? 4 : 0);
        byte[] f = new byte[head + len];
        f[0] = (byte) (0x80 | opcode);
        int p = 1;
        int m = mask ? 0x80 : 0;
        if (len < 126) {
            f[p++] = (byte) (m | len);
        } else if (len < 65536) {
            f[p++] = (byte) (m | 126);
            f[p++] = (byte) (len >> 8);
            f[p++] = (byte) len;
        } else {
            f[p++] = (byte) (m | 127);
            for (int k = 7; k >= 0; k--) f[p++] = (byte) (k >= 4 ? 0 : len >>> (8 * k));
        }
        if (!mask) {
            System.arraycopy(b, off, f, p, len);
            return f;
        }
        byte[] key = new byte[4];
        RNG.nextBytes(key);
        System.arraycopy(key, 0, f, p, 4);
        p += 4;
        for (int k = 0; k < len; k++) f[p + k] = (byte) (b[off + k] ^ key[k & 3]);
        return f;
    }

    /** Closes the sockets at once (raw first, which also wakes a blocked TLS read). Safe from any thread, repeatedly. */
    void close() {
        Socket r, s;
        synchronized (lock) {
            closed = true;
            r = raw;
            s = sock;
        }
        closeQuietly(r);
        if (s != r) closeQuietly(s);
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (Throwable ignored) {
        }
    }
}
