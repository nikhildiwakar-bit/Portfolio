package com.nikhil.officetv;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.view.accessibility.AccessibilityEvent;

/**
 * Full flavor only (the lite manifest removes it). While this service is enabled, Android 10+ allows
 * Office TV to open its cast screen from the background when a laptop starts sharing. It does nothing
 * else: it reads no window content, performs no actions and receives almost no events (see a11y_config).
 */
public class RemoteA11yService extends AccessibilityService {
    static volatile RemoteA11yService instance;

    @Override
    protected void onServiceConnected() {
        instance = this;
        DebugHooks.event("a11y=connected");
        // Android binds this service at boot, sometimes before BOOT_COMPLETED: a good moment to get ready.
        ControlService.start(this);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }
}
