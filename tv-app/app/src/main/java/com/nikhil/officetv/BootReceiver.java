package com.nikhil.officetv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the control server when the TV powers on or the app was updated. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            ControlService.start(context);
        } catch (Throwable t) {
            CrashLog.note(context, "Boot start: " + t);
        }
        ServiceJob.schedule(context);
    }
}
