package com.nikhil.officetv.relay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Canonical vectors (tests/vectors.json) plus pure unit tests of Pairing, RelayCrypto and ack building. */
public final class VectorsTest {
    public static void main(String[] args) throws Exception {
        String path = args.length > 0 ? args[0] : "tests/vectors.json";
        JSONObject v = new JSONObject(new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8));
        try {
            vectors(v);
            base64();
            pairing();
            freshness();
            acks(v.getString("code"));
        } catch (Throwable t) {
            T.fail("unexpected exception", t);
        }
        System.exit(T.finish("VectorsTest"));
    }

    static void vectors(JSONObject v) throws Exception {
        T.section("vectors.json");
        String code = v.getString("code");
        JSONArray norm = v.getJSONArray("normalize");
        for (int i = 0; i < norm.length(); i++) {
            JSONObject c = norm.getJSONObject(i);
            String expected = c.isNull("output") ? null : c.getString("output");
            T.eq(expected, Pairing.normalize(c.getString("input")), "normalize(\"" + c.getString("input") + "\")");
        }
        T.eq(v.getString("displayCode"), Pairing.display(code), "display");
        T.eq(v.getString("topic"), Pairing.topic(code), "topic");
        T.eq(v.getString("keyHex"), T.hex(Pairing.key(code)), "key hex");

        RelayCrypto rc = new RelayCrypto(code);
        T.eq(v.getString("topic"), rc.topic(), "RelayCrypto.topic");
        JSONObject m = v.getJSONObject("message");
        String envelope = m.getString("envelope");
        byte[] iv = T.unhex(m.getString("ivHex"));
        T.eq(envelope, rc.sealWithIv(m.getString("plaintext"), iv), "sealWithIv == vector envelope");
        T.eq(m.getString("plaintext"), rc.open(envelope), "open(vector envelope)");
        T.eq(m.getString("plaintext"), rc.open(rc.seal(m.getString("plaintext"))), "seal/open round trip");
        T.ok(!rc.seal("x").equals(rc.seal("x")), "seal uses a random IV");
        T.eq(RelayCrypto.envelopeLength(m.getString("plaintext").getBytes(StandardCharsets.UTF_8).length),
                envelope.length(), "envelopeLength formula");

        JSONObject f = v.getJSONObject("file");
        byte[] fileIv = T.unhex(f.getString("ivHex"));
        byte[] fileCt = RelayCrypto.unb64url(f.getString("ciphertextB64u"));
        T.eq(f.getString("plaintextHex"), T.hex(rc.openFile(fileCt, fileIv)), "openFile(vector)");
        T.eq(f.getString("ciphertextB64u"), RelayCrypto.b64url(rc.sealFile(T.unhex(f.getString("plaintextHex")), fileIv)),
                "sealFile == vector ciphertext");
        T.eq(f.getString("aad"), rc.topic() + ":file", "file AAD");

        T.section("tampering");
        int dot = envelope.lastIndexOf('.');
        int mid = dot + (envelope.length() - dot) / 2;
        char ch = envelope.charAt(mid);
        String tampered = envelope.substring(0, mid) + (ch == 'A' ? 'B' : 'A') + envelope.substring(mid + 1);
        T.eq(null, rc.open(tampered), "tampered ciphertext -> null");
        String badIv = "otv1.AAECAwQFBgcICQoM" + envelope.substring(envelope.indexOf('.', 5));
        T.eq(null, rc.open(badIv), "tampered IV -> null");
        T.eq(null, rc.open(envelope.substring(0, envelope.length() - 4)), "truncated -> null");
        T.eq(null, rc.open(envelope + "AAAA"), "extended -> null");
        T.eq(null, rc.open("otv2" + envelope.substring(4)), "other version prefix -> null");
        T.eq(null, rc.open(envelope.replace("otv1.", "")), "no prefix -> null");
        T.eq(null, rc.open("otv1." + RelayCrypto.b64url(iv) + "."), "empty ciphertext -> null");
        T.eq(null, rc.open("otv1.%%%.***"), "garbage -> null");
        T.eq(null, rc.open("otv1.a.b.c"), "too many parts -> null");
        T.eq(null, rc.open(null), "null -> null");
        T.eq(null, rc.open(""), "empty -> null");
        T.eq(null, new RelayCrypto("0000000000").open(envelope), "other code -> null");
        T.eq(m.getString("plaintext"), rc.open(envelope + "=="), "padded ciphertext part still opens");

        // Same key, AAD of another topic.
        String otherTopic = Pairing.topic("0000000000");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(Pairing.key(code), "AES"), new GCMParameterSpec(128, iv));
        c.updateAAD(otherTopic.getBytes(StandardCharsets.UTF_8));
        byte[] ct = c.doFinal(m.getString("plaintext").getBytes(StandardCharsets.UTF_8));
        T.eq(null, rc.open("otv1." + RelayCrypto.b64url(iv) + "." + RelayCrypto.b64url(ct)), "wrong-topic AAD -> null");

        boolean threw = false;
        try {
            rc.openFile(RelayCrypto.unb64url(envelope.substring(dot + 1)), iv);
        } catch (AEADBadTagException e) {
            threw = true;
        }
        T.ok(threw, "openFile with message AAD -> AEADBadTagException");
        byte[] flipped = fileCt.clone();
        flipped[3] ^= 1;
        threw = false;
        try {
            rc.openFile(flipped, fileIv);
        } catch (GeneralSecurityException e) {
            threw = true;
        }
        T.ok(threw, "tampered file -> GeneralSecurityException");
        threw = false;
        try {
            rc.openFile(new byte[5], fileIv);
        } catch (GeneralSecurityException e) {
            threw = true;
        }
        T.ok(threw, "short file -> GeneralSecurityException");
    }

    static void base64() {
        T.section("base64url");
        Random r = new Random(42);
        boolean allEnc = true;
        boolean allDec = true;
        for (int n = 0; n <= 64; n++) {
            byte[] b = new byte[n];
            r.nextBytes(b);
            String mine = RelayCrypto.b64url(b);
            String jdk = Base64.getUrlEncoder().withoutPadding().encodeToString(b);
            allEnc &= mine.equals(jdk);
            String padded = Base64.getUrlEncoder().encodeToString(b);
            allDec &= java.util.Arrays.equals(b, RelayCrypto.unb64url(jdk))
                    && java.util.Arrays.equals(b, RelayCrypto.unb64url(padded));
        }
        T.ok(allEnc, "b64url matches JDK url encoder without padding (0..64 bytes)");
        T.ok(allDec, "unb64url accepts with and without padding (0..64 bytes)");
        T.eq("AAECAwQFBgcICQoL", RelayCrypto.b64url(T.unhex("000102030405060708090a0b")), "b64url(vector iv)");
        T.eq("ff", T.hex(RelayCrypto.unb64url("_w")), "unb64url(\"_w\")");
        T.eq("ff", T.hex(RelayCrypto.unb64url("_w==")), "unb64url(\"_w==\")");
        T.eq("fbff", T.hex(RelayCrypto.unb64url("-_8")), "unb64url(\"-_8\")");
        T.eq("", T.hex(RelayCrypto.unb64url("")), "unb64url(\"\")");
        for (String bad : new String[] {"A", "AAAAA", "ab+/", "ab c", "abéd", "a=bc", "*"}) {
            boolean threw = false;
            try {
                RelayCrypto.unb64url(bad);
            } catch (IllegalArgumentException e) {
                threw = true;
            }
            T.ok(threw, "unb64url(\"" + bad + "\") throws IllegalArgumentException");
        }
    }

    static void pairing() throws Exception {
        T.section("pairing");
        SecureRandom sr = new SecureRandom();
        Set<String> codes = new HashSet<>();
        boolean valid = true;
        for (int i = 0; i < 2000; i++) {
            String c = Pairing.newCode(sr);
            valid &= c.length() == 10 && c.equals(Pairing.normalize(c));
            for (char ch : c.toCharArray()) valid &= Pairing.ALPHABET.indexOf(ch) >= 0;
            codes.add(c);
        }
        T.ok(valid, "newCode: 10 chars from ALPHABET, already normalized");
        T.ok(codes.size() == 2000, "newCode: 2000 codes, no repeats");
        T.eq("7K3M9QX2TD", Pairing.normalize("7k3m9–qx2td"), "normalize: en dash");
        T.eq("7K3M9QX2TD", Pairing.normalize("\t7K3M9 QX2TD\n"), "normalize: tab, nbsp, newline");
        T.eq("0000011111", Pairing.normalize("ooOOo-iIlLl"), "normalize: O->0, I/L->1");
        T.eq(null, Pairing.normalize("7K3M9QX2TD1"), "normalize: 11 chars -> null");
        T.eq(null, Pairing.normalize(""), "normalize: empty -> null");
        T.eq(null, Pairing.normalize(null), "normalize: null -> null");
        T.eq(null, Pairing.normalize("7K3M9_QX2TD"), "normalize: underscore -> null");
        T.eq(Pairing.topic("7K3M9QX2TD"), Pairing.topic("7k3m9-qx2td"), "topic normalizes its input");
        T.eq("", Pairing.display(null), "display(null) -> \"\"");
        T.eq("", Pairing.display("bad"), "display(invalid) -> \"\"");
        T.eq("7K3M9-QX2TD", Pairing.display("7k3m9qx2td"), "display normalizes");

        String base = Pairing.CONTROLLER_URL + "#pair=7K3M9QX2TD";
        T.eq(base + "&name=Conference%20Dahua", Pairing.pairUrl("7K3M9QX2TD", "Conference Dahua", null),
                "pairUrl: default relay (null) omitted, space as %20");
        T.eq(base + "&name=A", Pairing.pairUrl("7k3m9-qx2td", "A", "https://ntfy.sh/"), "pairUrl: https://ntfy.sh/ omitted");
        T.eq(base + "&name=A", Pairing.pairUrl("7K3M9QX2TD", "A", "HTTPS://NTFY.SH"), "pairUrl: default relay any case");
        T.eq(base, Pairing.pairUrl("7K3M9QX2TD", "", ""), "pairUrl: empty name and relay omitted");
        T.eq(base + "&name=A&relay=https%3A%2F%2Frelay.example.com%2Fntfy",
                Pairing.pairUrl("7K3M9QX2TD", "A", "https://relay.example.com/ntfy"), "pairUrl: custom relay encoded");
        String hindi = "मीटिंग रूम & TV #2";
        String url = Pairing.pairUrl("7K3M9QX2TD", hindi, null);
        String enc = url.substring(url.indexOf("&name=") + 6);
        T.ok(enc.matches("[A-Za-z0-9%._~-]+"), "pairUrl: name is fully percent-encoded");
        T.eq(hindi, URLDecoder.decode(enc, "UTF-8"), "pairUrl: name decodes back");
        T.eq("https://ntfy.sh", RelayClient.normalizeRelay(null), "normalizeRelay(null)");
        T.eq("https://ntfy.sh", RelayClient.normalizeRelay("ntfy.sh/"), "normalizeRelay adds https, strips /");
        T.eq("http://127.0.0.1:8080/x", RelayClient.normalizeRelay(" http://127.0.0.1:8080/x// "), "normalizeRelay keeps http + path");
    }

    static void freshness() {
        T.section("isFresh");
        long t = 1760000000L;
        long now = 1760000123456L;
        T.ok(RelayClient.isFresh(t * 1000, t, now), "same second");
        T.ok(RelayClient.isFresh((t + 300) * 1000, t, now), "+300 s fresh");
        T.ok(!RelayClient.isFresh((t + 300) * 1000 + 1, t, now), "+300.001 s stale");
        T.ok(RelayClient.isFresh((t - 300) * 1000, t, now), "-300 s fresh");
        T.ok(!RelayClient.isFresh((t - 300) * 1000 - 1, t, now), "-300.001 s stale");
        T.ok(RelayClient.isFresh(t * 1000, t, 0), "server time wins over a wrong TV clock");
        T.ok(RelayClient.isFresh(now + 300000, 0, now), "serverTime 0: +300 s vs TV clock fresh");
        T.ok(!RelayClient.isFresh(now + 300001, 0, now), "serverTime 0: +300.001 s stale");
        T.ok(RelayClient.isFresh(now - 300000, 0, now), "serverTime 0: -300 s fresh");
        T.ok(!RelayClient.isFresh(now - 300001, 0, now), "serverTime 0: -300.001 s stale");
        T.ok(!RelayClient.isFresh(0, t, now), "ts 0 stale");
        T.ok(!RelayClient.isFresh(-5, 0, 0), "negative ts stale");
        T.ok(!RelayClient.isFresh(Long.MAX_VALUE, t, now), "huge ts stale");
    }

    static void acks(String code) throws Exception {
        T.section("ack building and apps chunking");
        RelayCrypto rc = new RelayCrypto(code);
        long now = System.currentTimeMillis();

        JSONObject small = new JSONObject().put("ok", true).put("msg", "Link TV par khul gaya.");
        List<String> one = RelayClient.buildAcks(rc, "abc123", small, now);
        JSONObject a = new JSONObject(rc.open(one.get(0)));
        T.ok(one.size() == 1 && a.getInt("v") == 1 && "t2c".equals(a.getString("dir")) && "abc123".equals(a.getString("re"))
                && a.getBoolean("ok") && "Link TV par khul gaya.".equals(a.getString("msg")) && a.getInt("part") == 0
                && a.getInt("parts") == 1 && a.getLong("ts") == now && a.getJSONObject("data").length() == 0
                && a.getString("id").matches("[0-9a-z]{12}"), "small ack: one envelope with all fields");

        JSONObject status = new JSONObject().put("name", "Conference Dahua").put("volume", 6);
        JSONObject withData = new JSONObject().put("ok", false).put("msg", "x").put("data", status);
        JSONObject b = new JSONObject(rc.open(RelayClient.buildAcks(rc, "r", withData, now).get(0)));
        T.ok(!b.getBoolean("ok") && "Conference Dahua".equals(b.getJSONObject("data").getString("name")), "ack keeps ok=false and data");

        // 300 apps with long, partly non-ASCII labels.
        JSONArray apps = new JSONArray();
        for (int i = 0; i < 300; i++) {
            String label = "Office App " + i + " ऑफिस टीवी very long label for testing/"
                    + "chunking " + "x".repeat(i % 50);
            apps.put(new JSONObject().put("label", label).put("pkg", "com.example.vendor.product.app" + i));
        }
        JSONObject res = new JSONObject().put("ok", true).put("msg", "300 apps mili.")
                .put("data", new JSONObject().put("apps", apps).put("count", 300));
        List<String> parts = RelayClient.buildAcks(rc, "apps01", res, now);
        int max = 0;
        boolean fields = true;
        Set<String> ids = new HashSet<>();
        List<String> got = new ArrayList<>();
        for (int i = 0; i < parts.size(); i++) {
            String env = parts.get(i);
            max = Math.max(max, env.getBytes(StandardCharsets.UTF_8).length);
            JSONObject p = new JSONObject(rc.open(env));
            fields &= p.getInt("part") == i && p.getInt("parts") == parts.size() && "apps01".equals(p.getString("re"))
                    && "t2c".equals(p.getString("dir")) && p.getBoolean("ok") && "300 apps mili.".equals(p.getString("msg"))
                    && p.getJSONObject("data").getInt("count") == 300;
            ids.add(p.getString("id"));
            JSONArray chunk = p.getJSONObject("data").getJSONArray("apps");
            for (int k = 0; k < chunk.length(); k++) {
                got.add(chunk.getJSONObject(k).getString("label") + "|" + chunk.getJSONObject(k).getString("pkg"));
            }
        }
        List<String> want = new ArrayList<>();
        for (int i = 0; i < apps.length(); i++) {
            want.add(apps.getJSONObject(i).getString("label") + "|" + apps.getJSONObject(i).getString("pkg"));
        }
        System.out.println("     300 apps -> " + parts.size() + " parts, largest envelope " + max + " bytes");
        T.ok(parts.size() > 1, "300 apps are split into several parts");
        T.ok(max < RelayClient.MAX_ENVELOPE, "every apps envelope < 3900 bytes");
        T.ok(fields, "every part has part/parts/re/dir/ok/msg and the other data keys");
        T.ok(ids.size() == parts.size(), "every part has its own id");
        T.eq(want, got, "parts reassemble to the same app list, same order");

        // One absurdly long label is shortened, not lost.
        JSONArray huge = new JSONArray().put(new JSONObject().put("label", "L".repeat(8000)).put("pkg", "com.big"))
                .put(new JSONObject().put("label", "Small").put("pkg", "com.small"));
        List<String> hp = RelayClient.buildAcks(rc, "h", new JSONObject().put("ok", true).put("msg", "")
                .put("data", new JSONObject().put("apps", huge)), now);
        List<String> pk = new ArrayList<>();
        boolean fits = true;
        for (String env : hp) {
            fits &= env.length() < RelayClient.MAX_ENVELOPE;
            JSONArray arr = new JSONObject(rc.open(env)).getJSONObject("data").getJSONArray("apps");
            for (int k = 0; k < arr.length(); k++) pk.add(arr.getJSONObject(k).getString("pkg"));
        }
        T.ok(fits && pk.contains("com.big") && pk.contains("com.small"), "an 8000-char label is shortened and kept");

        // Oversized non-apps ack: data dropped, msg cut, ok kept.
        for (boolean ok : new boolean[] {true, false}) {
            JSONObject big = new JSONObject().put("ok", ok).put("msg", "M".repeat(10000))
                    .put("data", new JSONObject().put("blob", "b".repeat(5000)));
            List<String> bl = RelayClient.buildAcks(rc, "big", big, now);
            JSONObject p = new JSONObject(rc.open(bl.get(0)));
            T.ok(bl.size() == 1 && bl.get(0).length() < RelayClient.MAX_ENVELOPE && p.getBoolean("ok") == ok
                    && p.getJSONObject("data").length() == 0 && p.getString("msg").startsWith("MMMM")
                    && p.getString("msg").length() < 10000, "oversized ack (ok=" + ok + "): truncated to one envelope");
        }
        JSONObject nullMsg = new JSONObject().put("ok", true).put("msg", JSONObject.NULL);
        T.eq("", new JSONObject(rc.open(RelayClient.buildAcks(rc, "n", nullMsg, now).get(0))).getString("msg"), "msg null -> \"\"");
    }
}
