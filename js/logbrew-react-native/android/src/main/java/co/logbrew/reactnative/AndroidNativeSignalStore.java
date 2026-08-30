package co.logbrew.reactnative;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.regex.Pattern;
import java.util.zip.CRC32;

final class AndroidNativeSignalStore {
  static final int MAGIC = 0x4c424e53;
  static final int VERSION = 1;
  static final int ID_BYTES = 96;
  static final int UUID_BYTES = 36;
  static final int ARCH_BYTES = 16;
  static final int OFFSET_BYTES = 16;
  static final int PROJECT_BYTES = 36 * 2;
  static final int RELEASE_BYTES = 256 * 2;
  static final int ENVIRONMENT_BYTES = 128 * 2;
  static final int SERVICE_BYTES = 128 * 2;
  static final int RECORD_BYTES =
      4 + 4 + 4 + 8 + ID_BYTES + UUID_BYTES + ARCH_BYTES + OFFSET_BYTES
          + PROJECT_BYTES + RELEASE_BYTES + ENVIRONMENT_BYTES + SERVICE_BYTES + 4;

  private static final Pattern ID = Pattern.compile("^evt_android_native_[a-z0-9_]{1,76}$");
  private static final Pattern UUID =
      Pattern.compile("^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$");
  private static final Pattern OFFSET = Pattern.compile("^[0-9a-f]{16}$");
  private static final Pattern ARCHITECTURE = Pattern.compile("^(?:arm|arm64|x86|x86_64)$");

  private final File file;

  AndroidNativeSignalStore(File file) {
    this.file = canonicalFile(file);
  }

  synchronized Record read() {
    if (!safeRegularFile(file) || file.length() != RECORD_BYTES) {
      discardInvalid();
      return null;
    }
    byte[] bytes = new byte[RECORD_BYTES];
    try (FileInputStream stream = new FileInputStream(file)) {
      if (stream.read(bytes) != RECORD_BYTES || stream.read() != -1) {
        discardInvalid();
        return null;
      }
    } catch (Exception error) {
      return null;
    }
    ByteBuffer input = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    if (input.getInt() != MAGIC || input.getInt() != VERSION) {
      discardInvalid();
      return null;
    }
    int signal = input.getInt();
    long timestampMs = input.getLong();
    String id = ascii(input, ID_BYTES);
    String imageUuid = ascii(input, UUID_BYTES);
    String architecture = ascii(input, ARCH_BYTES);
    String instructionOffset = ascii(input, OFFSET_BYTES);
    String projectId = utf16(input, PROJECT_BYTES);
    String release = utf16(input, RELEASE_BYTES);
    String environment = utf16(input, ENVIRONMENT_BYTES);
    String service = utf16(input, SERVICE_BYTES);
    long expectedChecksum = Integer.toUnsignedLong(input.getInt());
    CRC32 checksum = new CRC32();
    checksum.update(bytes, 0, RECORD_BYTES - 4);
    if (expectedChecksum != checksum.getValue()
        || signal <= 0
        || timestampMs <= 0
        || !ID.matcher(id).matches()
        || !UUID.matcher(imageUuid).matches()
        || !ARCHITECTURE.matcher(architecture).matches()
        || !OFFSET.matcher(instructionOffset).matches()
        || !UUID.matcher(projectId).matches()
        || !bounded(release, 256)
        || !bounded(environment, 128)
        || !bounded(service, 128)) {
      discardInvalid();
      return null;
    }
    return new Record(
        id,
        signal,
        timestampMs,
        imageUuid,
        architecture,
        instructionOffset,
        projectId,
        release,
        environment,
        service);
  }

  synchronized boolean prepare(EventRecordStore.ParentDirectorySync parentSync) {
    if (file.exists()) {
      if (!safeRegularFile(file)) {
        return false;
      }
      read();
      if (file.exists()) {
        return false;
      }
    }
    try (FileOutputStream output = new FileOutputStream(file, false)) {
      output.write(new byte[RECORD_BYTES]);
      output.getFD().sync();
      return parentSync.sync(file.getParentFile())
          != EventRecordStore.ParentDirectorySyncResult.FAILED;
    } catch (Exception error) {
      return false;
    }
  }

  synchronized boolean clear() {
    return !file.exists() || (safeRegularFile(file) && file.delete());
  }

  String path() {
    return file.getAbsolutePath();
  }

  private void discardInvalid() {
    if (safeRegularFile(file)) {
      file.delete();
    }
  }

  private static File canonicalFile(File candidate) {
    try {
      File parent = candidate.getParentFile();
      return parent == null
          ? candidate.getCanonicalFile()
          : new File(parent.getCanonicalFile(), candidate.getName());
    } catch (Exception error) {
      return candidate.getAbsoluteFile();
    }
  }

  private static boolean safeRegularFile(File candidate) {
    try {
      return candidate.exists()
          && candidate.isFile()
          && !java.nio.file.Files.isSymbolicLink(candidate.toPath())
          && candidate.getCanonicalFile().equals(candidate.getAbsoluteFile());
    } catch (Exception error) {
      return false;
    }
  }

  private static String ascii(ByteBuffer input, int width) {
    byte[] bytes = new byte[width];
    input.get(bytes);
    int end = 0;
    while (end < bytes.length && bytes[end] != 0) {
      if (bytes[end] < 0x20 || bytes[end] > 0x7e) {
        return "";
      }
      end += 1;
    }
    for (int index = end; index < bytes.length; index += 1) {
      if (bytes[index] != 0) {
        return "";
      }
    }
    return new String(Arrays.copyOf(bytes, end), StandardCharsets.US_ASCII);
  }

  private static String utf16(ByteBuffer input, int bytes) {
    char[] value = new char[bytes / 2];
    int end = 0;
    boolean terminated = false;
    for (int index = 0; index < value.length; index += 1) {
      char character = input.getChar();
      if (character == 0) {
        terminated = true;
      } else if (terminated) {
        return "";
      } else {
        value[end++] = character;
      }
    }
    return new String(value, 0, end);
  }

  private static boolean bounded(String value, int maximum) {
    return !value.isEmpty()
        && value.length() <= maximum
        && value.equals(value.trim())
        && value.chars().noneMatch(
            character -> character <= 31 || character >= 127 && character <= 159);
  }

  static final class Record {
    final String id;
    final int signal;
    final long timestampMs;
    final String imageUuid;
    final String architecture;
    final String instructionOffset;
    final String projectId;
    final String release;
    final String environment;
    final String service;

    Record(
        String id,
        int signal,
        long timestampMs,
        String imageUuid,
        String architecture,
        String instructionOffset,
        String projectId,
        String release,
        String environment,
        String service) {
      this.id = id;
      this.signal = signal;
      this.timestampMs = timestampMs;
      this.imageUuid = imageUuid;
      this.architecture = architecture;
      this.instructionOffset = instructionOffset;
      this.projectId = projectId;
      this.release = release;
      this.environment = environment;
      this.service = service;
    }
  }
}
