package com.nikhil.officetv;

import android.annotation.TargetApi;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;

import com.nikhil.officetv.mirror.MirrorProtocol;

import java.util.ArrayDeque;

/**
 * TV side of phone sound (PROTOCOL.md section 10): plays the phone's PCM (AUDIO messages) with an AudioTrack.
 * Tuned for latency, like the video: playback starts once about 30 ms is waiting; more than about 150 ms waiting
 * means the TV is behind, so the oldest sound is dropped down to about 60 ms. The socket reader only queues
 * (offer never blocks); the blocking AudioTrack writes happen on the player's own thread.
 * Never throws into the caller: a TV that cannot play the sound simply shows the video without it.
 */
final class PhoneAudioPlayer {
    private static final int START_MS = 30;
    private static final int MAX_MS = 150;
    private static final int TRIM_MS = 60;
    /** Queued sound that never went below this for a whole second is a leftover backlog: drop down to DRAIN_TO_MS. */
    private static final int DRAIN_ABOVE_MS = 40;
    private static final int DRAIN_TO_MS = 15;
    private static final long DRAIN_WINDOW_MS = 1000;
    /** AudioTrack buffer: this much, or the device minimum if that is larger. */
    private static final int TRACK_MS = 40;
    private static final long LOG_MS = 5000;
    private static final long JOIN_MS = 300;
    /** A track that fails (e.g. the TV's sound output changed) is created again at most this often. */
    private static final int MAX_RESTARTS = 3;

    private final Context app;
    private final MirrorProtocol.AudioConfig config;
    private final int startBytes, maxBytes, trimBytes, drainAboveBytes, drainToBytes;
    private final ArrayDeque<byte[]> queue = new ArrayDeque<>();
    private final Thread thread;
    // Guarded by this.
    private int queuedBytes, chunks, dropped;
    private boolean released, failed;
    /** The track the player thread writes to, so release() can wake a blocking write. */
    private AudioTrack track;
    // Player thread only.
    private int trackBytes, underrunsBefore, starves, rmsCount;
    private double rmsSum;
    private boolean announced;
    private long nextLog;
    /** Lowest queue level in the current drain window (player thread; read and trimmed under this). */
    private int lowest = Integer.MAX_VALUE;
    private long windowEnd;

    private PhoneAudioPlayer(Context c, MirrorProtocol.AudioConfig config) {
        app = c;
        this.config = config;
        startBytes = config.bytesFor(START_MS);
        maxBytes = config.bytesFor(MAX_MS);
        trimBytes = config.bytesFor(TRIM_MS);
        drainAboveBytes = config.bytesFor(DRAIN_ABOVE_MS);
        drainToBytes = config.bytesFor(DRAIN_TO_MS);
        thread = new Thread(this::run, "otv-phone-audio");
        thread.setDaemon(true);
    }

    /** A player for the phone's format; its thread creates the AudioTrack (so this returns at once). */
    static PhoneAudioPlayer start(Context c, MirrorProtocol.AudioConfig config) {
        PhoneAudioPlayer p = new PhoneAudioPlayer(c, config);
        p.thread.start();
        return p;
    }

    /** Queues one chunk of PCM (16-bit little-endian, interleaved). Called by the socket reader; never blocks. */
    void offer(byte[] pcm) {
        if (pcm == null) return;
        int len = pcm.length - pcm.length % config.frameBytes();
        if (len <= 0) return;
        if (len != pcm.length) {
            byte[] whole = new byte[len];
            System.arraycopy(pcm, 0, whole, 0, len);
            pcm = whole;
        }
        synchronized (this) {
            if (released || failed) return;
            chunks++;
            if (len > maxBytes) {
                dropped++;
                return;
            }
            queue.add(pcm);
            queuedBytes += len;
            if (queuedBytes > maxBytes) {
                // Behind (a burst after a network hiccup, or the TV plays slower than the phone records): the
                // oldest sound is late anyway.
                while (queuedBytes > trimBytes && queue.size() > 1) {
                    queuedBytes -= queue.poll().length;
                    dropped++;
                }
            }
            notifyAll();
        }
    }

