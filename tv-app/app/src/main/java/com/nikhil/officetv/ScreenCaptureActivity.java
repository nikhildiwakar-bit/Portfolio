package com.nikhil.officetv;

import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;

/** Invisible activity that shows Android's "Start now" screen-sharing prompt for Live Screen. */
public class ScreenCaptureActivity extends Activity {
    private static final int REQ = 7;
    private boolean asked;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (state != null) {
            asked = state.getBoolean("asked");
            if (asked) return;
        }
        if (Build.VERSION.SDK_INT < 21) {
            ScreenCapture.failed(this, "Live Screen needs Android 5.0 or newer on the TV.");
            finish();
            return;
        }
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            if (mpm == null) throw new IllegalStateException("screen capture is not available");
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ);
            asked = true;
        } catch (Throwable t) {
            ScreenCapture.failed(this, "This TV does not support screen sharing (" + t.getMessage() + ").");
            finish();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putBoolean("asked", asked);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ) {
            try {
                if (resultCode == RESULT_OK && data != null) ScreenCapture.onPermission(this, resultCode, data);
                else ScreenCapture.declined(this);
            } catch (Throwable t) {
                ScreenCapture.failed(this, "Screen sharing failed on the TV: " + t.getMessage());
            }
        }
        finish();
        overridePendingTransition(0, 0);
    }
}
