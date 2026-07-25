package co.logbrew.reactnative;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.zip.CRC32;

final class FatalRecordStore {
  static final String RECORD_FILE_NAME = "fatal-js-v1.record";
  static final String TEMP_FILE_NAME = "fatal-js-v1.tmp";

  private static final int MAGIC = 0x4c425246;
  private static final int FILE_FORMAT_VERSION = 1;
  private static final int MAX_RECORD_BYTES = 16 * 1024;
  private static final int MAX_FRAMES = 24;
  private static final int MAX_FILENAME_BYTES = 512;
  private static final int MAX_ID_BYTES = 96;
  private static final int MAX_TIMESTAMP_BYTES = 35;
  private static final Pattern ID_PATTERN =
      Pattern.compile("^evt_rn_fatal_[a-z0-9]+(?:_[a-z0-9]+)*$");
  private static final Pattern TIMESTAMP_PATTERN =
      Pattern.compile(
          "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$");
  private static final Set<String> ERROR_NAMES =
      Collections.unmodifiableSet(
          new HashSet<>(
              Arrays.asList(
                  "Error",
                  "EvalError",
                  "RangeError",
                  "ReferenceError",
                  "SyntaxError",
                  "TypeError",
                  "URIError")));

  private final File directory;
  private final File recordFile;
  private final File temporaryFile;

  FatalRecordStore(File directory) {
    this.directory = resolveCanonicalParent(directory);
    this.recordFile = new File(this.directory, RECORD_FILE_NAME);
    this.temporaryFile = new File(this.directory, TEMP_FILE_NAME);
  }

  synchronized Result write(Record incoming) {
    Record validated = validateRecord(incoming, true);
    if (validated == null) {
      return Result.status("invalid_record");
    }
    if (!prepareDirectory()) {
      return Result.status("storage_error");
    }

    Result existing = readPrepared();
    if ("storage_error".equals(existing.status)) {
      return existing;
    }
    if ("pending".equals(existing.status)) {
      int dropped =
          existing.record.droppedRecords == Integer.MAX_VALUE
              ? Integer.MAX_VALUE
              : existing.record.droppedRecords + 1;
      Record preserved =
          existing.record.withCounters(dropped, existing.record.corruptRecords);
      if (!atomicWrite(preserved)) {
        return Result.status("storage_error");
      }
      return new Result(
          "dropped_pending", null, preserved.id, dropped, preserved.corruptRecords);
    }

    boolean recoveredCorruption = "corrupt_discarded".equals(existing.status);
    Record stored = validated.withCounters(0, recoveredCorruption ? 1 : 0);
    if (!atomicWrite(stored)) {
      return Result.status("storage_error");
    }
    return new Result(
        recoveredCorruption ? "stored_after_corruption" : "stored",
        null,
        stored.id,
        stored.droppedRecords,
        stored.corruptRecords);
  }

  synchronized Result read() {
    if (!prepareDirectory()) {
      return Result.status("storage_error");
    }
    return readPrepared();
  }

  synchronized Result acknowledge(String recordId) {
    if (!validIdentifier(recordId) || !prepareDirectory()) {
      return Result.status(validIdentifier(recordId) ? "storage_error" : "id_mismatch");
    }
    Result existing = readPrepared();
    if (!"pending".equals(existing.status)) {
      return existing;
    }
    if (!existing.record.id.equals(recordId)) {
      return new Result(
          "id_mismatch",
          null,
          existing.record.id,
          existing.record.droppedRecords,
          existing.record.corruptRecords);
    }
    if (!deleteRegularFile(recordFile) || !syncParentDirectory()) {
      return Result.status("storage_error");
    }
    return new Result(
        "acknowledged",
        null,
        recordId,
        existing.record.droppedRecords,
        existing.record.corruptRecords);
  }

  synchronized Result discard() {
    if (!prepareDirectory()) {
      return Result.status("storage_error");
    }
    Result existing = readPrepared();
    if (!"pending".equals(existing.status)) {
      return existing;
    }
    if (!deleteRegularFile(recordFile) || !syncParentDirectory()) {
      return Result.status("storage_error");
    }
    return new Result(
        "discarded",
        null,
        existing.record.id,
        existing.record.droppedRecords,
        existing.record.corruptRecords);
  }

