package co.logbrew.reactnative;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.CRC32;

/** Crash-safe app-private queue backing the synchronous React Native eventStore adapter. */
final class EventRecordStore {
  static final String EVENT_PREFIX = "event-";
  static final String EVENT_SUFFIX = ".record";
  static final String MARKER_PREFIX = "accepted-";
  static final String MARKER_SUFFIX = ".marker";

  private static final int RECORD_MAGIC = 0x4c425145;
  private static final int MARKER_MAGIC = 0x4c42514d;
  private static final int FILE_FORMAT_VERSION = 1;
  private static final int MAX_EVENT_BYTES = 4 * 1024 * 1024;
  private static final int MAX_QUEUE_BYTES = 4 * 1024 * 1024;
  private static final int MAX_QUEUE_RECORDS = 1000;
  private static final Pattern EVENT_PATTERN =
      Pattern.compile("^event-([0-9]{20})\\.record$");
  private static final Pattern MARKER_PATTERN =
      Pattern.compile("^accepted-([0-9]{20})\\.marker$");
  private static final ParentDirectorySync UNSUPPORTED_PARENT_DIRECTORY_SYNC =
      directory -> ParentDirectorySyncResult.UNSUPPORTED;

  private final File directory;
  private final ParentDirectorySync parentDirectorySync;
  private boolean poisoned;

  EventRecordStore(File directory) {
    this(directory, UNSUPPORTED_PARENT_DIRECTORY_SYNC);
  }

  EventRecordStore(
      File directory, ParentDirectorySync parentDirectorySync) {
    this.directory = resolveCanonicalParent(directory);
    this.parentDirectorySync = parentDirectorySync;
  }

  synchronized Result load() {
    Snapshot snapshot = snapshot();
    return snapshot == null
        ? Result.status("storage_error")
        : new Result("loaded", snapshot.records);
  }

  synchronized Result append(String serializedEvent, int eventBytes) {
    if (poisoned || !validEvent(serializedEvent, eventBytes)) {
      return Result.status("storage_error");
    }
    Snapshot snapshot = snapshot();
    if (snapshot == null
        || snapshot.records.size() >= MAX_QUEUE_RECORDS
        || snapshot.totalEventBytes + (long) eventBytes > MAX_QUEUE_BYTES) {
      return Result.status("storage_error");
    }
    long sequence = Math.max(snapshot.markerSequence, snapshot.maximumRecordSequence);
    if (sequence == Long.MAX_VALUE) {
      return Result.status("storage_error");
    }
    sequence += 1;
    File recordFile = new File(directory, eventFileName(sequence));
    if (!atomicWrite(recordFile, encodeRecord(sequence, serializedEvent, eventBytes))) {
      return Result.status("storage_error");
    }
    return Result.status("appended");
  }

  synchronized Result acknowledge(int count) {
    if (poisoned || count < 0) {
      return Result.status("storage_error");
    }
    Snapshot snapshot = snapshot();
    if (snapshot == null || count > snapshot.records.size()) {
      return Result.status("storage_error");
    }
    if (count == 0) {
      return Result.status("acknowledged");
    }
    long acceptedSequence = snapshot.records.get(count - 1).sequence;
    if (!commitMarker(acceptedSequence)) {
      return Result.status("storage_error");
    }
    removeAcceptedFiles(acceptedSequence);
    return Result.status("acknowledged");
  }

  synchronized Result purge() {
    if (poisoned || !prepareDirectory() || !removeStaleTemporaryFiles()) {
      return Result.status("storage_error");
    }
    File[] files = directory.listFiles();
    if (files == null) {
      return Result.status("storage_error");
    }
    long maximumSequence = 0;
    for (File file : files) {
      Matcher eventMatcher = EVENT_PATTERN.matcher(file.getName());
      Matcher markerMatcher = MARKER_PATTERN.matcher(file.getName());
      Matcher matcher = eventMatcher.matches() ? eventMatcher : markerMatcher.matches() ? markerMatcher : null;
      if (matcher == null || !isSafeRegularFile(file)) {
        return Result.status("storage_error");
      }
      Long sequence = parseSequence(matcher.group(1));
      if (sequence == null) {
        return Result.status("storage_error");
      }
      maximumSequence = Math.max(maximumSequence, sequence);
    }
    if (maximumSequence == 0) {
      return Result.status("purged");
    }
    if (maximumSequence == Long.MAX_VALUE) {
      return Result.status("storage_error");
    }
    long acceptedSequence = maximumSequence + 1;
    if (!commitMarker(acceptedSequence)) {
      return Result.status("storage_error");
    }
    removeAcceptedFiles(acceptedSequence);
    removeAllOlderMarkers(acceptedSequence);
    return Result.status("purged");
  }

