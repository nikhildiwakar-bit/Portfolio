package com.nikhil.officetv.relay;

import org.json.JSONObject;

import java.net.ServerSocket;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLSocketFactory;

/** RelayClient against FakeNtfy on a random port, over https (like ntfy.sh) and plain http. */
public final class RelayClientTest {
    static final String TV_UA = "OfficeTV-relay";

    /** Records everything and answers like a small TV. */
    static final class Recorder implements RelayClient.Handler {
        final List<String> commands = Collections.synchronizedList(new ArrayList<>());
        final List<String> states = Collections.synchronizedList(new ArrayList<>());
        volatile CountDownLatch slow;

        int count(String tag) {
            int n = 0;
            synchronized (commands) {
                for (String c : commands) if (c.contains("\"tag\":\"" + tag + "\"")) n++;
            }
            return n;
        }

        boolean sawState(String prefix, int from) {
            synchronized (states) {
                for (int i = from; i < states.size(); i++) if (states.get(i).startsWith(prefix)) return true;
            }
            return false;
        }

        @Override
        public JSONObject onCommand(String cmd, JSONObject args) {
            commands.add(cmd + " " + args);
            JSONObject r = new JSONObject().put("ok", true).put("msg", "Done: " + cmd);
            try {
                switch (cmd) {
                    case "ping":
                        r.put("data", new JSONObject().put("name", "Test TV").put("volume", 6));
                        break;
                    case "slow":
                        CountDownLatch l = slow;
                        if (l != null) l.await(10, TimeUnit.SECONDS);
                        break;
                    case "big":
                        // Far too big for one envelope: the client must drop data and cut msg.
                        StringBuilder m = new StringBuilder();
                        for (int i = 0; i < 10000; i++) m.append('M');
                        StringBuilder blob = new StringBuilder();
                        for (int i = 0; i < 5000; i++) blob.append('b');
                        r.put("msg", m.toString()).put("data", new JSONObject().put("blob", blob.toString()));
                        break;
                    case "boom":
                        throw new IllegalStateException("handler bug");
                    default:
                        break;
                }
            } catch (InterruptedException e) {
                return new JSONObject().put("ok", false).put("msg", "interrupted");
            }
            return r;
        }

        @Override
        public void onState(RelayClient.State state, String detail) {
            states.add(state + " " + detail);
        }
    }

    public static void main(String[] args) {
        try {
            httpsSuite();
            httpSuite();
            offlineSuite();
        } catch (Throwable t) {
            T.fail("unexpected exception", t);
        }
        System.exit(T.finish("RelayClientTest"));
    }

    static JSONObject tag(String t) {
        return new JSONObject().put("tag", t);
    }

    // ------------------------------------------------------------------ https (production-like)