  private Result readPrepared() {
    if (!removeStaleTemporaryFile()) {
      return Result.status("storage_error");
    }
    if (!recordFile.exists()) {
      return Result.status("empty");
    }
    if (!isSafeRegularFile(recordFile)) {
      return Result.status("storage_error");
    }
    if (recordFile.length() <= 0 || recordFile.length() > MAX_RECORD_BYTES) {
      return discardCorruptRecord();
    }

    byte[] bytes;
    try {
      bytes = readBounded(recordFile);
    } catch (IOException error) {
      return Result.status("storage_error");
    }
    if (bytes == null) {
      return discardCorruptRecord();
    }
    Record record = decode(bytes);
    if (record == null) {
      return discardCorruptRecord();
    }
    return new Result(
        "pending", record, record.id, record.droppedRecords, record.corruptRecords);
  }

  private Result discardCorruptRecord() {
    if (!deleteRegularFile(recordFile) || !syncParentDirectory()) {
      return Result.status("storage_error");
    }
    return new Result("corrupt_discarded", null, null, 0, 1);
  }

  private boolean prepareDirectory() {
    try {
      if (directory.exists()) {
        if (!directory.isDirectory()) {
          return false;
        }
        if (!isCanonicalPath(directory)) {
          return false;
        }
      } else if (!directory.mkdir()) {
        return false;
      }
      if (!makeDirectoryPrivate(directory)) {
        return false;
      }
      if (!isCanonicalPath(directory)) {
        return false;
      }
      return true;
    } catch (IOException | SecurityException error) {
      return false;
    }
  }

  private boolean removeStaleTemporaryFile() {
    if (!temporaryFile.exists()) {
      return true;
    }
    return isSafeRegularFile(temporaryFile) && temporaryFile.delete();
  }

  private boolean atomicWrite(Record record) {
    byte[] bytes = encode(record);
    if (bytes == null || bytes.length == 0 || bytes.length > MAX_RECORD_BYTES) {
      return false;
    }
    if (!removeStaleTemporaryFile()) {
      return false;
    }
    if (recordFile.exists() && !isSafeRegularFile(recordFile)) {
      return false;
    }

    boolean wrote = false;
    try {
      if (!temporaryFile.createNewFile() || !isSafeRegularFile(temporaryFile)) {
        return false;
      }
      if (!makeFilePrivate(temporaryFile)) {
        return false;
      }
      try (FileOutputStream output = new FileOutputStream(temporaryFile, false)) {
        output.write(bytes);
        output.flush();
        output.getFD().sync();
      }
      if (!makeFilePrivate(temporaryFile)) {
        return false;
      }
      if (!temporaryFile.renameTo(recordFile)) {
        return false;
      }
      if (!makeFilePrivate(recordFile) || !syncParentDirectory()) {
        return false;
      }
      wrote = true;
      return true;
    } catch (IOException | SecurityException error) {
      return false;
    } finally {
      if (!wrote && temporaryFile.exists() && isSafeRegularFile(temporaryFile)) {
        temporaryFile.delete();
      }
    }
  }

  private byte[] readBounded(File file) throws IOException {
    try (FileInputStream input = new FileInputStream(file);
        ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[1024];
      int total = 0;
      int count;
      while ((count = input.read(buffer)) != -1) {
        total += count;
        if (total > MAX_RECORD_BYTES) {
          return null;
        }
        output.write(buffer, 0, count);
      }
      return output.toByteArray();
    }
  }

  private byte[] encode(Record record) {
    try {
      ByteArrayOutputStream payloadBytes = new ByteArrayOutputStream();
      try (DataOutputStream payload = new DataOutputStream(payloadBytes)) {
        payload.writeInt(record.schemaVersion);
        writeString(payload, record.id);
        writeString(payload, record.timestamp);
        writeString(payload, record.errorName);
        payload.writeInt(record.stackFrames.size());
        for (Frame frame : record.stackFrames) {
          writeString(payload, frame.filename);
          payload.writeInt(frame.line);
          payload.writeInt(frame.column);
        }
        payload.writeInt(record.droppedRecords);
        payload.writeInt(record.corruptRecords);
      }
      byte[] rawPayload = payloadBytes.toByteArray();
      CRC32 checksum = new CRC32();
      checksum.update(rawPayload);

      ByteArrayOutputStream fileBytes = new ByteArrayOutputStream();
      try (DataOutputStream file = new DataOutputStream(fileBytes)) {
        file.writeInt(MAGIC);
        file.writeInt(FILE_FORMAT_VERSION);
        file.writeInt(rawPayload.length);
        file.write(rawPayload);
        file.writeLong(checksum.getValue());
      }
      return fileBytes.toByteArray();
    } catch (IOException impossible) {
      return null;
    }
  }

