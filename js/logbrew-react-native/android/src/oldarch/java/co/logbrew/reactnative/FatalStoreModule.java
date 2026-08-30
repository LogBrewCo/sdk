package co.logbrew.reactnative;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;

final class FatalStoreModule extends ReactContextBaseJavaModule {
  private final FatalStoreModuleImpl implementation;

  FatalStoreModule(ReactApplicationContext context) {
    super(context);
    implementation = new FatalStoreModuleImpl(context);
  }

  @Override
  public String getName() {
    return FatalStoreModuleImpl.NAME;
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public String secureRandomHex(double length) {
    return implementation.secureRandomHex(length);
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public WritableMap loadEventRecords(String queueKey) {
    return implementation.loadEventRecords(queueKey);
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public WritableMap appendEventRecord(
      String queueKey, String serializedEvent, double eventBytes) {
    return implementation.appendEventRecord(queueKey, serializedEvent, eventBytes);
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public WritableMap acknowledgeEventRecords(String queueKey, double count) {
    return implementation.acknowledgeEventRecords(queueKey, count);
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public WritableMap purgeEventRecords(String queueKey) {
    return implementation.purgeEventRecords(queueKey);
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public WritableMap closeEventStore(String queueKey) {
    return implementation.closeEventStore(queueKey);
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public WritableMap installAndroidDiagnostics(ReadableMap configuration) {
    return implementation.installAndroidDiagnostics(configuration);
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public WritableMap androidDiagnosticsStatus() {
    return implementation.androidDiagnosticsStatus();
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  public WritableMap uninstallAndroidDiagnostics() {
    return implementation.uninstallAndroidDiagnostics();
  }
}
