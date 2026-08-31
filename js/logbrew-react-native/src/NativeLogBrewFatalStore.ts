import type { CodegenTypes, TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  secureRandomHex(length: number): string;
  loadEventRecords(queueKey: string): CodegenTypes.UnsafeObject;
  appendEventRecord(
    queueKey: string,
    serializedEvent: string,
    eventBytes: number
  ): CodegenTypes.UnsafeObject;
  acknowledgeEventRecords(queueKey: string, count: number): CodegenTypes.UnsafeObject;
  purgeEventRecords(queueKey: string): CodegenTypes.UnsafeObject;
  closeEventStore(queueKey: string): CodegenTypes.UnsafeObject;
  installAndroidDiagnostics(
    configuration: CodegenTypes.UnsafeObject
  ): CodegenTypes.UnsafeObject;
  androidDiagnosticsStatus(): CodegenTypes.UnsafeObject;
  uninstallAndroidDiagnostics(): CodegenTypes.UnsafeObject;
}

export default TurboModuleRegistry.getEnforcing<Spec>("LogBrewFatalStore");