    static void httpsSuite() throws Exception {
        T.section("https relay: connect");
        FakeNtfy fake = FakeNtfy.start(0, true, 30000);
        SSLSocketFactory sf = fake.clientSocketFactory();
        String code = Pairing.newCode(new SecureRandom());
        Recorder h = new Recorder();
        RelayClient c = new RelayClient(fake.baseUrl() + "/", code, h, sf);
        c.backoffUnitMs = 100;
        c.rateLimitMinMs = 700;
        TestController ctl = new TestController(fake.baseUrl(), code, sf);
        ctl.subscribe(5000);
        String topic = c.topic();
        T.eq(Pairing.topic(code), topic, "client topic");
        c.start();
        c.start();
        T.ok(T.waitFor(5000, () -> c.state() == RelayClient.State.CONNECTED), "CONNECTED over https with the given SSLSocketFactory");
        T.eq(1, fake.subscriberCount(topic, TV_UA), "start() twice -> one subscription");
        T.ok(h.sawState("CONNECTING", 0) && h.sawState("CONNECTED", 0), "onState: CONNECTING then CONNECTED");

        T.section("command -> handler once -> ack");
        String id = ctl.send("ping", tag("p1"));
        JSONObject ack = ctl.awaitAck(id, 5000);
        T.ok(ack != null, "ack received");
        if (ack != null) {
            T.ok("t2c".equals(ack.optString("dir")) && id.equals(ack.optString("re")) && ack.optBoolean("ok")
                    && ack.optInt("v") == 1 && ack.optInt("parts") == 1 && ack.optInt("part") == 0
                    && "Test TV".equals(ack.getJSONObject("data").optString("name"))
                    && Math.abs(ack.optLong("ts") - System.currentTimeMillis()) < 10000, "ack: v1 t2c, re matches, data, part 0/1");
        }
        T.sleep(300);
        T.eq(1, h.count("p1"), "handler called exactly once");
        T.ok(fake.requests().stream().anyMatch(r -> r.contains("POST /" + topic + "?firebase=no&cache=no 200 ua=OfficeTV")),
                "ack posted to /<topic>?firebase=no&cache=no");

        T.section("stale and replayed commands");
        long now = System.currentTimeMillis();
        ctl.publishRaw(ctl.seal(RelayClient.newId(), now - 301000, "ping", tag("old")));
        ctl.publishRaw(ctl.seal(RelayClient.newId(), now + 301000, "ping", tag("future")));
        String nearId = RelayClient.newId();
        ctl.publishRaw(ctl.seal(nearId, now - 280000, "ping", tag("near")));
        T.ok(ctl.awaitAck(nearId, 5000) != null, "ts 280 s old is still accepted");
        T.eq(0, h.count("old"), "ts 301 s old rejected");
        T.eq(0, h.count("future"), "ts 301 s in the future rejected");
        String rid = RelayClient.newId();
        String env = ctl.seal(rid, System.currentTimeMillis(), "ping", tag("replay"));
        ctl.publishRaw(env);
        T.ok(ctl.awaitAck(rid, 5000) != null, "original acked");
        ctl.publishRaw(env);
        ctl.publishRaw(env);
        T.sleep(600);
        T.eq(1, h.count("replay"), "replayed identical envelope rejected (handler once)");
        long nowSec = System.currentTimeMillis() / 1000;
        fake.publishAt(topic, ctl.seal(RelayClient.newId(), (nowSec - 400) * 1000, "ping", tag("late")), nowSec - 400);
        String lateOkId = RelayClient.newId();
        fake.publishAt(topic, ctl.seal(lateOkId, (nowSec - 200) * 1000, "ping", tag("late-ok")), nowSec - 200);
        T.ok(ctl.awaitAck(lateOkId, 5000) != null, "relay copy received 200 s ago (ts matches) accepted");
        T.eq(0, h.count("late"), "relay copy received 400 s ago rejected even though ts matches its time");
        T.eq(1, ctl.acksFor(rid).size(), "replay produced no second ack");

        T.section("foreign and garbage messages are ignored");
        int before = h.commands.size();
        long t0 = System.currentTimeMillis();
        TestController stranger = new TestController(fake.baseUrl(), "0000000000", sf);
        ctl.publishRaw("hello");
        ctl.publishRaw("otv1.abc.def");
        ctl.publishRaw("otv1." + RelayCrypto.b64url(new byte[12]) + "." + RelayCrypto.b64url(new byte[40]));
        ctl.publishRaw(stranger.seal(RelayClient.newId(), t0, "ping", tag("stranger")));
        ctl.publishRaw(ctl.crypto.seal(new JSONObject().put("v", 1).put("dir", "t2c").put("id", RelayClient.newId())
                .put("ts", t0).put("cmd", "ping").toString()));
        ctl.publishRaw(ctl.crypto.seal(new JSONObject().put("v", 1).put("dir", "c2t").put("ts", t0).put("cmd", "ping").toString()));
        ctl.publishRaw(ctl.crypto.seal(new JSONObject().put("v", 2).put("dir", "c2t").put("id", RelayClient.newId())
                .put("ts", t0).put("cmd", "ping").toString()));
        ctl.publishRaw(ctl.crypto.seal(new JSONObject().put("v", 1).put("dir", "c2t").put("id", RelayClient.newId())
                .put("ts", t0).toString()));
        ctl.publishRaw(ctl.crypto.seal("[1,2,3]"));
        ctl.publishRaw(ctl.crypto.seal("not json"));
        fake.injectRaw(topic, "this is not json");
        fake.injectRaw(topic, "{\"event\":\"message\"}");
        fake.injectRaw(topic, "{\"event\":\"message\",\"message\":123,\"time\":\"x\"}");
        fake.injectRaw(topic, "{\"event\":\"poll_request\",\"message\":\"x\"}");
        fake.injectRaw(topic, "[\"array\"]");
        StringBuilder big = new StringBuilder("{\"event\":\"message\",\"message\":\"");
        for (int i = 0; i < 100000; i++) big.append('x');
        fake.injectRaw(topic, big.append("\"}").toString());
        String okId = ctl.send("ping", tag("after-garbage"));
        T.ok(ctl.awaitAck(okId, 5000) != null, "valid command after garbage still acked");
        T.eq(before + 1, h.commands.size(), "no garbage/foreign/own-direction message reached the handler");
        String boomId = ctl.send("boom", tag("boom"));
        JSONObject boom = ctl.awaitAck(boomId, 5000);
        T.ok(boom != null && !boom.optBoolean("ok") && boom.optString("msg").contains("handler bug"),
                "a throwing handler gives ok=false ack, client keeps running");

        T.section("slow command does not block the reader");
        h.slow = new CountDownLatch(1);
        int acc0 = c.accepted.get();
        String slowId = ctl.send("slow", tag("slow"));
        T.waitFor(3000, () -> h.count("slow") == 1);
        String fastId = ctl.send("ping", tag("fast"));
        T.ok(T.waitFor(3000, () -> c.accepted.get() == acc0 + 2), "reader accepted the next command while one is running");
        T.eq(0, h.count("fast"), "second command waits its turn on the command thread");
        h.slow.countDown();
        T.ok(ctl.awaitAck(slowId, 5000) != null && ctl.awaitAck(fastId, 5000) != null, "both acked after the slow one finished");

        T.section("oversized ack -> one envelope < 3900 bytes");
        int sizes0 = ctl.ackSizes().size();
        String bigId = ctl.send("big", tag("big"));
        JSONObject bigAck = ctl.awaitAck(bigId, 5000);
        List<Integer> sizes = ctl.ackSizes().subList(sizes0, ctl.ackSizes().size());
        T.ok(bigAck != null && bigAck.optBoolean("ok") && bigAck.optInt("parts") == 1 && bigAck.getJSONObject("data").length() == 0
                && bigAck.optString("msg").startsWith("MMMM") && bigAck.optString("msg").length() < 10000,
                "big result: ok kept, data dropped, msg cut");
        T.ok(sizes.size() == 1 && sizes.get(0) < 3900, "exactly one ack envelope on the wire, < 3900 bytes " + sizes);

        T.section("stream drop -> reconnect with since= -> gap message delivered");
        c.backoffUnitMs = 500;
        int reqBefore = fake.requests().size();
        T.eq(1, fake.dropSubscribers(topic, TV_UA), "server closed the TV's stream");
        T.ok(T.waitFor(1000, () -> fake.subscriberCount(topic, TV_UA) == 0), "TV not subscribed during the gap");
        String gapId = ctl.send("ping", tag("gap"));
        T.eq(0, fake.subscriberCount(topic, TV_UA), "gap command published while the TV was disconnected");
        JSONObject gapAck = ctl.awaitAck(gapId, 8000);
        T.ok(gapAck != null, "gap command handled after reconnect");
        List<String> after = fake.requests().subList(reqBefore, fake.requests().size());
        String resub = null;
        for (String r : after) if (r.contains("GET /" + topic + "/json") && r.contains("ua=OfficeTV")) resub = r;
        T.ok(resub != null && resub.matches(".*/json\\?since=[0-9A-Za-z]+ 200.*"), "reconnected with ?since=<last id>: " + resub);
        c.backoffUnitMs = 100;
        T.eq(1, h.count("gap"), "gap command ran once");

        T.section("429 on subscribe -> RATE_LIMITED -> recovery");
        T.ok(T.waitFor(3000, () -> c.state() == RelayClient.State.CONNECTED), "connected before the 429 test");
        int st0 = h.states.size();
        int req0 = fake.requests().size();
        fake.fail429(2, "subscribe", TV_UA);
        fake.dropSubscribers(topic, TV_UA);
        T.ok(T.waitFor(3000, () -> c.state() == RelayClient.State.RATE_LIMITED), "state RATE_LIMITED after HTTP 429");
        T.ok(T.waitFor(8000, () -> c.state() == RelayClient.State.CONNECTED), "CONNECTED again after the limit clears");
        List<Long> tooMany = new ArrayList<>();
        long okAt = 0;
        for (String r : fake.requests().subList(req0, fake.requests().size())) {
            if (!r.contains("/json") || !r.contains("ua=OfficeTV")) continue;
            long at = Long.parseLong(r.substring(0, r.indexOf(' ')));
            if (r.contains(" 429 ")) tooMany.add(at);
            else if (okAt == 0 && r.contains(" 200 ")) okAt = at;
        }
        T.ok(tooMany.size() == 2 && okAt > 0, "two 429 answers then a 200");
        if (tooMany.size() == 2 && okAt > 0) {
            long w1 = tooMany.get(1) - tooMany.get(0);
            long w2 = okAt - tooMany.get(1);
            System.out.println("     waits after 429: " + w1 + " ms, " + w2 + " ms (min " + c.rateLimitMinMs + ")");
            T.ok(w1 >= 690 && w2 >= 1390, "waited at least the rate-limit minimum, growing");
        }
        T.ok(h.sawState("RATE_LIMITED", st0) && h.states.get(h.states.size() - 1).startsWith("CONNECTED"), "onState reported RATE_LIMITED then CONNECTED");
        String postId = ctl.send("ping", tag("after429"));
        T.ok(ctl.awaitAck(postId, 5000) != null, "commands work after recovery");

        T.section("429 on ack post -> RATE_LIMITED -> recovery");
        fake.fail429(1, "publish", TV_UA);
        String lostId = ctl.send("ping", tag("lost"));
        T.ok(T.waitFor(3000, () -> c.state() == RelayClient.State.RATE_LIMITED), "ack 429 -> RATE_LIMITED");
        T.eq(0, ctl.awaitAcks(lostId, 1, 500).size(), "that ack was not delivered");
        String nextId = ctl.send("ping", tag("next"));
        T.ok(ctl.awaitAck(nextId, 5000) != null && T.waitFor(2000, () -> c.state() == RelayClient.State.CONNECTED),
                "next ack delivered -> CONNECTED");

        T.section("stop()");
        Thread reader = c.readerThread();
        long s0 = System.nanoTime();
        c.stop();
        long stopMs = (System.nanoTime() - s0) / 1000000;
        T.ok(stopMs < 2000, "stop() returned in " + stopMs + " ms");
        reader.join(2000);
        long deadMs = (System.nanoTime() - s0) / 1000000;
        T.ok(!reader.isAlive(), "reader thread ended " + deadMs + " ms after stop() (stream blocked in read, keepalive 30 s)");
        T.eq(RelayClient.State.STOPPED, c.state(), "state STOPPED");
        T.ok(h.states.get(h.states.size() - 1).startsWith("STOPPED"), "onState STOPPED");
        c.stop();
        String afterStop = ctl.send("ping", tag("afterstop"));
        T.sleep(500);
        T.eq(0, h.count("afterstop"), "no commands run after stop()");
        c.start();
        T.ok(T.waitFor(5000, () -> c.state() == RelayClient.State.CONNECTED), "start() after stop() reconnects");
        String again = ctl.send("ping", tag("again"));
        T.ok(ctl.awaitAck(again, 5000) != null, "commands work after restart");
        T.ok(ctl.acksFor(afterStop).size() <= 1, "command sent while stopped ran at most once");
        c.stop();
        ctl.close();
        fake.close();
    }

