import type { CodegenTypes, TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  installNativeDiagnostics(
    configuration: CodegenTypes.UnsafeObject
  ): CodegenTypes.UnsafeObject;
  replayNativeDiagnostics(): Promise<CodegenTypes.UnsafeObject>;
  setNativeDiagnosticsContext(
    context: CodegenTypes.UnsafeObject | null
  ): CodegenTypes.UnsafeObject;
  nativeDiagnosticsStatus(): CodegenTypes.UnsafeObject;
}

export default TurboModuleRegistry.get<Spec>("LogBrewAppleDiagnostics");
