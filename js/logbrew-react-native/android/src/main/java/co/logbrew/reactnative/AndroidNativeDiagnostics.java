package co.logbrew.reactnative;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongConsumer;
import java.util.function.Supplier;
import java.util.regex.Pattern;

final class AndroidNativeDiagnostics {
  interface Scheduler {
    void start(long thresholdMs, LongConsumer report);

    void stop();
  }

  static final class Configuration {
    private static final Pattern PROJECT_ID =
        Pattern.compile("^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$");
    final String projectId;
    final String release;
    final String environment;
    final String service;
    final String operatingSystemVersion;
    final String deviceModel;
    final String architecture;
    final long anrThresholdMs;

    Configuration(
        String projectId,
        String release,
        String environment,
        String service,
        String operatingSystemVersion,
        String deviceModel,
        String architecture,
        long anrThresholdMs) {
      if (!PROJECT_ID.matcher(projectId).matches()
          || !bounded(release, 256)
          || !bounded(environment, 128)
          || !bounded(service, 128)
          || !bounded(operatingSystemVersion, 128)
          || !bounded(deviceModel, 128)
          || !isArchitecture(architecture)
          || anrThresholdMs < 2_000
          || anrThresholdMs > 60_000) {
        throw new IllegalArgumentException("invalid Android diagnostics configuration");
      }
      this.projectId = projectId;
      this.release = release;
      this.environment = environment;
      this.service = service;
      this.operatingSystemVersion = operatingSystemVersion;
      this.deviceModel = deviceModel;
      this.architecture = architecture;
      this.anrThresholdMs = anrThresholdMs;
    }

    private static boolean bounded(String value, int maximum) {
      return value != null
          && !value.isEmpty()
          && value.length() <= maximum
          && value.equals(value.trim())
          && value.chars().noneMatch(
              character -> character <= 31 || character >= 127 && character <= 159);
    }

    private static boolean isArchitecture(String value) {
      return "arm".equals(value)
          || "arm64".equals(value)
          || "x86".equals(value)
          || "x86_64".equals(value);
    }

    boolean matches(Configuration other) {
      return other != null
          && projectId.equals(other.projectId)
          && release.equals(other.release)
          && environment.equals(other.environment)
          && service.equals(other.service)
          && operatingSystemVersion.equals(other.operatingSystemVersion)
          && deviceModel.equals(other.deviceModel)
          && architecture.equals(other.architecture)
          && anrThresholdMs == other.anrThresholdMs;
    }
  }

  private static final int MAX_FRAMES = 32;
  private static final AtomicLong SEQUENCE = new AtomicLong();

  final EventRecordStore eventStore;
  final AndroidNativeSignalStore signalStore;
  private final Configuration configuration;
  private final Scheduler scheduler;
  private final Runnable afterPersist;
  private final Thread.UncaughtExceptionHandler previousHandler;
  private final Supplier<StackTraceElement[]> mainFrames;
  private final String processNonce;
  boolean installed;

  AndroidNativeDiagnostics(
      EventRecordStore eventStore,
      AndroidNativeSignalStore signalStore,
      Configuration configuration,
      Scheduler scheduler,
      Runnable afterPersist,
      Thread.UncaughtExceptionHandler previousHandler,
      Supplier<StackTraceElement[]> mainFrames) {
    this.eventStore = eventStore;
    this.signalStore = signalStore;
    this.configuration = configuration;
    this.scheduler = scheduler;
    this.afterPersist = afterPersist;
    this.previousHandler = previousHandler;
    this.mainFrames = mainFrames;
    processNonce = randomHex(8);
  }

  synchronized String install() {
    if (installed) {
      return "already_installed";
    }
    replaySignalRecord();
    scheduler.start(configuration.anrThresholdMs, this::reportHang);
    installed = true;
    return "installed";
  }

  synchronized String uninstall() {
    if (!installed) {
      return "not_installed";
    }
    installed = false;
    scheduler.stop();
    return "uninstalled";
  }

