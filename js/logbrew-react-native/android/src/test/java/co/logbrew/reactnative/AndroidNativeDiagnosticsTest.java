package co.logbrew.reactnative;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.LongConsumer;
import java.util.zip.CRC32;

public final class AndroidNativeDiagnosticsTest {
  public static void main(String[] args) throws Exception {
    AndroidNativeDiagnosticsTest suite = new AndroidNativeDiagnosticsTest();
    suite.uncaughtExceptionPersistsBeforeChainingWithoutMessageContent();
    suite.anrPersistsOneBoundedMainThreadReport();
    suite.anrRequiresThisProcessToBeUnresponsive();
    suite.configurationIdentityIsExact();
    suite.nativeSignalRecordReplaysExactlyOnceIntoTheCanonicalQueue();
    suite.pendingNativeSignalSurvivesQueueAdmissionFailure();
    suite.uninstallReinstatesThePreviousHandlerAndStopsTheWatchdog();
    System.out.println("android native diagnostics tests: 7 passed");
  }

  private void uncaughtExceptionPersistsBeforeChainingWithoutMessageContent() throws Exception {
    withDirectory(
        directory -> {
          List<String> order = new ArrayList<>();
          AndroidNativeDiagnostics diagnostics =
              fixture(directory, order, new FakeScheduler());
          diagnostics.install();
          diagnostics.handleUncaught(
              Thread.currentThread(), new IllegalStateException("opaque-value=hidden"));

          assertEquals(Arrays.asList("persist", "chain"), order);
          String event = onlyQueuedEvent(directory);
          assertContains(event, "java.lang.IllegalStateException");
          assertContains(event, "AndroidNativeDiagnosticsTest.java");
          assertContains(event, "uncaughtExceptionPersistsBeforeChainingWithoutMessageContent");
          assertContains(event, "\"operatingSystem\":{\"name\":\"Android\",\"version\":\"15\"}");
          assertContains(event, "\"device\":{\"model\":\"Generic Phone\",\"architecture\":\"arm64\"}");
          assertNotContains(event, "\"durationMs\"");
          assertNotContains(event, "opaque-value");
          assertNotContains(event, "hidden");
        });
  }

  private void anrPersistsOneBoundedMainThreadReport() throws Exception {
    withDirectory(
        directory -> {
          List<String> order = new ArrayList<>();
          FakeScheduler scheduler = new FakeScheduler();
          AndroidNativeDiagnostics diagnostics = fixture(directory, order, scheduler);
          diagnostics.install();

          scheduler.advanceBy(5_000);
          scheduler.advanceBy(5_000);

          EventRecordStore.Result loaded = diagnostics.eventStore.load();
          assertEquals(1, loaded.records.size());
          String event = loaded.records.get(0).serializedEvent;
          assertContains(event, "AndroidAppHang");
          assertContains(event, "\"durationMs\":5000");
          assertNotContains(event, "\"thread\"");
        });
  }

  private void anrRequiresThisProcessToBeUnresponsive() {
    assertEquals(false, AndroidNativeDiagnostics.shouldReportHang(4_999, 5_000, false, true));
    assertEquals(false, AndroidNativeDiagnostics.shouldReportHang(5_000, 5_000, true, true));
    assertEquals(false, AndroidNativeDiagnostics.shouldReportHang(5_000, 5_000, false, false));
    assertEquals(true, AndroidNativeDiagnostics.shouldReportHang(5_000, 5_000, false, true));
  }

  private void configurationIdentityIsExact() {
    AndroidNativeDiagnostics.Configuration expected = configuration("production", 5_000);
    assertEquals(true, expected.matches(configuration("production", 5_000)));
    assertEquals(false, expected.matches(configuration("canary", 5_000)));
    assertEquals(false, expected.matches(configuration("production", 6_000)));
  }

