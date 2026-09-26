package com.nikhil.officetv;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import java.util.List;

/** Watchdog: about every 15 minutes (and after reboots) makes sure the control service is running. */
public class ServiceJob extends JobService {
    static final int JOB_ID = 8080;
    private static final long PERIOD_MS = 15L * 60 * 1000;

    /** Schedules the periodic watchdog once; later calls are cheap no-ops. Never throws. */
    static void schedule(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            List<JobInfo> pending = js.getAllPendingJobs();
            if (pending != null) {
                for (JobInfo j : pending) if (j.getId() == JOB_ID) return;
            }
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, ServiceJob.class))
                    .setPeriodic(PERIOD_MS)
                    .setPersisted(true)
                    .build();
            if (js.schedule(job) != JobScheduler.RESULT_SUCCESS) CrashLog.note(c, "Watchdog job schedule nahi hua.");
        } catch (Throwable t) {
            CrashLog.note(c, "Watchdog job: " + t);
        }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        try {
            if (!ControlService.running()) ControlService.start(this);
        } catch (Throwable t) {
            CrashLog.note(this, "Watchdog: " + t);
        }
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