  synchronized Result close() {
    return Result.status(poisoned ? "storage_error" : "closed");
  }

  private Snapshot snapshot() {
    if (poisoned || !prepareDirectory() || !removeStaleTemporaryFiles()) {
      return null;
    }
    File[] files = directory.listFiles();
    if (files == null) {
      return null;
    }

    long markerSequence = 0;
    List<FileSequence> eventFiles = new ArrayList<>();
    List<FileSequence> markerFiles = new ArrayList<>();
    for (File file : files) {
      String name = file.getName();
      Matcher eventMatcher = EVENT_PATTERN.matcher(name);
      Matcher markerMatcher = MARKER_PATTERN.matcher(name);
      if (eventMatcher.matches()) {
        Long sequence = parseSequence(eventMatcher.group(1));
        if (sequence == null || !isSafeRegularFile(file)) {
          return null;
        }
        eventFiles.add(new FileSequence(file, sequence));
      } else if (markerMatcher.matches()) {
        Long sequence = parseSequence(markerMatcher.group(1));
        if (sequence == null || !isSafeRegularFile(file)) {
          return null;
        }
        markerSequence = Math.max(markerSequence, sequence);
        markerFiles.add(new FileSequence(file, sequence));
      } else {
        return null;
      }
    }
    if (markerSequence > 0) {
      File newestMarker = new File(directory, markerFileName(markerSequence));
      if (!isSafeRegularFile(newestMarker) || !validMarker(newestMarker, markerSequence)) {
        return null;
      }
    }

    eventFiles.sort(Comparator.comparingLong(value -> value.sequence));
    List<Record> records = new ArrayList<>();
    long totalEventBytes = 0;
    long maximumRecordSequence = 0;
    for (FileSequence value : eventFiles) {
      maximumRecordSequence = Math.max(maximumRecordSequence, value.sequence);
      if (value.sequence <= markerSequence) {
        continue;
      }
      Record record = decodeRecord(value.file, value.sequence);
      if (record == null) {
        return null;
      }
      totalEventBytes += record.eventBytes;
      if (records.size() >= MAX_QUEUE_RECORDS || totalEventBytes > MAX_QUEUE_BYTES) {
        return null;
      }
      records.add(record);
    }

    removeAcceptedFiles(markerSequence);
    removeOldMarkers(markerFiles, markerSequence);
    return new Snapshot(
        markerSequence, maximumRecordSequence, totalEventBytes, records);
  }

  private boolean commitMarker(long sequence) {
    File marker = new File(directory, markerFileName(sequence));
    if (marker.exists()) {
      return isSafeRegularFile(marker) && validMarker(marker, sequence);
    }
    return atomicWrite(marker, encodeMarker(sequence));
  }

  private void removeAcceptedFiles(long markerSequence) {
    if (markerSequence <= 0) {
      return;
    }
    File[] files = directory.listFiles();
    if (files == null) {
      return;
    }
    boolean deleted = false;
    for (File file : files) {
      Matcher matcher = EVENT_PATTERN.matcher(file.getName());
      if (!matcher.matches()) {
        continue;
      }
      Long sequence = parseSequence(matcher.group(1));
      if (sequence != null
          && sequence <= markerSequence
          && isSafeRegularFile(file)
          && file.delete()) {
        deleted = true;
      }
    }
    if (deleted) {
      parentDirectorySync.sync(directory);
    }
  }

  private void removeOldMarkers(List<FileSequence> markers, long markerSequence) {
    boolean deleted = false;
    for (FileSequence marker : markers) {
      if (marker.sequence < markerSequence
          && isSafeRegularFile(marker.file)
          && marker.file.delete()) {
        deleted = true;
      }
    }
    if (deleted) {
      parentDirectorySync.sync(directory);
    }
  }

  private void removeAllOlderMarkers(long markerSequence) {
    File[] files = directory.listFiles();
    if (files == null) {
      return;
    }
    List<FileSequence> markers = new ArrayList<>();
    for (File file : files) {
      Matcher matcher = MARKER_PATTERN.matcher(file.getName());
      if (!matcher.matches()) {
        continue;
      }
      Long sequence = parseSequence(matcher.group(1));
      if (sequence != null) {
        markers.add(new FileSequence(file, sequence));
      }
    }
    removeOldMarkers(markers, markerSequence);
  }