    // ------------------------------------------------------------------ plain http (local test relay)

    static void httpSuite() throws Exception {
        T.section("http relay");
        FakeNtfy fake = FakeNtfy.start(0, false, 300);
        String code = Pairing.newCode(new SecureRandom());
        Recorder h = new Recorder();
        RelayClient c = new RelayClient(fake.baseUrl(), code, h, null);
        TestController ctl = new TestController(fake.baseUrl(), code, null);
        ctl.subscribe(5000);
        c.start();
        T.ok(T.waitFor(5000, () -> c.state() == RelayClient.State.CONNECTED), "CONNECTED over http");
        String id = ctl.send("ping", tag("h1"));
        T.ok(ctl.awaitAck(id, 5000) != null, "ping acked over http");

        Thread reader = c.readerThread();
        long s0 = System.nanoTime();
        c.stop();
        long stopMs = (System.nanoTime() - s0) / 1000000;
        T.ok(stopMs < 2000, "stop() returned in " + stopMs + " ms");
        reader.join(2000);
        T.ok(!reader.isAlive(), "reader ended within 2 s");
        ctl.close();
        fake.close();
    }

    // ------------------------------------------------------------------ relay down

    static void offlineSuite() throws Exception {
        T.section("relay down");
        int port;
        try (ServerSocket s = new ServerSocket(0)) {
            port = s.getLocalPort();
        }
        Recorder h = new Recorder();
        RelayClient c = new RelayClient("http://127.0.0.1:" + port, Pairing.newCode(new SecureRandom()), h, null);
        c.backoffUnitMs = 50;
        c.start();
        T.ok(T.waitFor(3000, () -> c.state() == RelayClient.State.OFFLINE), "connection refused -> OFFLINE");
        T.ok(T.waitFor(3000, () -> c.connects.get() >= 3), "keeps retrying with back-off");
        String detail = "";
        synchronized (h.states) {
            for (String s : h.states) if (s.startsWith("OFFLINE")) detail = s;
        }
        System.out.println("     " + detail);
        int k = c.connects.get();
        c.backoffUnitMs = 60000;
        T.waitFor(5000, () -> c.connects.get() > k);
        T.sleep(200); // now sleeping >= 60 s before the next attempt
        Thread reader = c.readerThread();
        long s0 = System.nanoTime();
        c.stop();
        reader.join(2000);
        T.ok(!reader.isAlive() && (System.nanoTime() - s0) / 1000000 < 2000, "stop() during a long back-off ends the reader at once");
        T.eq(RelayClient.State.STOPPED, c.state(), "state STOPPED");
    }
}
