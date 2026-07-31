package co.logbrew.reactnative;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.attribute.PosixFilePermission;
import java.util.List;
import java.util.Set;

public final class EventRecordStoreTest {
  private int passed;

  public static void main(String[] args) throws Exception {
    if (args.length > 0) {
      runProcessCanary(args);
      return;
    }
    EventRecordStoreTest suite = new EventRecordStoreTest();
    suite.restartLoadsOldestFirstAndAcknowledgesAcceptedPrefix();
    suite.purgeRecoversFromCorruptionWithoutFollowingSymlinks();
    suite.interruptedTemporaryWriteDoesNotHideCommittedRecords();
    suite.enforcesByteCountQueueLimitsAndPrivateModes();
    suite.failedCommitSyncPoisonsOnlyTheCurrentStoreInstance();
    System.out.println("android event record store tests: " + suite.passed + " passed");
  }

  private void restartLoadsOldestFirstAndAcknowledgesAcceptedPrefix() throws Exception {
    withDirectory(
        directory -> {
          EventRecordStore first = new EventRecordStore(directory);
          assertStatus("appended", first.append(event("evt_first"), bytes(event("evt_first"))));
          assertStatus("appended", first.append(event("evt_second"), bytes(event("evt_second"))));

          EventRecordStore afterDeath = new EventRecordStore(directory);
          EventRecordStore.Result loaded = afterDeath.load();
          assertStatus("loaded", loaded);
          assertEquals(2, loaded.records.size());
          assertEquals(event("evt_first"), loaded.records.get(0).serializedEvent);
          assertEquals(event("evt_second"), loaded.records.get(1).serializedEvent);
          assertEquals(1L, loaded.records.get(0).sequence);
          assertEquals(2L, loaded.records.get(1).sequence);

          assertStatus("storage_error", afterDeath.acknowledge(3));
          assertStatus("acknowledged", afterDeath.acknowledge(1));
          EventRecordStore.Result remainder = new EventRecordStore(directory).load();
          assertEquals(1, remainder.records.size());
          assertEquals(event("evt_second"), remainder.records.get(0).serializedEvent);

          assertStatus("acknowledged", afterDeath.acknowledge(1));
          assertEquals(0, new EventRecordStore(directory).load().records.size());
          assertStatus(
              "appended",
              new EventRecordStore(directory)
                  .append(event("evt_after_empty"), bytes(event("evt_after_empty"))));
          assertEquals(3L, new EventRecordStore(directory).load().records.get(0).sequence);
        });
    passed += 1;
  }

  private static void runProcessCanary(String[] args) {
    if (args.length != 2) {
      throw new AssertionError("expected process mode and store directory");
    }
    EventRecordStore store = new EventRecordStore(new File(args[1]));
    switch (args[0]) {
      case "write-hard-exit":
        String serialized = event("evt_process_restart");
        assertStatus("appended", store.append(serialized, bytes(serialized)));
        Runtime.getRuntime().halt(94);
        throw new AssertionError("hard exit returned");
      case "read-ack":
        EventRecordStore.Result loaded = store.load();
        assertStatus("loaded", loaded);
        assertEquals(1, loaded.records.size());
        assertEquals(event("evt_process_restart"), loaded.records.get(0).serializedEvent);
        assertStatus("acknowledged", store.acknowledge(1));
        System.out.println("android event process canary: replayed and acknowledged");
        return;
      case "read-empty":
        assertEquals(0, store.load().records.size());
        System.out.println("android event process canary: accepted prefix stayed empty");
        return;
      default:
        throw new AssertionError("unknown process mode");
    }
  }

  private void purgeRecoversFromCorruptionWithoutFollowingSymlinks() throws Exception {
    withDirectory(
        directory -> {
          EventRecordStore store = new EventRecordStore(directory);
          String serialized = event("evt_corrupt");
          assertStatus("appended", store.append(serialized, bytes(serialized)));
          File record = onlyFile(directory, EventRecordStore.EVENT_SUFFIX);
          writeBytes(record, "corrupt".getBytes(StandardCharsets.UTF_8));
          assertStatus("storage_error", new EventRecordStore(directory).load());
          assertStatus("purged", new EventRecordStore(directory).purge());
          assertEquals(0, new EventRecordStore(directory).load().records.size());

          File outside = Files.createTempFile("logbrew-rn-events-outside-", ".txt").toFile();
          try {
            writeBytes(outside, "outside sentinel".getBytes(StandardCharsets.UTF_8));
            File symlink =
                new File(directory, "event-00000000000000000009" + EventRecordStore.EVENT_SUFFIX);
            Files.createSymbolicLink(symlink.toPath(), outside.toPath());
            assertStatus("storage_error", new EventRecordStore(directory).load());
            assertStatus("storage_error", new EventRecordStore(directory).purge());
            assertEquals(
                "outside sentinel",
                new String(Files.readAllBytes(outside.toPath()), StandardCharsets.UTF_8));
          } finally {
            outside.delete();
          }
        });
    passed += 1;
  }