  private Record decode(byte[] bytes) {
    try (DataInputStream file = new DataInputStream(new ByteArrayInputStream(bytes))) {
      if (file.readInt() != MAGIC || file.readInt() != FILE_FORMAT_VERSION) {
        return null;
      }
      int payloadLength = file.readInt();
      if (payloadLength <= 0 || payloadLength > MAX_RECORD_BYTES - 20) {
        return null;
      }
      byte[] payload = new byte[payloadLength];
      file.readFully(payload);
      long expectedChecksum = file.readLong();
      if (file.read() != -1) {
        return null;
      }
      CRC32 checksum = new CRC32();
      checksum.update(payload);
      if (checksum.getValue() != expectedChecksum) {
        return null;
      }

      try (DataInputStream recordInput =
          new DataInputStream(new ByteArrayInputStream(payload))) {
        int schemaVersion = recordInput.readInt();
        String id = readString(recordInput, MAX_ID_BYTES);
        String timestamp = readString(recordInput, MAX_TIMESTAMP_BYTES);
        String errorName = readString(recordInput, 32);
        int frameCount = recordInput.readInt();
        if (frameCount < 0 || frameCount > MAX_FRAMES) {
          return null;
        }
        List<Frame> frames = new ArrayList<>(frameCount);
        for (int index = 0; index < frameCount; index += 1) {
          frames.add(
              new Frame(
                  readString(recordInput, MAX_FILENAME_BYTES),
                  recordInput.readInt(),
                  recordInput.readInt()));
        }
        int droppedRecords = recordInput.readInt();
        int corruptRecords = recordInput.readInt();
        if (recordInput.read() != -1) {
          return null;
        }
        return validateRecord(
            new Record(
                schemaVersion,
                id,
                timestamp,
                errorName,
                frames,
                droppedRecords,
                corruptRecords),
            false);
      }
    } catch (EOFException error) {
      return null;
    } catch (IOException | RuntimeException error) {
      return null;
    }
  }

  private static void writeString(DataOutputStream output, String value)
      throws IOException {
    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
    output.writeInt(bytes.length);
    output.write(bytes);
  }

  private static String readString(DataInputStream input, int maximumBytes)
      throws IOException {
    int length = input.readInt();
    if (length < 1 || length > maximumBytes) {
      throw new IOException("invalid bounded string");
    }
    byte[] bytes = new byte[length];
    input.readFully(bytes);
    String value = new String(bytes, StandardCharsets.UTF_8);
    if (!Arrays.equals(bytes, value.getBytes(StandardCharsets.UTF_8))) {
      throw new IOException("invalid UTF-8");
    }
    return value;
  }

  private static Record validateRecord(Record record, boolean requireZeroCounters) {
    if (record == null
        || record.schemaVersion != 1
        || !validIdentifier(record.id)
        || !validTimestamp(record.timestamp)
        || !ERROR_NAMES.contains(record.errorName)
        || record.stackFrames == null
        || record.stackFrames.size() > MAX_FRAMES
        || record.droppedRecords < 0
        || record.corruptRecords < 0
        || (requireZeroCounters
            && (record.droppedRecords != 0 || record.corruptRecords != 0))) {
      return null;
    }
    List<Frame> frames = new ArrayList<>(record.stackFrames.size());
    for (Frame frame : record.stackFrames) {
      if (frame == null
          || !validFilename(frame.filename)
          || frame.line < 1
          || frame.column < 1) {
        return null;
      }
      frames.add(new Frame(frame.filename, frame.line, frame.column));
    }
    return new Record(
        1,
        record.id,
        record.timestamp,
        record.errorName,
        frames,
        record.droppedRecords,
        record.corruptRecords);
  }

  private static boolean validIdentifier(String value) {
    return value != null
        && value.getBytes(StandardCharsets.UTF_8).length <= MAX_ID_BYTES
        && ID_PATTERN.matcher(value).matches();
  }

  private static boolean validTimestamp(String value) {
    if (value == null) {
      return false;
    }
    int bytes = value.getBytes(StandardCharsets.UTF_8).length;
    return bytes >= 20
        && bytes <= MAX_TIMESTAMP_BYTES
        && TIMESTAMP_PATTERN.matcher(value).matches();
  }

