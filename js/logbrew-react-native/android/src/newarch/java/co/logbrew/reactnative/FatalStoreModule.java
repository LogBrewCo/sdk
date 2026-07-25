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
}