  private void nativeSignalRecordReplaysExactlyOnceIntoTheCanonicalQueue() throws Exception {
    withDirectory(
        directory -> {
          List<String> order = new ArrayList<>();
          AndroidNativeDiagnostics diagnostics =
              fixture(directory, order, new FakeScheduler());
          assertEquals(
              true,
              diagnostics.signalStore.prepare(
                  ignored -> EventRecordStore.ParentDirectorySyncResult.SYNCHRONIZED));
          assertEquals((long) AndroidNativeSignalStore.RECORD_BYTES, new File(directory, "signal.record").length());
          writeSignalRecord(
              new File(directory, "signal.record"),
              "evt_android_native_fixed",
              "com.example.app@1.2.2+44",
              "canary");
          assertEquals(
              "evt_android_native_fixed",
              diagnostics.signalStore.read().id);

          diagnostics.install();
          diagnostics.uninstall();
          diagnostics.install();

          EventRecordStore.Result loaded = diagnostics.eventStore.load();
          assertEquals(1, loaded.records.size());
          assertContains(loaded.records.get(0).serializedEvent, "AndroidNativeCrash");
          assertContains(loaded.records.get(0).serializedEvent, "\"crash.signal\":11");
          assertContains(loaded.records.get(0).serializedEvent, "0000000000001234");
          assertContains(loaded.records.get(0).serializedEvent, "com.example.app@1.2.2+44");
          assertContains(loaded.records.get(0).serializedEvent, "\"environment\":\"canary\"");
          assertNotContains(loaded.records.get(0).serializedEvent, "com.example.app@1.2.3+45");
          assertEquals(null, diagnostics.signalStore.read());
        });
  }

  private void pendingNativeSignalSurvivesQueueAdmissionFailure() throws Exception {
    withDirectory(
        directory -> {
          File signalFile = new File(directory, "signal.record");
          AndroidNativeSignalStore signalStore = new AndroidNativeSignalStore(signalFile);
          writeSignalRecord(
              signalFile,
              "evt_android_native_retained",
              "com.example.app@1.2.3+45",
              "production");

          assertEquals(
              false,
              signalStore.prepare(
                  ignored -> EventRecordStore.ParentDirectorySyncResult.SYNCHRONIZED));
          assertEquals("evt_android_native_retained", signalStore.read().id);
        });
  }

  private void uninstallReinstatesThePreviousHandlerAndStopsTheWatchdog() throws Exception {
    withDirectory(
        directory -> {
          List<String> order = new ArrayList<>();
          FakeScheduler scheduler = new FakeScheduler();
          AndroidNativeDiagnostics diagnostics = fixture(directory, order, scheduler);
          diagnostics.install();
          diagnostics.uninstall();
          scheduler.advanceBy(10_000);

          assertEquals(false, diagnostics.installed);
          assertEquals(0, diagnostics.eventStore.load().records.size());
          assertEquals(true, scheduler.cancelled());
        });
  }

  private static AndroidNativeDiagnostics fixture(
      File directory,
      List<String> order,
      FakeScheduler scheduler) {
    return new AndroidNativeDiagnostics(
        new EventRecordStore(new File(directory, "events")),
        new AndroidNativeSignalStore(new File(directory, "signal.record")),
        configuration("production", 5_000),
        scheduler,
        () -> order.add("persist"),
        (thread, error) -> order.add("chain"),
        () -> Thread.currentThread().getStackTrace());
  }

  private static AndroidNativeDiagnostics.Configuration configuration(
      String environment, long thresholdMs) {
    return new AndroidNativeDiagnostics.Configuration(
        "550e8400-e29b-41d4-a716-446655440000",
        "com.example.app@1.2.3+45",
        environment,
        "android-app",
        "15",
        "Generic Phone",
        "arm64",
        thresholdMs);
  }

  private static String onlyQueuedEvent(File directory) {
    EventRecordStore.Result result =
        new EventRecordStore(new File(directory, "events")).load();
    assertEquals(1, result.records.size());
    return result.records.get(0).serializedEvent;
  }

  private static void writeSignalRecord(
      File file, String id, String release, String environment) throws Exception {
    writeSignalRecord(
        file,
        id,
        11,
        "01234567-89ab-cdef-0123-456789abcdef",
        "arm64",
        "0000000000001234",
        "550e8400-e29b-41d4-a716-446655440000",
        release,
        environment,
        "android-app");
  }

