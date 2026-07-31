import type { CodegenTypes, TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  writeFatalRecord(record: CodegenTypes.UnsafeObject): CodegenTypes.UnsafeObject;
  readFatalRecord(): CodegenTypes.UnsafeObject;
  acknowledgeFatalRecord(recordId: string): CodegenTypes.UnsafeObject;
  discardFatalRecord(): CodegenTypes.UnsafeObject;
  loadEventRecords(queueKey: string): CodegenTypes.UnsafeObject;
  appendEventRecord(
    queueKey: string,
    serializedEvent: string,
    eventBytes: number
  ): CodegenTypes.UnsafeObject;
  acknowledgeEventRecords(queueKey: string, count: number): CodegenTypes.UnsafeObject;
  purgeEventRecords(queueKey: string): CodegenTypes.UnsafeObject;
  closeEventStore(queueKey: string): CodegenTypes.UnsafeObject;
}

export default TurboModuleRegistry.getEnforcing<Spec>("LogBrewFatalStore");
