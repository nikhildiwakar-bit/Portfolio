package com.nikhil.officetv.relay;

import java.io.IOException;
import java.net.ProtocolException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import javax.net.ssl.SSLSocketFactory;

/**
 * The MQTT relay transport: WebSocket framing and handshake (WebSocketClient), MQTT packets (MqttConnection) and
 * the broker set (MqttBrokers: fan-out, keep-alive, reconnect with back-off), against FakeMqtt over ws:// and wss://.
 */
public final class MqttTest {
    static final String TOPIC = "officetv/otv2test0123456789abcdef";

    /** Collects what the brokers deliver. */
    static final class Sink implements MqttBrokers.Listener {
        final List<String> messages = Collections.synchronizedList(new ArrayList<>());
        final List<String> from = Collections.synchronizedList(new ArrayList<>());
        final List<Integer> changes = Collections.synchronizedList(new ArrayList<>());

        @Override
        public void onMessage(String text, String brokerUrl) {
            messages.add(text);
            from.add(brokerUrl);
        }

        @Override
        public void onChange(int connected, int total) {
            changes.add(connected);
        }

        int count(String text) {
            int n = 0;
            synchronized (messages) {
                for (String m : messages) if (m.equals(text)) n++;
            }
            return n;
        }
    }

    public static void main(String[] args) {
        try {
            codec();
            websocketUnits();
            handshake();
            brokers();
            framing();
            broken();
            backoff();
            tls();
        } catch (Throwable t) {
            T.fail("unexpected exception", t);
        }
        System.exit(T.finish("MqttTest"));
    }

    static MqttBrokers fast(String[] urls, Sink s, SSLSocketFactory sf) {
        MqttBrokers b = new MqttBrokers(urls, TOPIC, sf, s);
        b.backoffUnitMs = 100;
        b.handshakeTimeoutMs = 2000;
        b.connectTimeoutMs = 2000;
        return b;
    }

    // ------------------------------------------------------------------ packets

