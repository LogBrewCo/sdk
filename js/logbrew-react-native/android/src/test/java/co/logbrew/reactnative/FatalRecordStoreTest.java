package co.logbrew.reactnative;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Arrays;
import java.util.Collections;
import java.util.Set;

public final class FatalRecordStoreTest {
  private int passed;

  public static void main(String[] args) throws Exception {
    if (args.length > 0) {
      runProcessCanary(args);
      return;
    }
    FatalRecordStoreTest suite = new FatalRecordStoreTest();
    suite.newStoreInstanceReadsAndAcknowledgesExactlyOnce();
    suite.dropsNewestRecordAndPersistsBoundedHealth();
    suite.discardsCorruptionAndRecovers();
    suite.rejectsUnsafeOrOversizedRecords();
    suite.ignoresInterruptedTemporaryWrite();
    suite.rejectsSymlinkReplacementAndUsesPrivateModes();
    suite.discardSupportsRollback();
    suite.unsupportedParentDirectorySyncPreservesCommittedStatuses();
    suite.realParentDirectorySyncFailureRemainsFailClosed();
    System.out.println("android fatal record store tests: " + suite.passed + " passed");
  }

  private void newStoreInstanceReadsAndAcknowledgesExactlyOnce() throws Exception {
    withDirectory(
        directory -> {
          FatalRecordStore first = new FatalRecordStore(directory);
          assertStatus("stored", first.write(record("evt_rn_fatal_first", "index.android.bundle")));

          FatalRecordStore afterDeath = new FatalRecordStore(directory);
          FatalRecordStore.Result pending = afterDeath.read();
          assertStatus("pending", pending);
          assertEquals("evt_rn_fatal_first", pending.record.id);
          assertEquals("index.android.bundle", pending.record.stackFrames.get(0).filename);

          assertStatus("id_mismatch", afterDeath.acknowledge("evt_rn_fatal_other"));
          assertStatus("pending", new FatalRecordStore(directory).read());
          assertStatus("acknowledged", afterDeath.acknowledge("evt_rn_fatal_first"));
          assertStatus("empty", new FatalRecordStore(directory).read());
          assertStatus("empty", afterDeath.acknowledge("evt_rn_fatal_first"));
        });
    passed += 1;
  }

  private static void runProcessCanary(String[] args) {
    if (args.length != 2) {
      throw new AssertionError("expected process mode and store directory");
    }
    String mode = args[0];
    FatalRecordStore store = new FatalRecordStore(new File(args[1]));
    switch (mode) {
      case "write-hard-exit":
        assertStatus(
            "stored",
            store.write(record("evt_rn_fatal_process_canary", "index.android.bundle")));
        Runtime.getRuntime().halt(93);
        throw new AssertionError("hard exit returned");
      case "read-mismatched-ack":
        FatalRecordStore.Result pending = store.read();
        assertStatus("pending", pending);
        assertEquals("evt_rn_fatal_process_canary", pending.record.id);
        assertStatus("id_mismatch", store.acknowledge("evt_rn_fatal_other"));
        assertStatus("pending", store.read());
        System.out.println("android process canary: mismatched ack retained");
        return;
      case "exact-ack":
        assertStatus("acknowledged", store.acknowledge("evt_rn_fatal_process_canary"));
        System.out.println("android process canary: exact ack removed");
        return;
      case "read-empty":
        assertStatus("empty", store.read());
        System.out.println("android process canary: fresh read empty");
        return;
      default:
        throw new AssertionError("unknown process mode");
    }
  }

  private void dropsNewestRecordAndPersistsBoundedHealth() throws Exception {
    withDirectory(
        directory -> {
          FatalRecordStore store = new FatalRecordStore(directory);
          assertStatus("stored", store.write(record("evt_rn_fatal_oldest", "index.android.bundle")));
          FatalRecordStore.Result dropped =
              store.write(record("evt_rn_fatal_newest", "main.jsbundle"));
          assertStatus("dropped_pending", dropped);
          assertEquals(1, dropped.droppedRecords);

          FatalRecordStore.Result pending = new FatalRecordStore(directory).read();
          assertEquals("evt_rn_fatal_oldest", pending.record.id);
          assertEquals(1, pending.record.droppedRecords);
          assertEquals(0, pending.record.corruptRecords);
        });
    passed += 1;
  }