  private static void writeSignalRecord(
      File file,
      String id,
      int signal,
      String uuid,
      String arch,
      String offset,
      String projectId,
      String release,
      String environment,
      String service) throws Exception {
    byte[] bytes = new byte[AndroidNativeSignalStore.RECORD_BYTES];
    ByteBuffer output = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    output.putInt(AndroidNativeSignalStore.MAGIC).putInt(AndroidNativeSignalStore.VERSION)
        .putInt(signal).putLong(System.currentTimeMillis());
    putAscii(output, id, AndroidNativeSignalStore.ID_BYTES);
    putAscii(output, uuid, AndroidNativeSignalStore.UUID_BYTES);
    putAscii(output, arch, AndroidNativeSignalStore.ARCH_BYTES);
    putAscii(output, offset, AndroidNativeSignalStore.OFFSET_BYTES);
    putUtf16(output, projectId, AndroidNativeSignalStore.PROJECT_BYTES);
    putUtf16(output, release, AndroidNativeSignalStore.RELEASE_BYTES);
    putUtf16(output, environment, AndroidNativeSignalStore.ENVIRONMENT_BYTES);
    putUtf16(output, service, AndroidNativeSignalStore.SERVICE_BYTES);
    CRC32 checksum = new CRC32();
    checksum.update(bytes, 0, bytes.length - 4);
    output.putInt((int) checksum.getValue());
    Files.write(file.toPath(), bytes);
  }

  private static void putAscii(ByteBuffer output, String value, int width) {
    byte[] bytes = value.getBytes(StandardCharsets.US_ASCII);
    output.put(bytes).put(new byte[width - bytes.length]);
  }

  private static void putUtf16(ByteBuffer output, String value, int bytes) {
    int capacity = bytes / 2;
    for (int index = 0; index < capacity; index += 1) {
      output.putChar(index < value.length() ? value.charAt(index) : 0);
    }
  }

  private static void withDirectory(DirectoryTest test) throws Exception {
    File directory = Files.createTempDirectory("logbrew-rn-android-diagnostics-").toFile();
    try {
      test.run(directory);
    } finally {
      deleteRecursively(directory);
    }
  }

  private static void deleteRecursively(File file) {
    if (file.isDirectory()) {
      File[] children = file.listFiles();
      if (children != null) {
        for (File child : children) {
          deleteRecursively(child);
        }
      }
    }
    if (!file.delete() && file.exists()) {
      throw new AssertionError("failed to remove test artifact");
    }
  }

  private static void assertContains(String value, String expected) {
    if (!value.contains(expected)) {
      throw new AssertionError("expected event to contain " + expected);
    }
  }

  private static void assertNotContains(String value, String forbidden) {
    if (value.contains(forbidden)) {
      throw new AssertionError("event exposed forbidden content");
    }
  }

  private static void assertEquals(Object expected, Object actual) {
    if (!java.util.Objects.equals(expected, actual)) {
      throw new AssertionError("expected " + expected + " but got " + actual);
    }
  }

  private interface DirectoryTest {
    void run(File directory) throws Exception;
  }

  private static final class FakeScheduler implements AndroidNativeDiagnostics.Scheduler {
    private LongConsumer report;
    private long thresholdMs;
    private long elapsedMs;
    private boolean cancelled;

    @Override
    public void start(long thresholdMs, LongConsumer report) {
      this.thresholdMs = thresholdMs;
      this.report = report;
      elapsedMs = 0;
      cancelled = false;
    }

    @Override
    public void stop() {
      cancelled = true;
      report = null;
    }

    void advanceBy(long durationMs) {
      elapsedMs += durationMs;
      if (!cancelled && report != null && elapsedMs >= thresholdMs) {
        LongConsumer pending = report;
        report = null;
        pending.accept(elapsedMs);
      }
    }

    boolean cancelled() {
      return cancelled;
    }
  }
}