    static void codec() throws Exception {
        T.section("MQTT packet encoding");
        int[] ns = {0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455};
        String[] hex = {"00", "01", "7f", "8001", "ff7f", "808001", "ffff7f", "80808001", "ffffff7f"};
        boolean all = true;
        for (int i = 0; i < ns.length; i++) all &= T.hex(MqttConnection.encodeLength(ns[i])).equals(hex[i]);
        T.ok(all, "remaining length 0 .. 268435455 (1-4 bytes, 7 bits each, least significant first)");
        boolean threw = false;
        try {
            MqttConnection.encodeLength(268435456);
        } catch (IllegalArgumentException e) {
            threw = true;
        }
        T.ok(threw, "remaining length > 268435455 rejected");

        String id = "otv0123456789abcdef";
        T.eq("101f00044d5154540402001e0013" + T.hex(id.getBytes(StandardCharsets.US_ASCII)),
                T.hex(MqttConnection.connectPacket(id, 30)), "CONNECT: MQTT level 4, clean session only, keep-alive 30 s, client id");
        T.eq("820a0001000561622f6364" + "00", T.hex(MqttConnection.subscribePacket(1, "ab/cd")),
                "SUBSCRIBE: flags 0b0010, packet id 1, one topic at QoS 0");
        T.eq("300b000561622f6364" + "6869c3a9", T.hex(MqttConnection.publishPacket("ab/cd", "hié")),
                "PUBLISH: QoS 0, retain 0, no packet id, UTF-8 payload");
        T.ok(MqttConnection.newClientId().matches("otv[a-z0-9]{16}"), "client id = otv + 16 random [a-z0-9]");
        T.ok(!MqttConnection.newClientId().equals(MqttConnection.newClientId()), "client ids differ");

        T.section("MQTT packet reader");
        byte[] a = MqttConnection.publishPacket("t", "first");
        byte[] b = MqttConnection.publishPacket("t", "second");
        byte[] two = new byte[a.length + b.length];
        System.arraycopy(a, 0, two, 0, a.length);
        System.arraycopy(b, 0, two, a.length, b.length);
        MqttConnection.PacketReader r = new MqttConnection.PacketReader(MqttConnection.MAX_PACKET);
        List<MqttConnection.Packet> got = r.push(two);
        T.ok(got.size() == 2 && got.get(0).type == 3 && new String(got.get(1).body, StandardCharsets.UTF_8).endsWith("second"),
                "two packets in one chunk");
        List<MqttConnection.Packet> bytewise = new ArrayList<>();
        for (byte x : two) bytewise.addAll(r.push(new byte[] {x}));
        T.ok(bytewise.size() == 2 && r.pending() == 0, "the same packets one byte at a time");
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < 20000; i++) big.append('x');
        byte[] large = MqttConnection.publishPacket("t", big.toString());
        List<MqttConnection.Packet> parts = new ArrayList<>();
        for (int off = 0; off < large.length; off += 7000) {
            byte[] c = new byte[Math.min(7000, large.length - off)];
            System.arraycopy(large, off, c, 0, c.length);
            parts.addAll(r.push(c));
        }
        T.ok(parts.size() == 1 && parts.get(0).body.length == 20003, "a 20 KB packet over three chunks");
        T.ok(throwsProtocol(r, new byte[] {0x30, (byte) 0x80, (byte) 0x80, (byte) 0x80, (byte) 0x80, 1}),
                "remaining length longer than 4 bytes rejected");
        MqttConnection.PacketReader r2 = new MqttConnection.PacketReader(MqttConnection.MAX_PACKET);
        byte[] tooBig = new byte[1 + MqttConnection.encodeLength(65537).length];
        tooBig[0] = 0x30;
        System.arraycopy(MqttConnection.encodeLength(65537), 0, tooBig, 1, tooBig.length - 1);
        T.ok(throwsProtocol(r2, tooBig), "packet > 64 KB rejected before its body arrived");
    }

    static boolean throwsProtocol(MqttConnection.PacketReader r, byte[] b) {
        try {
            r.push(b);
            return false;
        } catch (ProtocolException e) {
            return true;
        }
    }

    // ------------------------------------------------------------------ WebSocket units

    static void websocketUnits() throws Exception {
        T.section("WebSocket units");
        T.eq("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", WebSocketClient.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
                "Sec-WebSocket-Accept of the RFC 6455 example key");
        T.eq("AAECAw==", WebSocketClient.base64(new byte[] {0, 1, 2, 3}), "standard base64 with padding");
        T.eq("+/8=", WebSocketClient.base64(new byte[] {(byte) 0xfb, (byte) 0xff}), "base64 uses + and /");
        int[] lens = {0, 125, 126, 65535, 65536};
        boolean framesOk = true;
        for (int len : lens) {
            byte[] p = new byte[len];
            for (int i = 0; i < len; i++) p[i] = (byte) i;
            byte[] f = WebSocketClient.frame(2, p, 0, len, true);
            int head = len < 126 ? 2 : len < 65536 ? 4 : 10;
            boolean ok = (f[0] & 0xff) == 0x82 && (f[1] & 0x80) != 0 && f.length == head + 4 + len;
            long l = f[1] & 127;
            if (l == 126) l = ((f[2] & 0xff) << 8) | (f[3] & 0xff);
            if (l == 127) {
                l = 0;
                for (int i = 2; i < 10; i++) l = (l << 8) | (f[i] & 0xff);
            }
            ok &= l == len;
            for (int i = 0; i < len && ok; i++) ok = (byte) (f[head + 4 + i] ^ f[head + (i & 3)]) == p[i];
            framesOk &= ok;
        }
        T.ok(framesOk, "client frames: FIN + opcode, MASK bit, 7/16/64-bit lengths, payload masked with the key");

        T.ok(WebSocketClient.dnsMatches("broker.emqx.io", "broker.emqx.io"), "exact name matches");
        T.ok(WebSocketClient.dnsMatches("Broker.EMQX.io.", "broker.emqx.io"), "case and trailing dot ignored");
        T.ok(WebSocketClient.dnsMatches("broker.hivemq.com", "*.hivemq.com"), "wildcard for one label");
        T.ok(!WebSocketClient.dnsMatches("a.b.hivemq.com", "*.hivemq.com"), "wildcard does not span labels");
        T.ok(!WebSocketClient.dnsMatches("hivemq.com", "*.hivemq.com"), "wildcard needs a label");
        T.ok(!WebSocketClient.dnsMatches("x.com", "*.com"), "no wildcard for a top-level domain");
        T.ok(!WebSocketClient.dnsMatches("evil-emqx.io", "broker.emqx.io"), "other name does not match");
        TestTls t = TestTls.localhost();
        T.ok(WebSocketClient.hostMatches("localhost", t.cert) && WebSocketClient.hostMatches("127.0.0.1", t.cert)
                && WebSocketClient.hostMatches("::1", t.cert), "certificate check: DNS and IP subjectAltNames");
        T.ok(!WebSocketClient.hostMatches("example.com", t.cert) && !WebSocketClient.hostMatches("127.0.0.2", t.cert),
                "certificate check: other names and addresses fail");
    }

    // ------------------------------------------------------------------ handshake

    static void handshake() throws Exception {
        T.section("WebSocket handshake");
        FakeMqtt f = FakeMqtt.start();
        WebSocketClient ws = new WebSocketClient(f.url(), "mqtt", null);
        ws.connect(2000);
        ws.handshake(2000);
        T.eq("mqtt", ws.protocol, "server selected subprotocol mqtt");
        T.ok(T.waitFor(1000, () -> f.requests.size() == 1), "one upgrade request");
        Map<String, String> h = f.requests.get(0);
        T.ok("GET /mqtt HTTP/1.1".equals(h.get("request-line")) && ("127.0.0.1:" + f.port()).equals(h.get("host"))
                && "13".equals(h.get("sec-websocket-version")) && "mqtt".equals(h.get("sec-websocket-protocol"))
                && "websocket".equalsIgnoreCase(h.get("upgrade")) && "Upgrade".equals(h.get("connection"))
                && WebSocketClient.base64(new byte[16]).length() == h.get("sec-websocket-key").length(),
                "request: GET path, Host with port, Upgrade, Connection, 16-byte key, version 13, protocol mqtt " + h);
        ws.close();

        f.badAccept = true;
        T.ok(handshakeFails(f.url(), "Sec-WebSocket-Accept"), "wrong Sec-WebSocket-Accept -> refused");
        f.badAccept = false;
        f.protocolReply = "wamp";
        T.ok(handshakeFails(f.url(), "subprotocol"), "another subprotocol -> refused");
        f.protocolReply = null;
        ws = new WebSocketClient(f.url(), "mqtt", null);
        ws.connect(2000);
        ws.handshake(2000);
        T.eq("", ws.protocol, "no Sec-WebSocket-Protocol in the answer is accepted");
        ws.close();
        f.protocolReply = "mqtt";
        f.httpStatus = 503;
        T.ok(handshakeFails(f.url(), "HTTP 503"), "HTTP 503 -> refused with the status");
        f.httpStatus = 101;
        boolean bad = false;
        try {
            new WebSocketClient("https://example.com/mqtt", "mqtt", null);
        } catch (IOException e) {
            bad = true;
        }
        T.ok(bad, "only ws:// and wss:// URLs");
        f.close();

        // A server that accepts TCP but never answers: the handshake gives up after its timeout.
        try (ServerSocket mute = new ServerSocket(0)) {
            WebSocketClient w = new WebSocketClient("ws://127.0.0.1:" + mute.getLocalPort() + "/mqtt", "mqtt", null);
            w.connect(2000);
            long t0 = System.currentTimeMillis();
            boolean timedOut = false;
            try {
                w.handshake(300);
            } catch (IOException e) {
                timedOut = true;
            }
            long took = System.currentTimeMillis() - t0;
            T.ok(timedOut && took >= 250 && took < 2000, "silent server: handshake timeout after " + took + " ms");
            w.close();
        }
    }

    static boolean handshakeFails(String url, String why) {
        try {
            WebSocketClient ws = new WebSocketClient(url, "mqtt", null);
            ws.connect(2000);
            try {
                ws.handshake(2000);
            } finally {
                ws.close();
            }
            return false;
        } catch (IOException e) {
            boolean ok = e.getMessage() != null && e.getMessage().contains(why);
            if (!ok) System.out.println("     (got " + e + ")");
            return ok;
        }
    }

    // ------------------------------------------------------------------ brokers

    static void brokers() throws Exception {
        T.section("three brokers: connect, subscribe, fan-out");
        FakeMqtt[] f = {FakeMqtt.start(), FakeMqtt.start(), FakeMqtt.start()};
        String[] urls = {f[0].url(), f[1].url(), f[2].url()};
        Sink s = new Sink();
        MqttBrokers b = fast(urls, s, null);
        T.eq(0, b.publish("nobody"), "publish before start goes nowhere");
        b.start();
        T.ok(T.waitFor(3000, () -> b.connectedCount() == 3), "all three brokers connected");
        T.eq(3, b.size(), "size 3");
        boolean connectOk = true;
        for (FakeMqtt x : f) {
            Map<String, Object> c = x.connects.get(0);
            connectOk &= "MQTT".equals(c.get("protocol")) && Integer.valueOf(4).equals(c.get("level"))
                    && Integer.valueOf(2).equals(c.get("flags")) && Integer.valueOf(30).equals(c.get("keepAlive"))
                    && String.valueOf(c.get("clientId")).matches("otv[a-z0-9]{16}") && Integer.valueOf(0).equals(c.get("extra"));
        }
        T.ok(connectOk, "CONNECT on each: MQTT level 4, flags 0x02, keep-alive 30, otv client id, nothing else");
        T.ok(!f[0].connects.get(0).get("clientId").equals(f[1].connects.get(0).get("clientId")), "a new client id per connection");
        boolean subOk = true;
        for (FakeMqtt x : f) {
            subOk &= x.subscribeTopics.size() == 1 && TOPIC.equals(x.subscribeTopics.get(0))
                    && x.subscribeIds.get(0)[0] == 1 && x.subscribeIds.get(0)[1] == 0 && x.subscribeIds.get(0)[2] == 2;
        }
        T.ok(subOk, "SUBSCRIBE on each: packet id 1, the topic, QoS 0");
        T.ok(s.changes.size() >= 1 && s.changes.get(s.changes.size() - 1) == 3, "onChange reported 3 connected");

        T.eq(3, b.publish("hello all"), "publish went to 3 brokers");
        T.ok(T.waitFor(2000, () -> f[0].texts(TOPIC).contains("hello all") && f[1].texts(TOPIC).contains("hello all")
                && f[2].texts(TOPIC).contains("hello all")), "each broker received it");
        T.ok(T.waitFor(2000, () -> s.count("hello all") == 3), "own publish echoed back by each broker (MQTT has no no-local)");
        f[1].publish(TOPIC, "from broker 1");
        f[1].publish("officetv/other", "not ours");
        T.ok(T.waitFor(2000, () -> s.count("from broker 1") == 1), "message from one broker delivered once");
        T.eq(f[1].url(), s.from.get(s.messages.indexOf("from broker 1")), "with that broker's URL");
        T.sleep(200);
        T.eq(0, s.count("not ours"), "other topics are not delivered");
        String uni = "été 中文 😀";
        f[2].publish(TOPIC, uni);
        T.ok(T.waitFor(2000, () -> s.count(uni) == 1), "UTF-8 payload intact");

        T.section("QoS 1 from a broker");
        int acks = f[0].pubacks.size();
        f[0].publishQos1(TOPIC, "qos1 message", 0x1234);
        T.ok(T.waitFor(2000, () -> f[0].pubacks.size() == acks + 1), "PUBACK sent");
        T.eq(Integer.valueOf(0x1234), f[0].pubacks.get(f[0].pubacks.size() - 1), "PUBACK carries the packet id");
        T.sleep(200);
        T.eq(0, s.count("qos1 message"), "QoS 1 message dropped (we subscribe at QoS 0)");
        T.eq(3, b.connectedCount(), "still connected");

        T.section("keep-alive");
        b.stop();
        T.ok(T.waitFor(2000, () -> !b.thread(0).isAlive() && !b.thread(1).isAlive() && !b.thread(2).isAlive()),
                "stop(): every broker thread ended");
        T.ok(T.waitFor(2000, () -> f[0].disconnects.get() == 1 && f[1].disconnects.get() == 1 && f[2].disconnects.get() == 1),
                "stop(): DISCONNECT sent to each broker");
        T.eq(0, b.connectedCount(), "stop(): none connected");
        T.eq(0, b.publish("after stop"), "stop(): publish goes nowhere");
        T.eq(0, f[0].unmaskedFrames.get() + f[1].unmaskedFrames.get() + f[2].unmaskedFrames.get(), "every client frame was masked");

        Sink s2 = new Sink();
        MqttBrokers k = fast(urls, s2, null);
        k.pingMs = 150;
        k.pongTimeoutMs = 250;
        f[0].noPong = true;
        int accepts0 = f[0].accepts.size();
        int accepts1 = f[1].accepts.size();
        int pings1 = f[1].pingreqs.get();
        k.start();
        T.ok(T.waitFor(3000, () -> k.connectedCount() == 3), "connected (pings every 150 ms)");
        T.ok(T.waitFor(3000, () -> f[0].accepts.size() >= accepts0 + 2), "no PINGRESP within 250 ms -> that broker reconnects");
        T.ok(f[1].pingreqs.get() - pings1 >= 2, "PINGREQ sent regularly (" + (f[1].pingreqs.get() - pings1) + ")");
        T.eq(accepts1 + 1, f[1].accepts.size(), "brokers that answer pings stay connected");
        T.ok(k.lastError(0).contains("PINGRESP"), "reason noted: " + k.lastError(0));
        f[0].noPong = false;
        k.stop();
        for (FakeMqtt x : f) x.close();
    }

    // ------------------------------------------------------------------ framing

    static void framing() throws Exception {
        T.section("WebSocket framing from the broker");
        FakeMqtt f = FakeMqtt.start();
        Sink s = new Sink();
        f.splitAt = 3;
        MqttBrokers b = fast(new String[] {f.url()}, s, null);
        b.start();
        T.ok(T.waitFor(3000, () -> b.connectedCount() == 1), "CONNACK and SUBACK split over messages of 3 bytes");
        f.publish(TOPIC, "split message");
        T.ok(T.waitFor(2000, () -> s.count("split message") == 1), "PUBLISH split over 3-byte messages");
        f.fragment = true;
        f.splitAt = 5;
        f.publish(TOPIC, "fragmented message");
        T.ok(T.waitFor(2000, () -> s.count("fragmented message") == 1), "PUBLISH in continuation frames of one message");
        f.fragment = false;
        f.splitAt = 0;
        byte[] a = FakeMqtt.publishBytes(TOPIC, "one", 0, 0);
        byte[] c = FakeMqtt.publishBytes(TOPIC, "two", 0, 0);
        byte[] both = new byte[a.length + c.length];
        System.arraycopy(a, 0, both, 0, a.length);
        System.arraycopy(c, 0, both, a.length, c.length);
        f.sendRaw(both);
        T.ok(T.waitFor(2000, () -> s.count("one") == 1 && s.count("two") == 1), "two packets in one frame");
        byte[] head = new byte[1 + 1 + 20];
        System.arraycopy(both, 0, head, 0, 0);
        byte[] first = new byte[both.length - 4];
        System.arraycopy(both, 0, first, 0, first.length);
        byte[] rest = new byte[4];
        System.arraycopy(both, both.length - 4, rest, 0, 4);
        f.sendRaw(first);
        T.sleep(100);
        f.sendRaw(rest);
        T.ok(T.waitFor(2000, () -> s.count("one") == 2 && s.count("two") == 2), "a packet spanning two messages");
        f.sendFrame(FakeMqtt.frame(true, 9, "are you there".getBytes(StandardCharsets.UTF_8), 0, 13));
        T.ok(T.waitFor(2000, () -> f.pongs.contains("are you there")), "ping frame answered with a pong carrying its payload");
        f.sendFrame(FakeMqtt.frame(true, 1, "text is not mqtt".getBytes(StandardCharsets.UTF_8), 0, 16));
        f.sendFrame(FakeMqtt.frame(true, 10, new byte[0], 0, 0));
        f.publish(TOPIC, "after text");
        T.ok(T.waitFor(2000, () -> s.count("after text") == 1), "text frames and unsolicited pongs are ignored");
        T.eq(1, f.accepts.size(), "all on one connection");
        T.eq(0, f.unmaskedFrames.get(), "client frames masked");
        b.stop();
        f.close();
    }

    // ------------------------------------------------------------------ broken connections

    static void broken() throws Exception {
        T.section("broken connections reconnect");
        FakeMqtt f = FakeMqtt.start();
        Sink s = new Sink();
        MqttBrokers b = fast(new String[] {f.url()}, s, null);
        b.start();
        T.ok(T.waitFor(3000, () -> b.connectedCount() == 1), "connected");

        int acc = f.accepts.size();
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < 70000; i++) big.append('x');
        f.sendRaw(FakeMqtt.publishBytes(TOPIC, big.toString().substring(0, 65000), 0, 0));
        T.ok(T.waitFor(1000, () -> s.messages.size() == 1), "a 65 KB publish (under the limit) is delivered");
        f.fragment = true;
        f.splitAt = 30000;
        f.publish(TOPIC, big.toString()); // 70 KB packet: too large
        f.fragment = false;
        f.splitAt = 0;
        T.ok(T.waitFor(3000, () -> f.accepts.size() == acc + 1 && b.connectedCount() == 1), "packet > 64 KB -> reconnected");
        T.ok(b.lastError(0).contains("too large"), "reason: " + b.lastError(0));

        int acc2 = f.accepts.size();
        byte[] huge = new byte[100000];
        f.sendFrame(FakeMqtt.frame(true, 2, huge, 0, huge.length));
        T.ok(T.waitFor(3000, () -> f.accepts.size() == acc2 + 1 && b.connectedCount() == 1), "frame > 64 KB -> reconnected");

        int acc3 = f.accepts.size();
        f.sendFrame(new byte[] {(byte) 0x82, (byte) 0x81, 1, 2, 3, 4, 5});
        T.ok(T.waitFor(3000, () -> f.accepts.size() == acc3 + 1 && b.connectedCount() == 1), "masked server frame -> reconnected");

        int acc4 = f.accepts.size();
        f.sendFrame(new byte[] {(byte) 0x80, 1, 0});
        T.ok(T.waitFor(3000, () -> f.accepts.size() == acc4 + 1 && b.connectedCount() == 1), "continuation without a message -> reconnected");

        int acc5 = f.accepts.size();
        f.sendFrame(FakeMqtt.frame(true, 8, new byte[] {0x03, (byte) 0xe8}, 0, 2));
        T.ok(T.waitFor(3000, () -> f.accepts.size() == acc5 + 1 && b.connectedCount() == 1), "close frame from the broker -> reconnected");

        int acc6 = f.accepts.size();
        f.drop();
        T.ok(T.waitFor(3000, () -> f.accepts.size() == acc6 + 1 && b.connectedCount() == 1), "socket cut -> reconnected");
        f.publish(TOPIC, "still works");
        T.ok(T.waitFor(2000, () -> s.count("still works") == 1), "messages flow after the reconnects");
        b.stop();

        T.section("refused by the broker");
        f.connackCode = 5;
        Sink s2 = new Sink();
        MqttBrokers r = fast(new String[] {f.url()}, s2, null);
        int acc7 = f.accepts.size();
        r.start();
        T.ok(T.waitFor(3000, () -> f.accepts.size() >= acc7 + 2), "CONNACK code 5 -> retried");
        T.eq(0, r.connectedCount(), "not counted as connected");
        T.ok(r.lastError(0).contains("refused"), "reason: " + r.lastError(0));
        f.connackCode = 0;
        f.refuseSubscribe = true;
        T.ok(T.waitFor(3000, () -> r.lastError(0).contains("subscription")), "SUBACK 0x80 -> not connected: " + r.lastError(0));
        T.eq(0, r.connectedCount(), "still not connected");
        f.refuseSubscribe = false;
        T.ok(T.waitFor(3000, () -> r.connectedCount() == 1), "connects once the broker accepts");
        r.stop();

        T.section("silent broker");
        f.silent = true;
        Sink s3 = new Sink();
        MqttBrokers q = fast(new String[] {f.url()}, s3, null);
        q.handshakeTimeoutMs = 300;
        int acc8 = f.accepts.size();
        long t0 = System.currentTimeMillis();
        q.start();
        T.ok(T.waitFor(3000, () -> f.accepts.size() >= acc8 + 2), "no CONNACK within the handshake timeout -> retried");
        long took = f.accepts.get(acc8 + 1) - t0;
        T.ok(took >= 300 && took < 1500, "second attempt after timeout + back-off: " + took + " ms");
        T.eq(0, q.connectedCount(), "never counted as connected");
        q.stop();
        f.silent = false;

        T.section("stop() while connecting");
        try (ServerSocket mute = new ServerSocket(0)) {
            MqttBrokers m = fast(new String[] {"ws://127.0.0.1:" + mute.getLocalPort() + "/mqtt"}, new Sink(), null);
            m.handshakeTimeoutMs = 30000;
            m.start();
            T.sleep(200);
            long s0 = System.nanoTime();
            m.stop();
            long stopMs = (System.nanoTime() - s0) / 1000000;
            m.thread(0).join(2000);
            T.ok(stopMs < 500 && !m.thread(0).isAlive(), "stop() returned in " + stopMs + " ms and the thread ended during a handshake");
        }
        f.close();
    }

    // ------------------------------------------------------------------ back-off

    static void backoff() throws Exception {
        T.section("reconnect back-off 1, 2, 4 ... (unit 100 ms), reset after CONNACK");
        FakeMqtt f = FakeMqtt.start();
        f.refuse = true;
        Sink s = new Sink();
        MqttBrokers b = fast(new String[] {f.url()}, s, null);
        b.start();
        T.ok(T.waitFor(4000, () -> f.accepts.size() >= 5), "retrying");
        List<Long> a = new ArrayList<>(f.accepts);
        long g1 = a.get(1) - a.get(0), g2 = a.get(2) - a.get(1), g3 = a.get(3) - a.get(2), g4 = a.get(4) - a.get(3);
        System.out.println("     gaps: " + g1 + ", " + g2 + ", " + g3 + ", " + g4 + " ms");
        T.ok(g1 >= 90 && g1 < 190 && g2 >= 190 && g2 < 350 && g3 >= 390 && g3 < 650 && g4 >= 790 && g4 < 1200,
                "gaps about 100, 200, 400, 800 ms");
        f.refuse = false;
        T.ok(T.waitFor(3000, () -> b.connectedCount() == 1), "connects once the broker is back");
        int n = f.accepts.size();
        long cut = System.currentTimeMillis();
        f.drop();
        T.ok(T.waitFor(3000, () -> f.accepts.size() == n + 1), "reconnected after the cut");
        long again = f.accepts.get(n) - cut;
        T.ok(again >= 90 && again < 300, "first retry after a working connection waits 1 unit again: " + again + " ms");
        b.stop();
        f.close();

        T.section("unreachable broker");
        int port;
        try (ServerSocket x = new ServerSocket(0)) {
            port = x.getLocalPort();
        }
        MqttBrokers u = fast(new String[] {"ws://127.0.0.1:" + port + "/mqtt"}, new Sink(), null);
        u.start();
        T.ok(T.waitFor(2000, () -> u.attempts.get() >= 2), "connection refused -> retried");
        T.ok(u.lastError(0).startsWith("Could not connect"), "reason: " + u.lastError(0));
        u.stop();
    }

    // ------------------------------------------------------------------ wss

    static void tls() throws Exception {
        T.section("wss:// with a certificate check");
        TestTls t = TestTls.localhost();
        FakeMqtt f = FakeMqtt.startTls(t);
        Sink s = new Sink();
        String viaIp = "wss://127.0.0.1:" + f.port() + "/mqtt";
        MqttBrokers b = fast(new String[] {f.url(), viaIp}, s, t.client);
        b.start();
        T.ok(T.waitFor(5000, () -> b.connectedCount() == 2), "wss://localhost and wss://127.0.0.1 connect (names in the certificate)");
        T.ok(f.requests.size() >= 2 && ("localhost:" + f.port()).equals(f.requests.get(0).get("host")) || ("localhost:" + f.port()).equals(f.requests.get(1).get("host")),
                "Host header with the name");
        f.publish(TOPIC, "over tls");
        T.ok(T.waitFor(2000, () -> s.count("over tls") == 2), "messages over TLS");
        b.stop();

        MqttBrokers untrusted = fast(new String[] {f.url()}, new Sink(), null);
        untrusted.start();
        T.ok(T.waitFor(5000, () -> untrusted.attempts.get() >= 2), "untrusted certificate -> retried");
        T.eq(0, untrusted.connectedCount(), "untrusted certificate never connects");
        T.ok(untrusted.lastError(0).startsWith("Secure connection failed"), "reason: " + untrusted.lastError(0));
        untrusted.stop();
        f.close();

        TestTls other = TestTls.create("SAN=dns:other.invalid");
        FakeMqtt g = FakeMqtt.startTls(other);
        MqttBrokers wrong = fast(new String[] {g.url()}, new Sink(), other.client);
        wrong.start();
        T.ok(T.waitFor(5000, () -> wrong.attempts.get() >= 2), "trusted certificate for another name -> retried");
        T.eq(0, wrong.connectedCount(), "never connects");
        T.eq(0, g.connects.size(), "no MQTT CONNECT was sent to it");
        T.ok(wrong.lastError(0).startsWith("Secure connection failed"), "reason: " + wrong.lastError(0));
        wrong.stop();
        g.close();
    }
}