  private void discardsCorruptionAndRecovers() throws Exception {
    withDirectory(
        directory -> {
          writeBytes(
              new File(directory, FatalRecordStore.RECORD_FILE_NAME),
              "not a LogBrew record".getBytes(StandardCharsets.UTF_8));

          FatalRecordStore store = new FatalRecordStore(directory);
          FatalRecordStore.Result corrupted = store.read();
          assertStatus("corrupt_discarded", corrupted);
          assertEquals(1, corrupted.corruptRecords);
          assertStatus("empty", store.read());

          FatalRecordStore.Result recovered =
              store.write(record("evt_rn_fatal_recovered", "index.android.bundle"));
          assertStatus("stored", recovered);
          assertEquals("evt_rn_fatal_recovered", new FatalRecordStore(directory).read().record.id);
        });
    passed += 1;
  }

  private void rejectsUnsafeOrOversizedRecords() throws Exception {
    withDirectory(
        directory -> {
          FatalRecordStore store = new FatalRecordStore(directory);
          assertStatus(
              "invalid_record",
              store.write(record("evt_rn_fatal_absolute", "/Users/private/source.js")));
          assertStatus(
              "invalid_record",
              store.write(record("evt_rn_fatal_remote", "https://private.example.test/main.js")));
          assertStatus(
              "invalid_record",
              store.write(
                  new FatalRecordStore.Record(
                      1,
                      "evt_rn_fatal_" + repeat("a", 90),
                      "2026-07-25T12:00:00.000Z",
                      "Error",
                      Collections.singletonList(
                          new FatalRecordStore.Frame("main.jsbundle", 12, 34)),
                      0,
                      0)));
          assertStatus(
              "invalid_record",
              store.write(
                  new FatalRecordStore.Record(
                      1,
                      "evt_rn_fatal_nonzero_counter",
                      "2026-07-25T12:00:00.000Z",
                      "Error",
                      Collections.singletonList(
                          new FatalRecordStore.Frame("main.jsbundle", 12, 34)),
                      1,
                      0)));
          assertStatus(
              "invalid_record",
              store.write(
                  new FatalRecordStore.Record(
                      1,
                      "evt_rn_fatal_many_frames",
                      "2026-07-25T12:00:00.000Z",
                      "Error",
                      Arrays.asList(new FatalRecordStore.Frame[25]),
                      0,
                      0)));
          assertStatus("empty", store.read());
        });
    passed += 1;
  }

  private static String repeat(String value, int count) {
    StringBuilder result = new StringBuilder(value.length() * count);
    for (int index = 0; index < count; index += 1) {
      result.append(value);
    }
    return result.toString();
  }

  private void ignoresInterruptedTemporaryWrite() throws Exception {
    withDirectory(
        directory -> {
          FatalRecordStore store = new FatalRecordStore(directory);
          assertStatus("stored", store.write(record("evt_rn_fatal_committed", "main.jsbundle")));
          writeBytes(
              new File(directory, FatalRecordStore.TEMP_FILE_NAME),
              "partial private bytes".getBytes(StandardCharsets.UTF_8));

          FatalRecordStore.Result pending = new FatalRecordStore(directory).read();
          assertStatus("pending", pending);
          assertEquals("evt_rn_fatal_committed", pending.record.id);
          assertEquals(false, new File(directory, FatalRecordStore.TEMP_FILE_NAME).exists());
        });
    passed += 1;
  }

  private void discardSupportsRollback() throws Exception {
    withDirectory(
        directory -> {
          FatalRecordStore store = new FatalRecordStore(directory);
          assertStatus("stored", store.write(record("evt_rn_fatal_rollback", "main.jsbundle")));
          assertStatus("discarded", store.discard());
          assertStatus("empty", new FatalRecordStore(directory).read());
          assertStatus("empty", store.discard());
        });
    passed += 1;
  }