  private static boolean validFilename(String value) {
    if (value == null
        || value.isEmpty()
        || value.getBytes(StandardCharsets.UTF_8).length > MAX_FILENAME_BYTES
        || value.startsWith("/")
        || value.contains("\\")
        || value.contains("://")
        || value.contains("?")
        || value.contains("#")) {
      return false;
    }
    for (String component : value.split("/", -1)) {
      if ("..".equals(component)) {
        return false;
      }
    }
    for (int index = 0; index < value.length(); index += 1) {
      char character = value.charAt(index);
      if (character <= 31 || character == 127) {
        return false;
      }
    }
    return true;
  }

  private boolean deleteRegularFile(File file) {
    return file.exists() && isSafeRegularFile(file) && file.delete();
  }

  private boolean isSafeRegularFile(File file) {
    try {
      return file.isFile() && isCanonicalPath(file);
    } catch (IOException | SecurityException error) {
      return false;
    }
  }

  private boolean isCanonicalPath(File file) throws IOException {
    return file.getCanonicalFile().equals(file.getAbsoluteFile());
  }

  private static File resolveCanonicalParent(File value) {
    File absolute = value.getAbsoluteFile();
    File parent = absolute.getParentFile();
    if (parent == null) {
      return absolute;
    }
    try {
      return new File(parent.getCanonicalFile(), absolute.getName());
    } catch (IOException | SecurityException error) {
      return absolute;
    }
  }

  private boolean makeDirectoryPrivate(File value) {
    return value.setReadable(false, false)
        && value.setWritable(false, false)
        && value.setExecutable(false, false)
        && value.setReadable(true, true)
        && value.setWritable(true, true)
        && value.setExecutable(true, true);
  }

  private boolean makeFilePrivate(File value) {
    return value.setReadable(false, false)
        && value.setWritable(false, false)
        && value.setExecutable(false, false)
        && value.setReadable(true, true)
        && value.setWritable(true, true);
  }

  private boolean syncParentDirectory() {
    try {
      Class<?> constants = Class.forName("android.system.OsConstants");
      int flags =
          intField(constants, "O_RDONLY")
              | intField(constants, "O_DIRECTORY")
              | intField(constants, "O_CLOEXEC");
      Class<?> os = Class.forName("android.system.Os");
      Method open = os.getMethod("open", String.class, int.class, int.class);
      Method fsync = os.getMethod("fsync", FileDescriptor.class);
      Method close = os.getMethod("close", FileDescriptor.class);
      FileDescriptor descriptor =
          (FileDescriptor) open.invoke(null, directory.getAbsolutePath(), flags, 0);
      try {
        fsync.invoke(null, descriptor);
      } finally {
        close.invoke(null, descriptor);
      }
      return true;
    } catch (ClassNotFoundException unavailableOutsideAndroid) {
      return true;
    } catch (ReflectiveOperationException | RuntimeException error) {
      return false;
    }
  }

  private static int intField(Class<?> owner, String name)
      throws ReflectiveOperationException {
    Field field = owner.getField(name);
    return field.getInt(null);
  }

  static final class Frame {
    final String filename;
    final int line;
    final int column;

    Frame(String filename, int line, int column) {
      this.filename = filename;
      this.line = line;
      this.column = column;
    }
  }

  static final class Record {
    final int schemaVersion;
    final String id;
    final String timestamp;
    final String errorName;
    final List<Frame> stackFrames;
    final int droppedRecords;
    final int corruptRecords;

    Record(
        int schemaVersion,
        String id,
        String timestamp,
        String errorName,
        List<Frame> stackFrames,
        int droppedRecords,
        int corruptRecords) {
      this.schemaVersion = schemaVersion;
      this.id = id;
      this.timestamp = timestamp;
      this.errorName = errorName;
      this.stackFrames =
          stackFrames == null
              ? null
              : Collections.unmodifiableList(new ArrayList<>(stackFrames));
      this.droppedRecords = droppedRecords;
      this.corruptRecords = corruptRecords;
    }

    Record withCounters(int droppedRecords, int corruptRecords) {
      return new Record(
          schemaVersion,
          id,
          timestamp,
          errorName,
          stackFrames,
          droppedRecords,
          corruptRecords);
    }
  }

  static final class Result {
    final String status;
    final Record record;
    final String recordId;
    final int droppedRecords;
    final int corruptRecords;

    Result(
        String status,
        Record record,
        String recordId,
        int droppedRecords,
        int corruptRecords) {
      this.status = status;
      this.record = record;
      this.recordId = recordId;
      this.droppedRecords = droppedRecords;
      this.corruptRecords = corruptRecords;
    }

    static Result status(String status) {
      return new Result(status, null, null, 0, 0);
    }
  }
}
