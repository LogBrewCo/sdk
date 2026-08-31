package co.logbrew.reactnative;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;

final class FatalStoreModule extends NativeLogBrewFatalStoreSpec {
  private final FatalStoreModuleImpl implementation;

  FatalStoreModule(ReactApplicationContext context) {
    super(context);
    implementation = new FatalStoreModuleImpl(context);
  }

  @Override
  public String getName() {
    return FatalStoreModuleImpl.NAME;
  }

  @Override
  public String secureRandomHex(double length) {
    return implementation.secureRandomHex(length);
  }

  @Override
  public WritableMap loadEventRecords(String queueKey) {
    return implementation.loadEventRecords(queueKey);
  }

  @Override
  public WritableMap appendEventRecord(
      String queueKey, String serializedEvent, double eventBytes) {
    return implementation.appendEventRecord(queueKey, serializedEvent, eventBytes);
  }

  @Override
  public WritableMap acknowledgeEventRecords(String queueKey, double count) {
    return implementation.acknowledgeEventRecords(queueKey, count);
  }

  @Override
  public WritableMap purgeEventRecords(String queueKey) {
    return implementation.purgeEventRecords(queueKey);
  }

  @Override
  public WritableMap closeEventStore(String queueKey) {
    return implementation.closeEventStore(queueKey);
  }

  @Override
  public WritableMap installAndroidDiagnostics(ReadableMap configuration) {
    return implementation.installAndroidDiagnostics(configuration);
  }

  @Override
  public WritableMap androidDiagnosticsStatus() {
    return implementation.androidDiagnosticsStatus();
  }

  @Override
  public WritableMap uninstallAndroidDiagnostics() {
    return implementation.uninstallAndroidDiagnostics();
  }
}
