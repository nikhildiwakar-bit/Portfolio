package com.nikhil.officetv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the control server when the TV powers on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        ControlService.start(context);
    }
}