  void handleUncaught(Thread thread, Throwable error) {
    try {
      append(javaCrashEvent(error));
    } finally {
      previousHandler.uncaughtException(thread, error);
    }
  }

  private synchronized void reportHang(long durationMs) {
    if (!installed) {
      return;
    }
    long boundedDuration =
        Math.max(configuration.anrThresholdMs, Math.min(durationMs, 300_000));
    append(hangEvent(mainFrames.get(), boundedDuration));
  }

  static boolean shouldReportHang(
      long elapsedMs, long thresholdMs, boolean debugging, boolean processNotResponding) {
    return !debugging && processNotResponding && elapsedMs >= thresholdMs;
  }

  private void replaySignalRecord() {
    AndroidNativeSignalStore.Record record = signalStore.read();
    if (record != null && append(nativeCrashEvent(record))) {
      signalStore.clear();
    }
  }

  private boolean append(String serializedEvent) {
    int bytes = serializedEvent.getBytes(StandardCharsets.UTF_8).length;
    EventRecordStore.Result result = eventStore.append(serializedEvent, bytes);
    if (!"appended".equals(result.status)) {
      return false;
    }
    afterPersist.run();
    return true;
  }

  private String javaCrashEvent(Throwable error) {
    StackTraceElement[] frames = error == null ? new StackTraceElement[0] : error.getStackTrace();
    return issueEvent(
        configuration,
        nextId("java"),
        System.currentTimeMillis(),
        "Native application crash",
        "critical",
        safeSymbol(error == null ? null : error.getClass().getName(), 256, "AndroidJavaCrash"),
        "uncaught_exception",
        0,
        frames,
        null);
  }

  private String hangEvent(StackTraceElement[] frames, long durationMs) {
    return issueEvent(
        configuration,
        nextId("hang"),
        System.currentTimeMillis(),
        "Native application hang",
        "error",
        "AndroidAppHang",
        "anr_watchdog",
        durationMs,
        frames,
        null);
  }

  private String nativeCrashEvent(AndroidNativeSignalStore.Record record) {
    return issueEvent(
        new Configuration(
            record.projectId,
            record.release,
            record.environment,
            record.service,
            configuration.operatingSystemVersion,
            configuration.deviceModel,
            record.architecture,
            configuration.anrThresholdMs),
        record.id,
        record.timestampMs,
        "Native application crash",
        "critical",
        "AndroidNativeCrash",
        "signal",
        0,
        new StackTraceElement[0],
        record);
  }

  private String issueEvent(
      Configuration eventConfiguration,
      String id,
      long timestampMs,
      String title,
      String level,
      String exceptionType,
      String mechanism,
      long durationMs,
      StackTraceElement[] frames,
      AndroidNativeSignalStore.Record nativeFrame) {
    StringBuilder output = new StringBuilder(2048);
    output.append("{\"type\":\"issue\",\"id\":\"").append(id)
        .append("\",\"timestamp\":\"").append(timestamp(timestampMs))
        .append("\",\"attributes\":{\"title\":\"").append(title)
        .append("\",\"level\":\"").append(level).append('"');
    appendJavaFrames(output, frames);
    if (nativeFrame != null) {
      output.append(",\"nativeStackFrames\":[{\"imageUuid\":\"")
          .append(nativeFrame.imageUuid).append("\",\"architecture\":\"")
          .append(nativeFrame.architecture).append("\",\"instructionOffset\":\"")
          .append(nativeFrame.instructionOffset).append("\"}]");
    }
    output.append(",\"exception\":{\"type\":\"").append(exceptionType)
        .append("\",\"mechanism\":{\"type\":\"").append(mechanism)
        .append("\",\"handled\":false}},\"metadata\":{")
        .append("\"crash.mechanism\":\"").append(mechanism)
        .append("\",\"crash.replayed\":true,\"crash.handled\":false,")
        .append("\"projectId\":\"").append(eventConfiguration.projectId)
        .append("\",\"release\":\"").append(json(eventConfiguration.release))
        .append("\",\"environment\":\"").append(json(eventConfiguration.environment))
        .append("\",\"service\":\"").append(json(eventConfiguration.service)).append('"');
    if (durationMs > 0) {
      output.append(",\"durationMs\":").append(durationMs);
    }
    if (nativeFrame != null) {
      output.append(",\"crash.signal\":").append(nativeFrame.signal);
    }
    output.append('}');
    appendContext(output, eventConfiguration);
    return output.append("}}").toString();
  }