  private boolean prepareDirectory() {
    try {
      if (directory.exists()) {
        if (!directory.isDirectory() || !isCanonicalPath(directory)) {
          return false;
        }
      } else if (!directory.mkdirs()) {
        return false;
      }
      return makeDirectoryPrivate(directory) && isCanonicalPath(directory);
    } catch (IOException | SecurityException error) {
      return false;
    }
  }

  private boolean removeStaleTemporaryFiles() {
    File[] files = directory.listFiles((unused, name) -> name.endsWith(".tmp"));
    if (files == null) {
      return false;
    }
    for (File file : files) {
      if (!isSafeRegularFile(file) || !file.delete()) {
        return false;
      }
    }
    return true;
  }

  private boolean atomicWrite(File destination, byte[] bytes) {
    if (bytes == null || bytes.length == 0 || destination.exists()) {
      return false;
    }
    File temporary = new File(directory, destination.getName() + ".tmp");
    if (temporary.exists()
        && (!isSafeRegularFile(temporary) || !temporary.delete())) {
      return false;
    }
    boolean committed = false;
    boolean renamed = false;
    try {
      if (!temporary.createNewFile()
          || !isSafeRegularFile(temporary)
          || !makeFilePrivate(temporary)) {
        return false;
      }
      try (FileOutputStream output = new FileOutputStream(temporary, false)) {
        output.write(bytes);
        output.flush();
        output.getFD().sync();
      }
      if (!makeFilePrivate(temporary) || !temporary.renameTo(destination)) {
        return false;
      }
      renamed = true;
      if (!makeFilePrivate(destination)) {
        return false;
      }
      if (parentDirectorySync.sync(directory)
          == ParentDirectorySyncResult.FAILED) {
        poisoned = true;
        return false;
      }
      committed = true;
      return true;
    } catch (IOException | SecurityException error) {
      return false;
    } finally {
      if (!committed) {
        if (renamed) {
          poisoned = true;
        } else if (temporary.exists() && isSafeRegularFile(temporary)) {
          temporary.delete();
        }
      }
    }
  }

  private static boolean validEvent(String serializedEvent, int eventBytes) {
    if (serializedEvent == null || serializedEvent.isEmpty() || eventBytes <= 0) {
      return false;
    }
    byte[] bytes = serializedEvent.getBytes(StandardCharsets.UTF_8);
    return bytes.length == eventBytes && bytes.length <= MAX_EVENT_BYTES;
  }

  private static byte[] encodeRecord(
      long sequence, String serializedEvent, int eventBytes) {
    byte[] payload = serializedEvent.getBytes(StandardCharsets.UTF_8);
    CRC32 checksum = new CRC32();
    checksum.update(payload);
    try {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream(payload.length + 32);
      try (DataOutputStream output = new DataOutputStream(bytes)) {
        output.writeInt(RECORD_MAGIC);
        output.writeInt(FILE_FORMAT_VERSION);
        output.writeLong(sequence);
        output.writeInt(eventBytes);
        output.writeInt(payload.length);
        output.write(payload);
        output.writeLong(checksum.getValue());
      }
      return bytes.toByteArray();
    } catch (IOException impossible) {
      return null;
    }
  }

