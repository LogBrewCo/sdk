package co.logbrew.reactnative;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import com.facebook.react.bridge.ReadableType;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

final class FatalStoreModuleImpl {
  static final String NAME = "LogBrewFatalStore";
  private static final SecureRandom SECURE_RANDOM = new SecureRandom();

  private static final Set<String> ANDROID_DIAGNOSTICS_KEYS =
      new HashSet<>(
          Arrays.asList(
              "anrThresholdMs",
              "clientKey",
              "environment",
              "fatalHandlerOwnership",
              "projectId",
              "release",
              "service"));

  private final File eventStoreParent;
  private final ReactApplicationContext context;
  private final Map<String, EventRecordStore> eventStores = new HashMap<>();
  private AndroidDiagnosticsRuntime androidDiagnostics;

  FatalStoreModuleImpl(ReactApplicationContext context) {
    this.context = context;
    File root = context.getNoBackupFilesDir();
    eventStoreParent = root;
  }

  String secureRandomHex(double length) {
    Integer byteCount = integer(length);
    if (byteCount == null || byteCount < 1 || byteCount > 64) {
      return "";
    }
    byte[] bytes = new byte[byteCount];
    SECURE_RANDOM.nextBytes(bytes);
    StringBuilder output = new StringBuilder(byteCount * 2);
    for (byte value : bytes) {
      output.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
    }
    return output.toString();
  }

  WritableMap loadEventRecords(String queueKey) {
    try {
      EventRecordStore eventStore = eventStore(queueKey);
      return eventStore == null ? status("storage_error") : eventResultMap(eventStore.load());
    } catch (RuntimeException error) {
      return status("storage_error");
    }
  }

  WritableMap appendEventRecord(String queueKey, String serializedEvent, double eventBytes) {
    try {
      EventRecordStore eventStore = eventStore(queueKey);
      Integer byteCount = integer(eventBytes);
      return eventStore == null || byteCount == null
          ? status("storage_error")
          : eventResultMap(eventStore.append(serializedEvent, byteCount));
    } catch (RuntimeException error) {
      return status("storage_error");
    }
  }

  WritableMap acknowledgeEventRecords(String queueKey, double count) {
    try {
      EventRecordStore eventStore = eventStore(queueKey);
      Integer recordCount = integer(count);
      return eventStore == null || recordCount == null
          ? status("storage_error")
          : eventResultMap(eventStore.acknowledge(recordCount));
    } catch (RuntimeException error) {
      return status("storage_error");
    }
  }

  WritableMap purgeEventRecords(String queueKey) {
    try {
      EventRecordStore eventStore = eventStore(queueKey);
      return eventStore == null ? status("storage_error") : eventResultMap(eventStore.purge());
    } catch (RuntimeException error) {
      return status("storage_error");
    }
  }

  synchronized WritableMap closeEventStore(String queueKey) {
    String queueHash = queueHash(queueKey);
    if (queueHash == null) {
      return status("storage_error");
    }
    EventRecordStore eventStore = eventStores.get(queueHash);
    if (eventStore == null) {
      return status("closed");
    }
    try {
      return eventResultMap(eventStore.close());
    } catch (RuntimeException error) {
      return status("storage_error");
    }
  }

  synchronized WritableMap installAndroidDiagnostics(ReadableMap input) {
    AndroidDiagnosticsInput configuration = readAndroidDiagnosticsInput(input);
    EventRecordStore eventStore =
        configuration == null ? null : eventStore(configuration.clientKey);
    String queueHash =
        configuration == null ? null : queueHash(configuration.clientKey);
    if (eventStore == null || queueHash == null || eventStoreParent == null) {
      return error("android_diagnostics_invalid_configuration");
    }
    if (androidDiagnostics != null && androidDiagnostics.installed()) {
      return androidDiagnostics.matches(eventStore, configuration.configuration)
          ? androidDiagnosticsReceipt("already_installed", androidDiagnostics.pending())
          : error("android_diagnostics_owned");
    }
    File storageRoot = new File(eventStoreParent, "logbrew-android-diagnostics-v1-" + queueHash);
    if ((!storageRoot.isDirectory() && !storageRoot.mkdirs()) || !storageRoot.isDirectory()) {
      return error("android_diagnostics_storage_failed");
    }
    try {
      androidDiagnostics =
          new AndroidDiagnosticsRuntime(
              context, storageRoot, eventStore, configuration.configuration);
      String statusValue = androidDiagnostics.install();
      return androidDiagnosticsResult(statusValue);
    } catch (RuntimeException error) {
      androidDiagnostics = null;
      return error("android_diagnostics_install_failed");
    }
  }

  synchronized WritableMap androidDiagnosticsStatus() {
    if (androidDiagnostics == null || !androidDiagnostics.installed()) {
      return androidDiagnosticsReceipt("not_installed", 0);
    }
    return androidDiagnosticsResult("ready");
  }

