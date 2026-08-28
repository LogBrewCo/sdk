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
  public WritableMap writeFatalRecord(ReadableMap record) {
    return implementation.writeFatalRecord(record);
  }

  @Override
  public WritableMap readFatalRecord() {
    return implementation.readFatalRecord();
  }

  @Override
  public WritableMap acknowledgeFatalRecord(String recordId) {
    return implementation.acknowledgeFatalRecord(recordId);
  }

  @Override
  public WritableMap discardFatalRecord() {
    return implementation.discardFatalRecord();
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
}