  private void unsupportedParentDirectorySyncPreservesCommittedStatuses() throws Exception {
    withDirectory(
        directory -> {
          RecordingParentDirectorySync parentSync =
              new RecordingParentDirectorySync(
                  FatalRecordStore.ParentDirectorySyncResult.UNSUPPORTED);
          FatalRecordStore store = new FatalRecordStore(directory, parentSync);

          assertStatus(
              "stored",
              store.write(record("evt_rn_fatal_unsupported_sync", "main.jsbundle")));
          assertStatus("pending", new FatalRecordStore(directory, parentSync).read());
          assertStatus(
              "acknowledged",
              store.acknowledge("evt_rn_fatal_unsupported_sync"));
          assertStatus("empty", new FatalRecordStore(directory, parentSync).read());
          assertEquals(2, parentSync.calls);
        });
    passed += 1;
  }

  private void realParentDirectorySyncFailureRemainsFailClosed() throws Exception {
    withDirectory(
        directory -> {
          RecordingParentDirectorySync failedSync =
              new RecordingParentDirectorySync(
                  FatalRecordStore.ParentDirectorySyncResult.FAILED);
          FatalRecordStore store = new FatalRecordStore(directory, failedSync);

          assertStatus(
              "storage_error",
              store.write(record("evt_rn_fatal_sync_failed", "main.jsbundle")));
          assertStatus("pending", new FatalRecordStore(directory).read());
          assertStatus(
              "storage_error",
              store.acknowledge("evt_rn_fatal_sync_failed"));
          assertStatus("empty", new FatalRecordStore(directory).read());
          assertEquals(2, failedSync.calls);
        });
    passed += 1;
  }

  private void rejectsSymlinkReplacementAndUsesPrivateModes() throws Exception {
    withDirectory(
        directory -> {
          File outside = Files.createTempFile("logbrew-rn-fatal-outside-", ".txt").toFile();
          try {
            writeBytes(outside, "outside sentinel".getBytes(StandardCharsets.UTF_8));
            File recordPath = new File(directory, FatalRecordStore.RECORD_FILE_NAME);
            Files.createSymbolicLink(recordPath.toPath(), outside.toPath());

            FatalRecordStore store = new FatalRecordStore(directory);
            assertStatus(
                "storage_error",
                store.write(record("evt_rn_fatal_symlink", "main.jsbundle")));
            assertEquals(
                "outside sentinel",
                new String(Files.readAllBytes(outside.toPath()), StandardCharsets.UTF_8));
            assertEquals(true, Files.isSymbolicLink(recordPath.toPath()));

            Files.delete(recordPath.toPath());
            assertStatus(
                "stored",
                store.write(record("evt_rn_fatal_private", "main.jsbundle")));
            Set<PosixFilePermission> permissions =
                Files.getPosixFilePermissions(recordPath.toPath());
            assertEquals(
                false,
                permissions.contains(PosixFilePermission.GROUP_READ)
                    || permissions.contains(PosixFilePermission.GROUP_WRITE)
                    || permissions.contains(PosixFilePermission.GROUP_EXECUTE)
                    || permissions.contains(PosixFilePermission.OTHERS_READ)
                    || permissions.contains(PosixFilePermission.OTHERS_WRITE)
                    || permissions.contains(PosixFilePermission.OTHERS_EXECUTE));
          } finally {
            if (!outside.delete() && outside.exists()) {
              throw new AssertionError("failed to remove outside test artifact");
            }
          }
        });
    passed += 1;
  }

  private static FatalRecordStore.Record record(String id, String filename) {
    return new FatalRecordStore.Record(
        1,
        id,
        "2026-07-25T12:00:00.000Z",
        "Error",
        Collections.singletonList(new FatalRecordStore.Frame(filename, 12, 34)),
        0,
        0);
  }

  private static void withDirectory(DirectoryTest test) throws Exception {
    File directory = Files.createTempDirectory("logbrew-rn-fatal-android-").toFile();
    try {
      test.run(directory);
    } finally {
      deleteRecursively(directory);
    }
  }

  private static void writeBytes(File file, byte[] bytes) throws Exception {
    try (FileOutputStream stream = new FileOutputStream(file)) {
      stream.write(bytes);
      stream.getFD().sync();
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

  private static void assertStatus(String expected, FatalRecordStore.Result result) {
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