  private static void appendJavaFrames(StringBuilder output, StackTraceElement[] frames) {
    int start = output.length();
    output.append(",\"stackFrames\":[");
    int count = 0;
    for (StackTraceElement frame : frames) {
      if (frame == null || frame.getLineNumber() <= 0 || count == MAX_FRAMES) {
        continue;
      }
      String filename = safeFilename(frame.getFileName());
      if (filename == null) {
        continue;
      }
      if (count > 0) {
        output.append(',');
      }
      output.append("{\"filename\":\"").append(json(filename))
          .append("\",\"line\":").append(frame.getLineNumber())
          .append(",\"column\":1,\"function\":\"")
          .append(json(safeSymbol(frame.getMethodName(), 256, "unknown")))
          .append("\",\"module\":\"")
          .append(json(safeSymbol(frame.getClassName(), 512, "unknown"))).append("\"}");
      count += 1;
    }
    if (count == 0) {
      output.setLength(start);
    } else {
      output.append(']');
    }
  }

  private static void appendContext(StringBuilder output, Configuration value) {
    output.append(",\"context\":{\"schemaVersion\":1,\"resource\":{\"service\":{\"name\":\"")
        .append(json(value.service)).append("\"},\"deployment\":{\"environment\":\"")
        .append(json(value.environment)).append("\",\"release\":\"")
        .append(json(value.release)).append("\"},\"operatingSystem\":{\"name\":\"Android\",\"version\":\"")
        .append(json(value.operatingSystemVersion)).append("\"},\"device\":{\"model\":\"")
        .append(json(value.deviceModel)).append("\",\"architecture\":\"")
        .append(value.architecture).append("\"}}}");
  }

  private String nextId(String kind) {
    return "evt_android_" + kind + '_' + processNonce + '_' + Long.toString(SEQUENCE.incrementAndGet(), 36);
  }

  String nextNativeEventId() {
    return nextId("native");
  }

  boolean configurationMatches(Configuration candidate) {
    return configuration.matches(candidate);
  }

  private static String safeFilename(String value) {
    String safe = safeSymbol(value, 256, null);
    return safe == null || safe.contains("/") || safe.contains("\\") || safe.contains("?") || safe.contains("#") ? null : safe;
  }

  private static String safeSymbol(String value, int maximum, String fallback) {
    return value == null
            || value.trim().isEmpty()
            || value.length() > maximum
            || value.chars().anyMatch(character -> character <= 31 || character == 127)
        ? fallback
        : value.trim();
  }

  private static String json(String value) {
    StringBuilder output = new StringBuilder(value.length());
    for (int index = 0; index < value.length(); index += 1) {
      char character = value.charAt(index);
      if (character == '"' || character == '\\') {
        output.append('\\');
      }
      output.append(character);
    }
    return output.toString();
  }

  private static String timestamp(long timestampMs) {
    SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
    format.setTimeZone(TimeZone.getTimeZone("UTC"));
    return format.format(new Date(timestampMs));
  }

  private static String randomHex(int bytes) {
    byte[] value = new byte[bytes];
    new SecureRandom().nextBytes(value);
    StringBuilder output = new StringBuilder(bytes * 2);
    for (byte item : value) {
      output.append(String.format(Locale.ROOT, "%02x", item & 0xff));
    }
    return output.toString();
  }
}
