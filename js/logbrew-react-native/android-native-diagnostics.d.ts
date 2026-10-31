type LogBrewAndroidNativeDiagnosticsConfiguration = Readonly<{
  anrThresholdMs?: number;
  clientKey: string;
  environment: string;
  fatalHandlerOwnership: "logbrew";
  projectId: string;
  release: string;
  service: string;
}>;

type LogBrewAndroidNativeDiagnosticsReceipt = Readonly<{
  pending: number;
  status:
    | "already_installed"
    | "installed"
    | "not_installed"
    | "ready"
    | "uninstalled";
}>;

declare function installLogBrewAndroidNativeDiagnostics(
  configuration: LogBrewAndroidNativeDiagnosticsConfiguration
): LogBrewAndroidNativeDiagnosticsReceipt;

declare function getLogBrewAndroidNativeDiagnosticsStatus():
  LogBrewAndroidNativeDiagnosticsReceipt;

declare function uninstallLogBrewAndroidNativeDiagnostics():
  LogBrewAndroidNativeDiagnosticsReceipt;

export type {
  LogBrewAndroidNativeDiagnosticsConfiguration,
  LogBrewAndroidNativeDiagnosticsReceipt
};
export {
  installLogBrewAndroidNativeDiagnostics,
  getLogBrewAndroidNativeDiagnosticsStatus,
  uninstallLogBrewAndroidNativeDiagnostics
};
