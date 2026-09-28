package com.nikhil.officetv;

import android.content.Context;

/**
 * Release builds: no test server and no test log lines. The debug build's version of this class
 * (src/debug) adds a loopback-only HTTP API and "OTV_TEST" log lines for the emulator smoke test.
 */
final class DebugHooks {
    private DebugHooks() {}

    static void start(Context c) {}

    static void stop() {}

    static void event(String what) {}
}