  private static Record decodeRecord(File file, long expectedSequence) {
    if (file.length() <= 0 || file.length() > MAX_EVENT_BYTES + 32L) {
      return null;
    }
    byte[] bytes = readBounded(file, MAX_EVENT_BYTES + 32);
    if (bytes == null) {
      return null;
    }
    try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
      if (input.readInt() != RECORD_MAGIC || input.readInt() != FILE_FORMAT_VERSION) {
        return null;
      }
      long sequence = input.readLong();
      int eventBytes = input.readInt();
      int payloadLength = input.readInt();
      if (sequence != expectedSequence
          || eventBytes <= 0
          || payloadLength != eventBytes
          || payloadLength > MAX_EVENT_BYTES) {
        return null;
      }
      byte[] payload = new byte[payloadLength];
      input.readFully(payload);
      long expectedChecksum = input.readLong();
      if (input.read() != -1) {
        return null;
      }
      CRC32 checksum = new CRC32();
      checksum.update(payload);
      if (checksum.getValue() != expectedChecksum) {
        return null;
      }
      String serializedEvent = new String(payload, StandardCharsets.UTF_8);
      if (!validEvent(serializedEvent, eventBytes)) {
        return null;
      }
      return new Record(sequence, serializedEvent, eventBytes);
    } catch (IOException error) {
      return null;
    }
  }

  private static byte[] encodeMarker(long sequence) {
    CRC32 checksum = new CRC32();
    checksum.update(longBytes(sequence));
    try {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream(24);
      try (DataOutputStream output = new DataOutputStream(bytes)) {
        output.writeInt(MARKER_MAGIC);
        output.writeInt(FILE_FORMAT_VERSION);
        output.writeLong(sequence);
        output.writeLong(checksum.getValue());
      }
      return bytes.toByteArray();
    } catch (IOException impossible) {
      return null;
    }
  }

  private static boolean validMarker(File file, long expectedSequence) {
    byte[] bytes = readBounded(file, 24);
    if (bytes == null || bytes.length != 24) {
      return false;
    }
    try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
      if (input.readInt() != MARKER_MAGIC || input.readInt() != FILE_FORMAT_VERSION) {
        return false;
      }
      long sequence = input.readLong();
      long expectedChecksum = input.readLong();
      CRC32 checksum = new CRC32();
      checksum.update(longBytes(sequence));
      return sequence == expectedSequence
          && sequence > 0
          && checksum.getValue() == expectedChecksum
          && input.read() == -1;
    } catch (IOException error) {
      return false;
    }
  }

  private static byte[] longBytes(long value) {
    return new byte[] {
      (byte) (value >>> 56),
      (byte) (value >>> 48),
      (byte) (value >>> 40),
      (byte) (value >>> 32),
      (byte) (value >>> 24),
      (byte) (value >>> 16),
      (byte) (value >>> 8),
      (byte) value
    };
  }

  private static byte[] readBounded(File file, int maximumBytes) {
    try (FileInputStream input = new FileInputStream(file);
        ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int total = 0;
      int count;
      while ((count = input.read(buffer)) != -1) {
        total += count;
        if (total > maximumBytes) {
          return null;
        }
        output.write(buffer, 0, count);
      }
      return output.toByteArray();
    } catch (IOException error) {
      return null;
    }
  }

  private static String eventFileName(long sequence) {
    return String.format(java.util.Locale.ROOT, "%s%020d%s", EVENT_PREFIX, sequence, EVENT_SUFFIX);
  }

  private static String markerFileName(long sequence) {
    return String.format(
        java.util.Locale.ROOT, "%s%020d%s", MARKER_PREFIX, sequence, MARKER_SUFFIX);
  }

  private static Long parseSequence(String value) {
    try {
      long sequence = Long.parseLong(value);
      return sequence > 0 ? sequence : null;
    } catch (NumberFormatException error) {
      return null;
    }
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

  private static boolean isCanonicalPath(File value) throws IOException {
    return value.getCanonicalFile().equals(value.getAbsoluteFile());
  }

  private static boolean isSafeRegularFile(File value) {
    try {
      return value.isFile()
          && isCanonicalPath(value);
    } catch (IOException | SecurityException error) {
      return false;
    }
  }

  private static boolean makeDirectoryPrivate(File value) {
    return value.setReadable(false, false)
        && value.setWritable(false, false)
        && value.setExecutable(false, false)
        && value.setReadable(true, true)
        && value.setWritable(true, true)
        && value.setExecutable(true, true);
  }

  private static boolean makeFilePrivate(File value) {
    return value.setReadable(false, false)
        && value.setWritable(false, false)
        && value.setExecutable(false, false)
        && value.setReadable(true, true)
        && value.setWritable(true, true);
  }

  interface ParentDirectorySync {
    ParentDirectorySyncResult sync(File directory);
  }

  enum ParentDirectorySyncResult {
    SYNCHRONIZED,
    UNSUPPORTED,
    FAILED
  }

  static final class Record {
    final long sequence;
    final String serializedEvent;
    final int eventBytes;

    Record(long sequence, String serializedEvent, int eventBytes) {
      this.sequence = sequence;
      this.serializedEvent = serializedEvent;
      this.eventBytes = eventBytes;
    }
  }

  static final class Result {
    final String status;
    final List<Record> records;

    Result(String status, List<Record> records) {
      this.status = status;
      this.records = Collections.unmodifiableList(new ArrayList<>(records));
    }

    static Result status(String status) {
      return new Result(status, Collections.emptyList());
    }
  }

  private static final class Snapshot {
    final long markerSequence;
    final long maximumRecordSequence;
    final long totalEventBytes;
    final List<Record> records;

    Snapshot(
        long markerSequence,
        long maximumRecordSequence,
        long totalEventBytes,
        List<Record> records) {
      this.markerSequence = markerSequence;
      this.maximumRecordSequence = maximumRecordSequence;
      this.totalEventBytes = totalEventBytes;
      this.records = records;
    }
  }

  private static final class FileSequence {
    final File file;
    final long sequence;

    FileSequence(File file, long sequence) {
      this.file = file;
      this.sequence = sequence;
    }
  }
}
