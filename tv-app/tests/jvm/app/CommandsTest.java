package com.nikhil.officetv;

import android.content.Context;
import android.content.ContextWrapper;

import org.json.JSONObject;

/**
 * The TV app's command contract (PROTOCOL.md sections 5 and 8) on a plain JVM: the app sources are compiled
 * against Robolectric's android-all jar by tests/jvm/run.sh. Only code paths that need no Android runtime
 * are exercised (Build, Log and system services are not available here); the emulator smoke test
 * (tv-app/ci/smoke.sh) covers the rest on real Android.
 */
public final class CommandsTest {
    private static int pass;
    private static int fail;

    private static void ok(boolean cond, String name) {
        if (cond) pass++;
        else fail++;
        System.out.println((cond ? "  ok   " : "  FAIL ") + name);
    }

    private static void eq(Object want, Object got, String name) {
        boolean same = want == null ? got == null : want.equals(got);
        ok(same, same ? name : name + "  expected=" + want + " actual=" + got);
    }

    public static void main(String[] args) throws Exception {
        Context ctx = new ContextWrapper(null) {
            @Override
            public Context getApplicationContext() {
                return this;
            }
        };
        Commands cmd = new Commands(ctx);

        System.out.println("-- removed features answer 'not available'");
        String[] removed = {"open", "youtube", "key", "volume", "app", "apps", "file", "screen", "awake", "rename",
            "upload", "unknown", "", "PING", "Cast"};
        for (String name : removed) {
            JSONObject r = cmd.onCommand(name, new JSONObject().put("url", "https://example.com").put("on", true));
            ok(!r.optBoolean("ok", true) && Commands.NOT_AVAILABLE.equals(r.optString("msg")),
                    "'" + name + "' -> ok=false \"" + r.optString("msg") + "\"");
        }
        JSONObject nul = cmd.onCommand(null, null);
        ok(!nul.optBoolean("ok", true) && Commands.NOT_AVAILABLE.equals(nul.optString("msg")), "null command and args");
        eq("This feature is not available on this TV app version.", Commands.NOT_AVAILABLE, "exact wording");

        System.out.println("-- cast: session validation");
        String[] bad = {"", "BAD", "abcdefabcde", "ABCDEFABCDEF12", "abcdefabcdefabcdefabcdefabcdefabc", "abc-def-ghi-jk",
            "abcdefabcdef12 ", "../../etc/passwd"};
        for (String s : bad) {
            JSONObject r = cmd.onCommand("cast", new JSONObject().put("action", "start").put("session", s));
            ok(!r.optBoolean("ok", true) && r.optString("msg").startsWith("Invalid screen sharing session"),
                    "start with session \"" + s + "\" refused");
        }
        JSONObject noSession = cmd.onCommand("cast", new JSONObject().put("action", "start"));
        ok(!noSession.optBoolean("ok", true), "start without a session refused");
        ok(CastActivity.validSession("abcdefabcdef") && CastActivity.validSession("abcdefabcdefabcdefabcdefabcdefab")
                && !CastActivity.validSession(null), "12 and 32 chars valid, null invalid (same rule as tv/cast.js)");

        System.out.println("-- cast: stop");
        JSONObject idle = cmd.onCommand("cast", new JSONObject().put("action", "stop").put("session", "abcdefabcdef12"));
        ok(idle.optBoolean("ok") && "Screen sharing was not running on the TV.".equals(idle.optString("msg")),
                "stop while idle -> ok, \"" + idle.optString("msg") + "\"");
        JSONObject any = cmd.onCommand("cast", new JSONObject().put("action", "stop"));
        ok(any.optBoolean("ok"), "stop without a session while idle -> ok");
        CastActivity.expect("pendingsession01");
        JSONObject early = cmd.onCommand("cast", new JSONObject().put("action", "stop").put("session", "pendingsession01"));
        ok(early.optBoolean("ok") && "Screen sharing stopped on the TV.".equals(early.optString("msg")),
                "stop before the screen opened -> ok, remembered as cancelled");
        long t0 = System.currentTimeMillis();
        ok(!CastActivity.awaitOpened("pendingsession01", 150) && System.currentTimeMillis() - t0 >= 140,
                "awaitOpened times out when the screen never opens");
        eq("", CastActivity.currentSession(), "no session on screen");

        System.out.println("-- receiver URL (must match tv/cast.js receiverUrl)");
        String base = "https://nikhildiwakar-bit.github.io/Portfolio/tv/receive.html#s=abcdefabcdef12&code=7K3M9QX2TD";
        eq(base, CastActivity.receiverUrl("abcdefabcdef12", "7K3M9QX2TD", "https://ntfy.sh"), "default relay omitted");
        eq(base, CastActivity.receiverUrl("abcdefabcdef12", "7K3M9QX2TD", "https://ntfy.sh/"), "default relay with / omitted");
        eq(base, CastActivity.receiverUrl("abcdefabcdef12", "7K3M9QX2TD", null), "null relay omitted");
        eq(base + "&relay=https%3A%2F%2Frelay.example.com%2Fntfy",
                CastActivity.receiverUrl("abcdefabcdef12", "7K3M9QX2TD", "https://relay.example.com/ntfy"), "custom relay encoded");
        ok(base.startsWith(CastActivity.RECEIVER_URL + "#"), "fixed receiver page on the website");

        System.out.println("-- web engine version checks");
        eq(83, WebViewInfo.major("83.0.4103.106"), "major(83.0.4103.106)");
        eq(-1, WebViewInfo.major(null), "major(null)");
        eq(-1, WebViewInfo.major("beta"), "major(beta)");
        String ua = "Mozilla/5.0 (Linux; Android 11; t982_ar301 Build/RP1A.200720.011; wv) AppleWebKit/537.36 "
                + "(KHTML, like Gecko) Version/4.0 Chrome/83.0.4103.106 Safari/537.36";
        eq(83, WebViewInfo.majorFromUserAgent(ua), "major from a WebView user agent");
        eq(-1, WebViewInfo.majorFromUserAgent("Mozilla/5.0 (X11; Linux x86_64)"), "no Chrome/ in user agent");
        ok(WebViewInfo.tooOld(71) && !WebViewInfo.tooOld(WebViewInfo.MIN_MAJOR) && !WebViewInfo.tooOld(-1),
                "tooOld: below " + WebViewInfo.MIN_MAJOR + " only; unknown is not too old");
        String old = WebViewInfo.tooOldMessage(66);
        ok(old.contains("66") && old.contains("Android System WebView") && old.contains("update"),
                "old-engine message names the version and what to update");

        System.out.println("-- messages");
        ok(Commands.NEEDS_SETUP.contains("open Office TV") && Commands.NEEDS_SETUP.contains("Allow Office TV to open automatically"),
                "setup message tells the user what to do on the TV");
        JSONObject r = Actions.result(true, "x");
        ok(r.optBoolean("ok") && "x".equals(r.optString("msg")) && r.length() == 2, "Actions.result shape {ok,msg}");

        System.out.println("CommandsTest: " + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
