package com.nikhil.officetv;

import android.annotation.TargetApi;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.Process;
import android.os.SystemClock;

import com.nikhil.officetv.mirror.MirrorProtocol;

/**
 * Phone side of mirroring sound (Android 10+): records what apps play on the phone (media, games, unknown
 * usage) from the session's MediaProjection, never the microphone. PCM 16-bit stereo, 48 kHz (44.1 kHz if
 * the phone refuses 48), handed on in 10 ms chunks from its own thread. Nothing here throws: a failure is
 * reported as a short reason ("error ...").
 */
@TargetApi(29)
final class PhoneAudioCapture {
    static final int CHANNELS = 2;
    static final int CHUNK_MS = 10;
    private static final int[] RATES = {48000, 44100};

    interface Listener {
        /** On the capture thread, before the first chunk: the format of the chunks that follow. */
        void onStart(int sampleRate, int channels);

        /** A 10 ms chunk (a new array each time), on the capture thread. ptsUs is System.nanoTime() / 1000. */
        void onAudio(long ptsUs, byte[] pcm);

        /** Capture ended on its own (not by stop()); the screen goes on without sound. */
        void onError(String reason);
    }

    private final MediaProjection projection;
    private final Listener listener;
    private final Object lock = new Object();
    private AudioRecord record;
    private int rate;
    private int chunkBytes;
    private volatile boolean stopped;
    private boolean released;

    PhoneAudioCapture(MediaProjection projection, Listener listener) {
        this.projection = projection;
        this.listener = listener;
    }

    int sampleRate() {
        return rate;
    }

    int channels() {
        return CHANNELS;
    }

    /**
     * Starts recording and the reader thread. Returns null when sound runs (sampleRate() is then set), else the
     * reason: "permission" or "error ...". Call it off the main thread.
     */
    String start() {
        String why = "error no format";
        AudioRecord r = null;
        for (int hz : RATES) {
            try {
                r = open(hz);
            } catch (SecurityException e) {
                return "permission";
            } catch (RuntimeException e) {
                // IllegalArgumentException / UnsupportedOperationException: try the next rate.
                why = "error " + e.getClass().getSimpleName() + " " + e.getMessage();
                continue;
            }
            if (r != null) {
                rate = hz;
                break;
            }
            why = "error not initialized";
        }
        if (r == null) return why;
        chunkBytes = new MirrorProtocol.AudioConfig(rate, CHANNELS, MirrorProtocol.AUDIO_PCM16).bytesFor(CHUNK_MS);
        try {
            r.startRecording();
            if (r.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                releaseQuietly(r);
                return "error not recording";
            }
        } catch (RuntimeException e) {
            // SecurityException or IllegalStateException (another app holds the capture, audio server trouble).
            releaseQuietly(r);
            return "error start " + e.getClass().getSimpleName() + " " + e.getMessage();
        }
        synchronized (lock) {
            record = r;
            if (stopped) {
                released = true;
                stopAndRelease(r);
                return "error stopped";
            }
        }
        final AudioRecord rec = r;
        Thread t = new Thread(() -> readLoop(rec), "otv-send-audio");
        t.setDaemon(true);
        t.start();
        return null;
    }

    /** An initialized AudioRecord for this rate, or null if the phone does not support it. */
    private AudioRecord open(int hz) {
        int min = AudioRecord.getMinBufferSize(hz, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) return null;
        int chunk = new MirrorProtocol.AudioConfig(hz, CHANNELS, MirrorProtocol.AUDIO_PCM16).bytesFor(CHUNK_MS);
        AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build();
        AudioRecord r = new AudioRecord.Builder()
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(hz)
                        .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                        .build())
                .setBufferSizeInBytes(Math.max(min, 4 * chunk))
                .setAudioPlaybackCaptureConfig(config)
                .build();
        if (r.getState() != AudioRecord.STATE_INITIALIZED) {
            releaseQuietly(r);
            return null;
        }
        return r;
    }

    private void readLoop(AudioRecord r) {
        try {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        } catch (RuntimeException ignored) {
        }
        String why = null;
        try {
            listener.onStart(rate, CHANNELS);
            byte[] buf = new byte[chunkBytes];
            int got = 0;
            while (!stopped) {
                int n = r.read(buf, got, chunkBytes - got);
                if (stopped) break;
                if (n < 0) {
                    why = "error read " + n;
                    break;
                }
                if (n == 0) {
                    SystemClock.sleep(2);
                    continue;
                }
                got += n;
                if (got < chunkBytes) continue;
                long pts = System.nanoTime() / 1000;
                byte[] chunk = buf;
                buf = new byte[chunkBytes];
                got = 0;
                listener.onAudio(pts, chunk);
            }
        } catch (RuntimeException e) {
            if (!stopped) why = "error " + e.getClass().getSimpleName() + " " + e.getMessage();
        } finally {
            // Released here, after the last read: releasing during a read can crash the audio client.
            synchronized (lock) {
                if (!released) {
                    released = true;
                    stopAndRelease(r);
                }
            }
        }
        if (why != null && !stopped) listener.onError(why);
    }

    /** Stops sound (idempotent, any thread): unblocks the reader, which releases the recorder. */
    void stop() {
        stopped = true;
        synchronized (lock) {
            AudioRecord r = record;
            if (r == null || released) return;
            try {
                r.stop();
            } catch (RuntimeException ignored) {
            }
        }
    }

    private static void stopAndRelease(AudioRecord r) {
        try {
            r.stop();
        } catch (RuntimeException ignored) {
        }
        releaseQuietly(r);
    }

    private static void releaseQuietly(AudioRecord r) {
        try {
            r.release();
        } catch (RuntimeException ignored) {
        }
    }
}