    /**
     * Stops the sound and frees the AudioTrack. Idempotent, any thread. Never blocks the main thread: there the
     * wake-up and the wait (at most about 300 ms) run on a short-lived thread, because AudioTrack.pause() itself
     * can wait while the TV's audio service restarts.
     */
    void release() {
        final AudioTrack t;
        synchronized (this) {
            if (released) return;
            released = true;
            queue.clear();
            queuedBytes = 0;
            notifyAll();
            t = track;
        }
        if (Thread.currentThread() == thread) return;
        Runnable stop = () -> {
            if (t != null) {
                try {
                    t.pause(); // wakes a write() that waits for room in the track
                } catch (RuntimeException ignored) {
                    // Already released by the player thread.
                }
            }
            try {
                thread.join(JOIN_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) {
            Thread h = new Thread(stop, "otv-phone-audio-stop");
            h.setDaemon(true);
            h.start();
        } else {
            stop.run();
        }
    }

    // ---------- player thread ----------

    private void run() {
        try {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        } catch (RuntimeException ignored) {
            // Normal priority still plays.
        }
        try {
            for (int attempt = 0; attempt <= MAX_RESTARTS; attempt++) {
                AudioTrack t = open();
                if (t == null) break;
                boolean again;
                try {
                    again = play(t);
                } finally {
                    close(t);
                }
                if (!again) break;
            }
        } catch (Throwable e) {
            CrashLog.note(app, "Phone sound: " + e);
        }
        synchronized (this) {
            // Nothing plays any more: offer() drops at once.
            failed = true;
            queue.clear();
            queuedBytes = 0;
        }
    }

    /** A new AudioTrack for the phone's format, or null (noted) if this TV cannot make one or release() came. */
    private AudioTrack open() {
        synchronized (this) {
            if (released) return null;
        }
        AudioTrack t = null;
        try {
            t = create();
            if (t.getState() != AudioTrack.STATE_INITIALIZED) {
                throw new IllegalStateException("AudioTrack not initialized");
            }
        } catch (RuntimeException e) {
            CrashLog.note(app, "Phone sound: " + config.sampleRate + " Hz " + config.channels + " ch: " + e);
            releaseQuietly(t);
            return null;
        }
        synchronized (this) {
            if (!released) {
                track = t;
                return t;
            }
        }
        releaseQuietly(t);
        return null;
    }

    private AudioTrack create() {
        int mask = config.channels == 1 ? AudioFormat.CHANNEL_OUT_MONO : AudioFormat.CHANNEL_OUT_STEREO;
        int min = AudioTrack.getMinBufferSize(config.sampleRate, mask, AudioFormat.ENCODING_PCM_16BIT);
        int size = Math.max(min, config.bytesFor(TRACK_MS));
        size -= size % config.frameBytes();
        trackBytes = size;
        AudioAttributes.Builder ab = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE);
        if (Build.VERSION.SDK_INT >= 29) noCapture(ab);
        AudioAttributes attrs = ab.build();
        AudioFormat format = new AudioFormat.Builder()
                .setSampleRate(config.sampleRate)
                .setChannelMask(mask)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .build();
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                return lowLatency(attrs, format, size);
            } catch (RuntimeException e) {
                // Some TVs refuse the low-latency path: a normal track still plays.
            }
        }
        return new AudioTrack(attrs, format, size, AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE);
    }

    /**
     * Writes the queued sound to the track until release(). Returns true if the track failed and a new one
     * may help (e.g. the TV's sound output changed), false after release().
     */
    private boolean play(AudioTrack t) {
        int room = trackBytes;
        if (Build.VERSION.SDK_INT >= 24) {
            int frames = bufferFrames(t);
            if (frames > 0) room = frames * config.frameBytes();
        }
        long roomMs = (long) room * 1000 / ((long) config.sampleRate * config.frameBytes());
        boolean playing = false, primed = false;
        int preBytes = 0;
        long emptySince = -1;
        try {
            while (true) {
                byte[] chunk = null;
                synchronized (this) {
                    if (released) return false;
                    if (!primed && queuedBytes >= startBytes) primed = true;
                    if (primed) chunk = queue.poll();
                    if (chunk != null) {
                        queuedBytes -= chunk.length;
                        if (playing) drain(SystemClock.elapsedRealtime());
                    } else {
                        wait(primed ? 10 : 100);
                    }
                }
                long now = SystemClock.elapsedRealtime();
                if (chunk == null) {
                    if (primed) {
                        if (emptySince < 0) {
                            emptySince = now;
                        } else if (now - emptySince > roomMs) {
                            // Nothing came for longer than the track holds, so it ran dry: wait for 30 ms again
                            // before writing, so the next sound has a little cushion.
                            primed = false;
                            emptySince = -1;
                            starves++;
                        }
                    }
                    log(t, now);
                    continue;
                }
                emptySince = -1;
                if (!playing && preBytes + chunk.length > room) playing = startPlaying(t);
                int n = t.write(chunk, 0, chunk.length);
                if (n < 0) {
                    synchronized (this) {
                        if (released) return false;
                    }
                    CrashLog.note(app, "Phone sound: AudioTrack write error " + n);
                    return true;
                }
                rmsSum += MirrorProtocol.pcmRms(chunk, 0, n);
                rmsCount++;
                if (!playing) {
                    // The first 30 ms go into the track before play(), so it does not start with an underrun.
                    preBytes += n;
                    if (preBytes >= startBytes) playing = startPlaying(t);
                }
                log(t, SystemClock.elapsedRealtime());
            }
        } catch (InterruptedException e) {
            return false;
        } catch (RuntimeException e) {
            synchronized (this) {
                if (released) return false;
            }
            CrashLog.note(app, "Phone sound: " + e);
            return true;
        }
    }

    /**
     * Called under this with a chunk just taken. The blocking writes keep the track full, so the queue normally
     * holds only network jitter (a few ms). If it never went below DRAIN_ABOVE_MS for a whole second (a burst after a
     * Wi-Fi stall that stayed under the 150 ms rule), the sound is late for good: drop the oldest down to
     * DRAIN_TO_MS once, and count it.
     */
    private void drain(long now) {
        if (queuedBytes < lowest) lowest = queuedBytes;
        if (windowEnd == 0) windowEnd = now + DRAIN_WINDOW_MS;
        if (now < windowEnd) return;
        if (lowest != Integer.MAX_VALUE && lowest > drainAboveBytes) {
            int excess = lowest - drainToBytes;
            while (excess > 0 && queue.size() > 1) {
                byte[] old = queue.poll();
                queuedBytes -= old.length;
                excess -= old.length;
                dropped++;
            }
        }
        lowest = Integer.MAX_VALUE;
        windowEnd = now + DRAIN_WINDOW_MS;
    }

    private boolean startPlaying(AudioTrack t) {
        t.play();
        if (!announced) {
            announced = true;
            nextLog = SystemClock.elapsedRealtime() + LOG_MS;
            DebugHooks.event("phone=audio playing rate=" + config.sampleRate + " ch=" + config.channels);
        }
        return true;
    }

    private void log(AudioTrack t, long now) {
        if (!announced || now < nextLog) return;
        nextLog = now + LOG_MS;
        int c, d;
        synchronized (this) {
            c = chunks;
            d = dropped;
        }
        int rms = rmsCount > 0 ? (int) Math.round(rmsSum / rmsCount) : 0;
        rmsSum = 0;
        rmsCount = 0;
        DebugHooks.event("phone=audio chunks=" + c + " rms=" + rms + " dropped=" + d + " underruns="
                + underruns(t));
    }

    /** Underruns so far: the tracks' own count on Android 7+, else the times the queue ran dry. */
    private int underruns(AudioTrack t) {
        if (Build.VERSION.SDK_INT < 24) return starves;
        return underrunsBefore + (t != null ? underrunCount(t) : 0);
    }

    private void close(AudioTrack t) {
        synchronized (this) {
            if (track == t) track = null;
        }
        if (Build.VERSION.SDK_INT >= 24) underrunsBefore += underrunCount(t);
        try {
            t.pause();
            t.flush();
        } catch (RuntimeException ignored) {
        }
        releaseQuietly(t);
    }

    private static void releaseQuietly(AudioTrack t) {
        if (t == null) return;
        try {
            t.release();
        } catch (RuntimeException ignored) {
        }
    }

    // ---------- newer APIs ----------

    /** The TV's own sound must never be captured again (on a test emulator the phone and the TV are one device). */
    @TargetApi(29)
    private static void noCapture(AudioAttributes.Builder b) {
        b.setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE);
    }

    @TargetApi(26)
    private static AudioTrack lowLatency(AudioAttributes attrs, AudioFormat format, int size) {
        AudioTrack t = new AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(format)
                .setBufferSizeInBytes(size)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
                .build();
        if (t.getState() != AudioTrack.STATE_INITIALIZED) {
            releaseQuietly(t);
            throw new IllegalStateException("low-latency AudioTrack not initialized");
        }
        return t;
    }

    @TargetApi(24)
    private static int bufferFrames(AudioTrack t) {
        try {
            return t.getBufferSizeInFrames();
        } catch (RuntimeException e) {
            return 0;
        }
    }

    @TargetApi(24)
    private static int underrunCount(AudioTrack t) {
        try {
            return t.getUnderrunCount();
        } catch (RuntimeException e) {
            return 0;
        }
    }
}
