import type { CodegenTypes, TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  writeFatalRecord(record: CodegenTypes.UnsafeObject): CodegenTypes.UnsafeObject;
  readFatalRecord(): CodegenTypes.UnsafeObject;
  acknowledgeFatalRecord(recordId: string): CodegenTypes.UnsafeObject;
  discardFatalRecord(): CodegenTypes.UnsafeObject;
}

export default TurboModuleRegistry.getEnforcing<Spec>("LogBrewFatalStore");
