package com.nikhil.officetv.relay;

import org.json.JSONObject;

import java.io.IOException;
import java.security.SecureRandom;

/**
 * CI check against the real https://ntfy.sh: a RelayClient with a random code, and this process as the
 * controller sending "ping". Exit 0 = ack within 45 s, 1 = failure, 2 = no network or HTTP 429 (warning).
 */
public final class RelayLiveTest {
    public static void main(String[] args) {
        String relay = args.length > 0 ? args[0] : Pairing.DEFAULT_RELAY;
        long deadline = System.currentTimeMillis() + 45000;
        String code = Pairing.newCode(new SecureRandom());
        final String[] lastState = {""};
        RelayClient c = new RelayClient(relay, code, new RelayClient.Handler() {
            @Override
            public JSONObject onCommand(String cmd, JSONObject a) {
                System.out.println("TV got command: " + cmd);
                JSONObject r = new JSONObject();
                r.put("ok", true);
                r.put("msg", "TV online hai.");
                r.put("data", E2EHarness.status());
                return r;
            }

            @Override
            public void onState(RelayClient.State state, String detail) {
                lastState[0] = state + " " + detail;
                System.out.println("TV state: " + lastState[0]);
            }
        }, null);
        TestController ctl = new TestController(relay, code, null);
        int exit;
        try {
            exit = run(c, ctl, deadline);
        } catch (Throwable t) {
            System.out.println("FAIL: " + t);
            exit = 1;
        } finally {
            c.stop();
            ctl.close();
        }
        System.out.println(exit == 0 ? "PASS" : exit == 2 ? "SKIP (network/limit)" : "FAIL");
        System.exit(exit);
    }

    private static int run(RelayClient c, TestController ctl, long deadline) throws Exception {
        System.out.println("topic " + c.topic() + " on " + c.relayUrl());
        try {
            ctl.subscribe(15000);
        } catch (IOException e) {
            System.out.println("controller could not subscribe: " + e.getMessage());
            return 2;
        }
        c.start();
        while (c.state() != RelayClient.State.CONNECTED && System.currentTimeMillis() < deadline - 15000) {
            if (c.state() == RelayClient.State.RATE_LIMITED) return 2;
            T.sleep(100);
        }
        if (c.state() != RelayClient.State.CONNECTED) {
            System.out.println("TV did not connect: " + c.state());
            return c.state() == RelayClient.State.RATE_LIMITED ? 2 : 1;
        }
        String id;
        try {
            id = ctl.send("ping", new JSONObject());
        } catch (IOException e) {
            System.out.println("publish failed: " + e.getMessage());
            return e.getMessage() != null && e.getMessage().contains("429") ? 2 : 1;
        }
        JSONObject ack = ctl.awaitAck(id, Math.max(1000, deadline - System.currentTimeMillis()));
        if (ack == null) {
            if (c.state() == RelayClient.State.RATE_LIMITED) return 2;
            System.out.println("no ack within 45 s; TV state " + c.state());
            return 1;
        }
        System.out.println("ack: " + ack);
        boolean good = ack.optBoolean("ok") && "t2c".equals(ack.optString("dir")) && id.equals(ack.optString("re"))
                && ack.optJSONObject("data") != null;
        return good ? 0 : 1;
    }
}
