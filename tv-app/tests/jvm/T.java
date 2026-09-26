package com.nikhil.officetv.relay;

import java.util.Objects;
import java.util.function.BooleanSupplier;

/** Minimal assertion helper for the JVM tests (no JUnit needed). */
final class T {
    private static int pass;
    private static int fail;

    private T() {}

    static void section(String name) {
        System.out.println("-- " + name);
    }

    static boolean ok(boolean cond, String name) {
        if (cond) {
            pass++;
            System.out.println("  ok   " + name);
        } else {
            fail++;
            System.out.println("  FAIL " + name);
        }
        return cond;
    }

    static boolean eq(Object expected, Object actual, String name) {
        boolean same = Objects.equals(expected, actual);
        return ok(same, same ? name : name + "  expected=" + expected + " actual=" + actual);
    }

    static void fail(String name, Throwable t) {
        fail++;
        System.out.println("  FAIL " + name + ": " + t);
        t.printStackTrace(System.out);
    }

    /** Polls until cond is true or the timeout passes. */
    static boolean waitFor(long timeoutMs, BooleanSupplier cond) {
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            if (cond.getAsBoolean()) return true;
            try {
                Thread.sleep(10);
            } catch (InterruptedException e) {
                return false;
            }
        }
        return cond.getAsBoolean();
    }

    static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    static byte[] unhex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    static int failures() {
        return fail;
    }

    /** Prints the summary and returns the process exit code. */
    static int finish(String suite) {
        System.out.println(suite + ": " + pass + " passed, " + fail + " failed");
        return fail == 0 ? 0 : 1;
    }
}
