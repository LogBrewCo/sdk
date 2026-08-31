export type LogBrewAndroidNativeDiagnosticsConfiguration = Readonly<{
  anrThresholdMs?: number;
  clientKey: string;
  environment: string;
  fatalHandlerOwnership: "logbrew";
  projectId: string;
  release: string;
  service: string;
}>;

export type LogBrewAndroidNativeDiagnosticsReceipt = Readonly<{
  pending: number;
  status:
    | "already_installed"
    | "installed"
    | "not_installed"
    | "ready"
    | "uninstalled";
}>;

export declare function installLogBrewAndroidNativeDiagnostics(
  configuration: LogBrewAndroidNativeDiagnosticsConfiguration
): LogBrewAndroidNativeDiagnosticsReceipt;

export declare function getLogBrewAndroidNativeDiagnosticsStatus():
  LogBrewAndroidNativeDiagnosticsReceipt;

export declare function uninstallLogBrewAndroidNativeDiagnostics():
  LogBrewAndroidNativeDiagnosticsReceipt;
