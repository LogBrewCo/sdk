package co.logbrew.reactnative;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.io.File;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongConsumer;

final class AndroidDiagnosticsRuntime implements Thread.UncaughtExceptionHandler {
  private static final boolean SIGNAL_CAPTURE_AVAILABLE = loadSignalCapture();

  private final AndroidNativeDiagnostics diagnostics;
  private final Thread.UncaughtExceptionHandler previousHandler;
  private final AndroidNativeDiagnostics.Configuration configuration;

  AndroidDiagnosticsRuntime(
      Context context,
      File storageRoot,
      EventRecordStore eventStore,
      AndroidNativeDiagnostics.Configuration configuration,
      Runnable afterPersist) {
    this.configuration = configuration;
    previousHandler = Thread.getDefaultUncaughtExceptionHandler();
    MainThreadScheduler scheduler = new MainThreadScheduler(context);
    AndroidNativeSignalStore signalStore =
        new AndroidNativeSignalStore(new File(storageRoot, "logbrew-android-native-v1.signal"));
    diagnostics =
        new AndroidNativeDiagnostics(
            eventStore,
            signalStore,
            configuration,
            scheduler,
            afterPersist,
            this::chain,
            scheduler.mainThread::getStackTrace,
            context.getPackageName());
  }

  synchronized String install() {
    if (diagnostics.installed) {
      return "already_installed";
    }
    if (pending() < 0) {
      throw new IllegalStateException("event queue unavailable");
    }
    String status = diagnostics.install();
    Thread.setDefaultUncaughtExceptionHandler(this);
    if (!diagnostics.signalStore.prepare(new AndroidParentDirectorySync())
        || !SIGNAL_CAPTURE_AVAILABLE
        || !nativeInstall(
            diagnostics.signalStore.path(),
            diagnostics.nextNativeEventId(),
            configuration.projectId,
            configuration.release,
            configuration.environment,
            configuration.service)) {
      Thread.setDefaultUncaughtExceptionHandler(previousHandler);
      diagnostics.uninstall();
      throw new IllegalStateException("signal capture unavailable");
    }
    return status;
  }

  synchronized String uninstall() {
    if (!diagnostics.installed) {
      return "not_installed";
    }
    if (SIGNAL_CAPTURE_AVAILABLE) {
      nativeUninstall();
    }
    if (Thread.getDefaultUncaughtExceptionHandler() == this) {
      Thread.setDefaultUncaughtExceptionHandler(previousHandler);
    }
    diagnostics.uninstall();
    return "uninstalled";
  }

  synchronized int pending() {
    EventRecordStore.Result result = diagnostics.eventStore.load();
    return "loaded".equals(result.status) ? result.records.size() : -1;
  }

  synchronized boolean installed() {
    return diagnostics.installed;
  }

  synchronized boolean matches(
      EventRecordStore eventStore, AndroidNativeDiagnostics.Configuration configuration) {
    return diagnostics.eventStore == eventStore && diagnostics.configuration.matches(configuration);
  }

  @Override
  public void uncaughtException(Thread thread, Throwable error) {
    diagnostics.handleUncaught(thread, error);
  }

  private void chain(Thread thread, Throwable error) {
    if (previousHandler != null && previousHandler != this) {
      previousHandler.uncaughtException(thread, error);
      return;
    }
    android.os.Process.killProcess(android.os.Process.myPid());
    System.exit(10);
  }

  private static boolean loadSignalCapture() {
    try {
      System.loadLibrary("logbrew_android_diagnostics");
      return true;
    } catch (LinkageError error) {
      return false;
    }
  }

  private static native boolean nativeInstall(
      String recordPath,
      String eventId,
      String projectId,
      String release,
      String environment,
      String service);

  private static native void nativeUninstall();

  private static final class MainThreadScheduler implements AndroidNativeDiagnostics.Scheduler {
    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Thread mainThread = Looper.getMainLooper().getThread();
    private final AtomicLong heartbeatMs = new AtomicLong(SystemClock.elapsedRealtime());
    private final AtomicBoolean reported = new AtomicBoolean();
    private ScheduledExecutorService executor;

    MainThreadScheduler(Context context) {
      this.context = context.getApplicationContext();
    }

    @Override
    public synchronized void start(
        long thresholdMs, LongConsumer report) {
      stop();
      heartbeatMs.set(SystemClock.elapsedRealtime());
      mainHandler.post(this::heartbeat);
      executor =
          Executors.newSingleThreadScheduledExecutor(
              runnable -> {
                Thread thread = new Thread(runnable, "LogBrew-ANR-Watchdog");
                thread.setDaemon(true);
                return thread;
              });
      executor.scheduleWithFixedDelay(
          () -> {
            long now = SystemClock.elapsedRealtime();
            long elapsedMs = now - heartbeatMs.get();
            boolean debugging = android.os.Debug.isDebuggerConnected()
                || android.os.Debug.waitingForDebugger();
            if (AndroidNativeDiagnostics.shouldReportHang(
                    elapsedMs, thresholdMs, debugging, processNotResponding())
                && reported.compareAndSet(false, true)) {
              report.accept(elapsedMs);
            }
            mainHandler.post(this::heartbeat);
          },
          thresholdMs,
          AndroidNativeDiagnostics.WATCHDOG_POLL_MS,
          TimeUnit.MILLISECONDS);
    }

    @Override
    public synchronized void stop() {
      if (executor != null) {
        executor.shutdownNow();
        executor = null;
      }
    }

    private void heartbeat() {
      heartbeatMs.set(SystemClock.elapsedRealtime());
      reported.set(false);
    }

    private boolean processNotResponding() {
      ActivityManager manager =
          (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
      if (manager == null) {
        return false;
      }
      try {
        java.util.List<ActivityManager.ProcessErrorStateInfo> states =
            manager.getProcessesInErrorState();
        if (states != null) {
          int processId = android.os.Process.myPid();
          for (ActivityManager.ProcessErrorStateInfo state : states) {
            if (state != null
                && state.pid == processId
                && state.condition == ActivityManager.ProcessErrorStateInfo.NOT_RESPONDING) {
              return true;
            }
          }
        }
      } catch (RuntimeException ignored) {
        return false;
      }
      return false;
    }
  }
}
