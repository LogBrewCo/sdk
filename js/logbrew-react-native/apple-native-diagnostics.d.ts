import type { TelemetrySessionContext, TelemetrySubjectContext, TelemetryTraceContext } from "@logbrew/sdk";

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

export type LogBrewAppleNativeCrashContext = {
  schemaVersion: 1;
  trace?: TelemetryTraceContext;
  session?: TelemetrySessionContext;
  subject?: TelemetrySubjectContext;
  resource?: never;
  tags?: never;
};

export type LogBrewAppleNativeCrashContextResult = Readonly<{
  status: "cleared" | "updated";
}>;

export declare function installLogBrewAppleNativeDiagnostics(
  configuration: LogBrewAppleNativeDiagnosticsConfiguration
): LogBrewAppleNativeDiagnosticsStatus;

export declare function replayLogBrewAppleNativeDiagnostics(): Promise<
  LogBrewAppleNativeDiagnosticsReplayResult
>;

export declare function getLogBrewAppleNativeDiagnosticsStatus():
  LogBrewAppleNativeDiagnosticsStatus;

export declare function setLogBrewAppleNativeCrashContext(
  context: LogBrewAppleNativeCrashContext | null
): LogBrewAppleNativeCrashContextResult;

declare const defaultExport: {
  getLogBrewAppleNativeDiagnosticsStatus: typeof getLogBrewAppleNativeDiagnosticsStatus;
  installLogBrewAppleNativeDiagnostics: typeof installLogBrewAppleNativeDiagnostics;
  replayLogBrewAppleNativeDiagnostics: typeof replayLogBrewAppleNativeDiagnostics;
  setLogBrewAppleNativeCrashContext: typeof setLogBrewAppleNativeCrashContext;
};

export default defaultExport;
