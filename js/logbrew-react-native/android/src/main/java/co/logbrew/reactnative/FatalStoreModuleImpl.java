package co.logbrew.reactnative;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import com.facebook.react.bridge.ReadableType;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class FatalStoreModuleImpl {
  static final String NAME = "LogBrewFatalStore";

  private static final Set<String> RECORD_KEYS =
      new HashSet<>(
          Arrays.asList(
              "schemaVersion",
              "id",
              "timestamp",
              "errorName",
              "stackFrames",
              "droppedRecords",
              "corruptRecords"));
  private static final Set<String> FRAME_KEYS =
      new HashSet<>(Arrays.asList("filename", "line", "column"));

  private final FatalRecordStore store;

  FatalStoreModuleImpl(ReactApplicationContext context) {
    File root = context.getNoBackupFilesDir();
    store =
        root == null
            ? null
            : new FatalRecordStore(
                new File(root, "logbrew-fatal-js"),
                new AndroidParentDirectorySync());
  }

  WritableMap writeFatalRecord(ReadableMap input) {
    if (store == null) {
      return status("storage_error");
    }
    try {
      FatalRecordStore.Record record = readRecord(input);
      return record == null ? status("invalid_record") : resultMap(store.write(record));
    } catch (RuntimeException error) {
      return status("storage_error");
    }
  }

  WritableMap readFatalRecord() {
    if (store == null) {
      return status("storage_error");
    }
    try {
      return resultMap(store.read());
    } catch (RuntimeException error) {
      return status("storage_error");
    }
  }

  WritableMap acknowledgeFatalRecord(String recordId) {
    if (store == null) {
      return status("storage_error");
    }
    try {
      return resultMap(store.acknowledge(recordId));
    } catch (RuntimeException error) {
      return status("storage_error");
    }
  }

  WritableMap discardFatalRecord() {
    if (store == null) {
      return status("storage_error");
    }
    try {
      return resultMap(store.discard());
    } catch (RuntimeException error) {
      return status("storage_error");
    }
  }

  private static FatalRecordStore.Record readRecord(ReadableMap input) {
    if (input == null
        || !hasExactKeys(input, RECORD_KEYS)
        || !hasType(input, "schemaVersion", ReadableType.Number)
        || !hasType(input, "id", ReadableType.String)
        || !hasType(input, "timestamp", ReadableType.String)
        || !hasType(input, "errorName", ReadableType.String)
        || !hasType(input, "stackFrames", ReadableType.Array)
        || !hasType(input, "droppedRecords", ReadableType.Number)
        || !hasType(input, "corruptRecords", ReadableType.Number)) {
      return null;
    }
    Integer schemaVersion = integer(input, "schemaVersion");
    Integer droppedRecords = integer(input, "droppedRecords");
    Integer corruptRecords = integer(input, "corruptRecords");
    if (schemaVersion == null || droppedRecords == null || corruptRecords == null) {
      return null;
    }

    ReadableArray values = input.getArray("stackFrames");
    if (values == null) {
      return null;
    }
    List<FatalRecordStore.Frame> frames = new ArrayList<>(values.size());
    for (int index = 0; index < values.size(); index += 1) {
      if (values.getType(index) != ReadableType.Map) {
        return null;
      }
      ReadableMap value = values.getMap(index);
      FatalRecordStore.Frame frame = readFrame(value);
      if (frame == null) {
        return null;
      }
      frames.add(frame);
    }
    return new FatalRecordStore.Record(
        schemaVersion,
        input.getString("id"),
        input.getString("timestamp"),
        input.getString("errorName"),
        frames,
        droppedRecords,
        corruptRecords);
  }

  private static FatalRecordStore.Frame readFrame(ReadableMap input) {
    if (input == null
        || !hasExactKeys(input, FRAME_KEYS)
        || !hasType(input, "filename", ReadableType.String)
        || !hasType(input, "line", ReadableType.Number)
        || !hasType(input, "column", ReadableType.Number)) {
      return null;
    }
    Integer line = integer(input, "line");
    Integer column = integer(input, "column");
    String filename = input.getString("filename");
    if (line == null || column == null || filename == null) {
      return null;
    }
    if (filename.startsWith("/")
        && filename.indexOf('/', 1) < 0
        && filename.length() > 1) {
      filename = filename.substring(1);
    }
    return new FatalRecordStore.Frame(filename, line, column);
  }

  private static boolean hasType(ReadableMap map, String key, ReadableType type) {
    return map.hasKey(key) && !map.isNull(key) && map.getType(key) == type;
  }

  private static boolean hasExactKeys(ReadableMap map, Set<String> expected) {
    Set<String> observed = new HashSet<>();
    ReadableMapKeySetIterator iterator = map.keySetIterator();
    while (iterator.hasNextKey()) {
      observed.add(iterator.nextKey());
    }
    return observed.equals(expected);
  }

  private static Integer integer(ReadableMap map, String key) {
    double value = map.getDouble(key);
    return Double.isFinite(value)
            && value >= 0
            && value <= Integer.MAX_VALUE
            && value == Math.rint(value)
        ? (int) value
        : null;
  }

  private static WritableMap resultMap(FatalRecordStore.Result result) {
    if (result == null || result.status == null) {
      return status("storage_error");
    }
    WritableMap output = status(result.status);
    if (result.recordId != null) {
      output.putString("recordId", result.recordId);
    }
    if (result.droppedRecords > 0) {
      output.putInt("droppedRecords", result.droppedRecords);
    }
    if (result.corruptRecords > 0) {
      output.putInt("corruptRecords", result.corruptRecords);
    }
    if (result.record != null) {
      output.putMap("record", recordMap(result.record));
    }
    return output;
  }

  private static WritableMap recordMap(FatalRecordStore.Record record) {
    WritableMap output = Arguments.createMap();
    output.putInt("schemaVersion", record.schemaVersion);
    output.putString("id", record.id);
    output.putString("timestamp", record.timestamp);
    output.putString("errorName", record.errorName);
    output.putArray("stackFrames", frameMaps(record.stackFrames));
    output.putInt("droppedRecords", record.droppedRecords);
    output.putInt("corruptRecords", record.corruptRecords);
    return output;
  }

  private static WritableArray frameMaps(List<FatalRecordStore.Frame> frames) {
    WritableArray output = Arguments.createArray();
    for (FatalRecordStore.Frame frame : frames) {
      WritableMap value = Arguments.createMap();
      value.putString("filename", frame.filename);
      value.putInt("line", frame.line);
      value.putInt("column", frame.column);
      output.pushMap(value);
    }
    return output;
  }

  private static WritableMap status(String value) {
    WritableMap output = Arguments.createMap();
    output.putString("status", value);
    return output;
  }
}
