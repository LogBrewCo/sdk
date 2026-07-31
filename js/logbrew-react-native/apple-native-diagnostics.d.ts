type LogBrewAppleNativeDiagnosticsAuth =
  | { apiKey: string; clientKey?: never }
  | { clientKey: string; apiKey?: never };

export type LogBrewAppleNativeDiagnosticsConfiguration =
  LogBrewAppleNativeDiagnosticsAuth & {
    projectId: string;
    release: string;
    environment: string;
    service: string;
    /** Explicitly confirms LogBrew is the process's only native fatal-handler owner. */
    fatalHandlerOwnership: "logbrew";
    /** Enable app-hang capture with a threshold from 1 through 30 seconds. Omit to disable. */
    hangThresholdSeconds?: number;
    /** Event ingestion endpoint. Defaults to the hosted LogBrew endpoint. */
    endpoint?: string;
  };

export type LogBrewAppleNativeDiagnosticsStatus = Readonly<{
  status: "already_installed" | "installed" | "not_installed" | "ready";
  lifecycle: "failed" | "idle" | "installed" | "replaying" | "stopped" | "unknown";
  pending: number;
  acknowledged: number;
  discarded: number;
}>;

export type LogBrewAppleNativeDiagnosticsReplayResult = Readonly<{
  status: "replayed";
  attempted: number;
  acknowledged: number;
  discarded: number;
  pending: number;
}>;

export declare function installLogBrewAppleNativeDiagnostics(
  configuration: LogBrewAppleNativeDiagnosticsConfiguration
): LogBrewAppleNativeDiagnosticsStatus;

export declare function replayLogBrewAppleNativeDiagnostics(): Promise<
  LogBrewAppleNativeDiagnosticsReplayResult
>;

export declare function getLogBrewAppleNativeDiagnosticsStatus():
  LogBrewAppleNativeDiagnosticsStatus;

declare const defaultExport: {
  getLogBrewAppleNativeDiagnosticsStatus: typeof getLogBrewAppleNativeDiagnosticsStatus;
  installLogBrewAppleNativeDiagnostics: typeof installLogBrewAppleNativeDiagnostics;
  replayLogBrewAppleNativeDiagnostics: typeof replayLogBrewAppleNativeDiagnostics;
};

export default defaultExport;
