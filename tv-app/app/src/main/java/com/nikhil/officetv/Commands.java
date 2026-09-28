package com.nikhil.officetv;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.nikhil.officetv.relay.RelayClient;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Runs the commands that arrive through the relay (PROTOCOL.md section 5). Office TV 3.0 is screen
 * sharing only, so there are two: "ping" (status) and "cast" (open or close the receiver). Every other
 * command, including the ones older apps had, gets ok=false with {@link #NOT_AVAILABLE}.
 */
final class Commands implements RelayClient.Handler {
    static final String NOT_AVAILABLE = "This feature is not available on this TV app version.";
    static final String NEEDS_SETUP = "The TV needs a one-time setup before it can show your screen: on the TV, "
            + "open Office TV and follow “Allow Office TV to open automatically”.";
    /** How long "cast start" waits for the receiver screen to appear before it answers. */
    private static final long OPEN_WAIT_MS = 4000;

    private final Context ctx;

    Commands(Context ctx) {
        this.ctx = ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
    }

    @Override
    public JSONObject onCommand(String cmd, JSONObject args) {
        if (args == null) args = new JSONObject();
        try {
            switch (cmd == null ? "" : cmd) {
                case "ping": return withData(Actions.result(true, "The TV is online."), status(ctx));
                case "cast": return cast(args);
                default: return Actions.result(false, NOT_AVAILABLE);
            }
        } catch (Throwable e) {
            // Never let a command take the relay client down; the laptop gets a message it can act on.
            CrashLog.note(ctx, "Relay command " + cmd + " failed: " + e);
            return Actions.result(false, "The TV could not do that right now. Please try again.");
        }
    }

    @Override
    public void onState(RelayClient.State state, String detail) {
        RelayManager.setState(state, detail);
    }

    /** Share my screen (PROTOCOL.md section 8): opens or closes the full-screen WebRTC receiver. */
    private JSONObject cast(JSONObject args) throws JSONException {
        String session = args.optString("session", "");
        if ("stop".equals(args.optString("action"))) {
            boolean was = CastActivity.stop(session);
            return Actions.result(true, was ? "Screen sharing stopped on the TV." : "Screen sharing was not running on the TV.");
        }
        if (!CastActivity.validSession(session)) {
            return Actions.result(false, "Invalid screen sharing session. Please reload the page and try again.");
        }
        // An engine that is known to be too old still gets the cast screen, which explains it on the TV too.
        String engine = WebViewInfo.problem(ctx);
        String url = CastActivity.receiverUrl(session, Prefs.pairCode(ctx), Prefs.relayUrl(ctx));
        Intent i = CastActivity.intent(ctx, url, session);
        CastActivity.expect(session);
        Actions.wake(ctx);
        try {
            ctx.startActivity(i);
        } catch (RuntimeException e) {
            CastActivity.cancelExpected(session);
            CrashLog.note(ctx, "Cast screen did not start: " + e);
            return Actions.result(false, "The TV could not open the screen sharing view. Please restart Office TV on the TV.");
        }
        if (engine != null) return Actions.result(false, engine);
        boolean opened = CastActivity.awaitOpened(session, OPEN_WAIT_MS);
        if (!opened && !Actions.canOpenFromBackground(ctx) && !OfficeTvApp.inForeground()) {
            // Android 10+ silently refuses screens from background apps without the one-time setup.
            CastActivity.cancelExpected(session);
            return Actions.result(false, NEEDS_SETUP);
        }
        if (!opened && !CastActivity.awaitOpened(session, OPEN_WAIT_MS)) {
            CastActivity.cancelExpected(session);
            return Actions.result(false, "The TV did not open the screen sharing view. Open Office TV on the TV once, "
                    + "then share again.");
        }
        return withData(Actions.result(true, "The TV is ready to show your screen."), status(ctx));
    }

    /** Status object (PROTOCOL.md section 5). */
    static JSONObject status(Context c) throws JSONException {
        JSONObject o = new JSONObject();
        String engine = WebViewInfo.version(c);
        o.put("name", Prefs.tvName(c));
        o.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        o.put("android", Build.VERSION.RELEASE);
        o.put("appVersion", BuildConfig.VERSION_NAME);
        o.put("flavor", BuildConfig.FLAVOR);
        o.put("features", new org.json.JSONArray().put("cast"));
        o.put("accessibility", Actions.accessibilityOn());
        o.put("needsPermission", !Actions.canOpenFromBackground(c));
        o.put("keepAwake", Prefs.keepAwake(c));
        o.put("webview", engine == null ? "" : engine);
        o.put("webviewOk", WebViewInfo.problem(c) == null);
        o.put("casting", !CastActivity.currentSession().isEmpty());
        return o;
    }

    private static JSONObject withData(JSONObject result, JSONObject data) throws JSONException {
        result.put("data", data);
        return result;
    }
}