  synchronized WritableMap uninstallAndroidDiagnostics() {
    if (androidDiagnostics == null) {
      return androidDiagnosticsReceipt("not_installed", 0);
    }
    try {
      String statusValue = androidDiagnostics.uninstall();
      WritableMap result = androidDiagnosticsResult(statusValue);
      androidDiagnostics = null;
      return result;
    } catch (RuntimeException error) {
      return error("android_diagnostics_uninstall_failed");
    }
  }

  private static AndroidDiagnosticsInput readAndroidDiagnosticsInput(ReadableMap input) {
    if (input == null
        || !hasExactKeys(input, ANDROID_DIAGNOSTICS_KEYS)
        || !hasType(input, "anrThresholdMs", ReadableType.Number)
        || !hasType(input, "clientKey", ReadableType.String)
        || !hasType(input, "environment", ReadableType.String)
        || !hasType(input, "fatalHandlerOwnership", ReadableType.String)
        || !hasType(input, "projectId", ReadableType.String)
        || !hasType(input, "release", ReadableType.String)
        || !hasType(input, "service", ReadableType.String)
        || !"logbrew".equals(input.getString("fatalHandlerOwnership"))) {
      return null;
    }
    Integer threshold = integer(input, "anrThresholdMs");
    String clientKey = input.getString("clientKey");
    if (threshold == null || clientKey == null || clientKey.trim().isEmpty()) {
      return null;
    }
    try {
      return new AndroidDiagnosticsInput(
          clientKey,
          new AndroidNativeDiagnostics.Configuration(
              input.getString("projectId"),
              input.getString("release"),
              input.getString("environment"),
              input.getString("service"),
              android.os.Build.VERSION.RELEASE,
              android.os.Build.MODEL,
              androidArchitecture(),
              threshold));
    } catch (IllegalArgumentException error) {
      return null;
    }
  }

  private static boolean hasType(ReadableMap map, String key, ReadableType type) {
    return map.hasKey(key) && !map.isNull(key) && map.getType(key) == type;
  }

  private static String androidArchitecture() {
    String[] values = android.os.Process.is64Bit()
        ? android.os.Build.SUPPORTED_64_BIT_ABIS
        : android.os.Build.SUPPORTED_32_BIT_ABIS;
    String value = values.length == 0
        ? ""
        : values[0];
    return "arm64-v8a".equals(value)
        ? "arm64"
        : "armeabi-v7a".equals(value) ? "arm" : value;
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
    return integer(map.getDouble(key));
  }

  private static WritableMap status(String value) {
    WritableMap output = Arguments.createMap();
    output.putString("status", value);
    return output;
  }

  private static WritableMap androidDiagnosticsReceipt(String value, int pending) {
    WritableMap output = status(value);
    output.putInt("pending", pending);
    return output;
  }

  private WritableMap androidDiagnosticsResult(String status) {
    int pending = androidDiagnostics.pending();
    return pending < 0
        ? error("android_diagnostics_storage_failed")
        : androidDiagnosticsReceipt(status, pending);
  }

  private static WritableMap error(String code) {
    WritableMap output = status("error");
    output.putString("code", code);
    return output;
  }

  private synchronized EventRecordStore eventStore(String queueKey) {
    String queueHash = queueHash(queueKey);
    if (eventStoreParent == null || queueHash == null) {
      return null;
    }
    EventRecordStore existing = eventStores.get(queueHash);
    if (existing != null) {
      return existing;
    }
    EventRecordStore created =
        new EventRecordStore(
            new File(eventStoreParent, "logbrew-events-v1-" + queueHash),
            new AndroidParentDirectorySync());
    eventStores.put(queueHash, created);
    return created;
  }

  private static String queueHash(String queueKey) {
    if (queueKey == null || queueKey.trim().isEmpty()) {
      return null;
    }
    byte[] keyBytes = queueKey.getBytes(StandardCharsets.UTF_8);
    if (keyBytes.length == 0 || keyBytes.length > 4096) {
      return null;
    }
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(keyBytes);
      StringBuilder value = new StringBuilder(digest.length * 2);
      for (byte item : digest) {
        value.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
      }
      return value.toString();
    } catch (NoSuchAlgorithmException impossible) {
      return null;
    }
  }

  private static Integer integer(double value) {
    return Double.isFinite(value)
            && value >= 0
            && value <= Integer.MAX_VALUE
            && value == Math.rint(value)
        ? (int) value
        : null;
  }

  private static WritableMap eventResultMap(EventRecordStore.Result result) {
    WritableMap output = status(result.status);
    if ("loaded".equals(result.status)) {
      WritableArray records = Arguments.createArray();
      for (EventRecordStore.Record record : result.records) {
        WritableMap value = Arguments.createMap();
        value.putString("serializedEvent", record.serializedEvent);
        value.putInt("eventBytes", record.eventBytes);
        records.pushMap(value);
      }
      output.putArray("records", records);
    }
    return output;
  }

  private static final class AndroidDiagnosticsInput {
    final String clientKey;
    final AndroidNativeDiagnostics.Configuration configuration;

    AndroidDiagnosticsInput(
        String clientKey, AndroidNativeDiagnostics.Configuration configuration) {
      this.clientKey = clientKey;
      this.configuration = configuration;
    }
  }
}