  private void interruptedTemporaryWriteDoesNotHideCommittedRecords() throws Exception {
    withDirectory(
        directory -> {
          EventRecordStore store = new EventRecordStore(directory);
          String serialized = event("evt_committed");
          assertStatus("appended", store.append(serialized, bytes(serialized)));
          writeBytes(
              new File(directory, "event-00000000000000000002.record.tmp"),
              "partial".getBytes(StandardCharsets.UTF_8));

          EventRecordStore.Result loaded = new EventRecordStore(directory).load();
          assertStatus("loaded", loaded);
          assertEquals(1, loaded.records.size());
          assertEquals(serialized, loaded.records.get(0).serializedEvent);
          assertEquals(false, new File(directory, "event-00000000000000000002.record.tmp").exists());
        });
    passed += 1;
  }

  private void enforcesByteCountQueueLimitsAndPrivateModes() throws Exception {
    withDirectory(
        directory -> {
          EventRecordStore store = new EventRecordStore(directory);
          String serialized = event("evt_private");
          assertStatus("storage_error", store.append(serialized, bytes(serialized) + 1));
          assertStatus("appended", store.append(serialized, bytes(serialized)));
          File record = onlyFile(directory, EventRecordStore.EVENT_SUFFIX);
          Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(record.toPath());
          assertEquals(
              false,
              permissions.contains(PosixFilePermission.GROUP_READ)
                  || permissions.contains(PosixFilePermission.GROUP_WRITE)
                  || permissions.contains(PosixFilePermission.GROUP_EXECUTE)
                  || permissions.contains(PosixFilePermission.OTHERS_READ)
                  || permissions.contains(PosixFilePermission.OTHERS_WRITE)
                  || permissions.contains(PosixFilePermission.OTHERS_EXECUTE));
        });
    passed += 1;
  }

  private void failedCommitSyncPoisonsOnlyTheCurrentStoreInstance() throws Exception {
    withDirectory(
        directory -> {
          RecordingParentDirectorySync failed =
              new RecordingParentDirectorySync(FatalRecordStore.ParentDirectorySyncResult.FAILED);
          EventRecordStore store = new EventRecordStore(directory, failed);
          String serialized = event("evt_unknown_commit");
          assertStatus("storage_error", store.append(serialized, bytes(serialized)));
          assertStatus("storage_error", store.load());

          EventRecordStore.Result recovered = new EventRecordStore(directory).load();
          assertStatus("loaded", recovered);
          assertEquals(1, recovered.records.size());
          assertEquals(serialized, recovered.records.get(0).serializedEvent);
          assertEquals(1, failed.calls);
        });
    passed += 1;
  }

  private static String event(String id) {
    return "{\"type\":\"log\",\"id\":\""
        + id
        + "\",\"timestamp\":\"2026-07-31T08:30:00.000Z\",\"attributes\":{\"level\":\"error\",\"message\":\"offline restart\"}}";
  }

  private static int bytes(String value) {
    return value.getBytes(StandardCharsets.UTF_8).length;
  }

  private static File onlyFile(File directory, String suffix) {
    File[] files = directory.listFiles((unused, name) -> name.endsWith(suffix));
    if (files == null || files.length != 1) {
      throw new AssertionError("expected exactly one " + suffix + " file");
    }
    return files[0];
  }

  private static void withDirectory(DirectoryTest test) throws Exception {
    File directory = Files.createTempDirectory("logbrew-rn-events-android-").toFile();
    try {
      test.run(directory);
    } finally {
      deleteRecursively(directory);
    }
  }

  private static void writeBytes(File file, byte[] bytes) throws Exception {
    try (FileOutputStream stream = new FileOutputStream(file, false)) {
      stream.write(bytes);
      stream.getFD().sync();
    }
  }

  private static void deleteRecursively(File file) {
    if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) {
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

  private static void assertStatus(String expected, EventRecordStore.Result result) {
    assertEquals(expected, result.status);
  }

  private static void assertEquals(Object expected, Object actual) {
    if (!java.util.Objects.equals(expected, actual)) {
      throw new AssertionError("expected " + expected + " but got " + actual);
    }
  }

  private interface DirectoryTest {
    void run(File directory) throws Exception;
  }

  private static final class RecordingParentDirectorySync
      implements FatalRecordStore.ParentDirectorySync {
    private final FatalRecordStore.ParentDirectorySyncResult result;
    private int calls;

    RecordingParentDirectorySync(FatalRecordStore.ParentDirectorySyncResult result) {
      this.result = result;
    }

    @Override
    public FatalRecordStore.ParentDirectorySyncResult sync(File directory) {
      calls += 1;
      return result;
    }
  }
}
