import type {
  TelemetrySessionContext,
  TelemetrySubjectContext,
  TelemetryTraceContext
} from "@logbrew/sdk";

type LogBrewAppleNativeDiagnosticsAuth =
  | { apiKey: string; clientKey?: never }
  | { clientKey: string; apiKey?: never };

type LogBrewAppleNativeDiagnosticsConfiguration =
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

type LogBrewAppleNativeDiagnosticsStatus = Readonly<{
  status: "already_installed" | "installed" | "not_installed" | "ready";
  lifecycle: "failed" | "idle" | "installed" | "replaying" | "stopped" | "unknown";
  pending: number;
  acknowledged: number;
  discarded: number;
}>;

type LogBrewAppleNativeDiagnosticsReplayResult = Readonly<{
  status: "replayed";
  attempted: number;
  acknowledged: number;
  discarded: number;
  pending: number;
}>;

declare const CRASH_CONTEXT_SCHEMA_VERSION = 1;

type LogBrewAppleNativeCrashContext = {
  schemaVersion: typeof CRASH_CONTEXT_SCHEMA_VERSION;
  /** App-reported failed action and optional user-visible result. Never include raw input or identity. */
  impact?: {
    failedAction: string;
    userVisibleOutcome?: string;
  };
  trace?: TelemetryTraceContext;
  session?: TelemetrySessionContext;
  subject?: TelemetrySubjectContext;
  resource?: never;
  tags?: never;
};

type LogBrewAppleNativeCrashContextResult = Readonly<{
  status: "cleared" | "updated";
}>;

declare function installLogBrewAppleNativeDiagnostics(
  configuration: LogBrewAppleNativeDiagnosticsConfiguration
): LogBrewAppleNativeDiagnosticsStatus;

declare function replayLogBrewAppleNativeDiagnostics(): Promise<
  LogBrewAppleNativeDiagnosticsReplayResult
>;

declare function getLogBrewAppleNativeDiagnosticsStatus():
  LogBrewAppleNativeDiagnosticsStatus;

declare function setLogBrewAppleNativeCrashContext(
  context: LogBrewAppleNativeCrashContext | null
): LogBrewAppleNativeCrashContextResult;

declare const defaultExport: {
  getLogBrewAppleNativeDiagnosticsStatus: typeof getLogBrewAppleNativeDiagnosticsStatus;
  installLogBrewAppleNativeDiagnostics: typeof installLogBrewAppleNativeDiagnostics;
  replayLogBrewAppleNativeDiagnostics: typeof replayLogBrewAppleNativeDiagnostics;
  setLogBrewAppleNativeCrashContext: typeof setLogBrewAppleNativeCrashContext;
};

export type {
  LogBrewAppleNativeCrashContext,
  LogBrewAppleNativeCrashContextResult,
  LogBrewAppleNativeDiagnosticsConfiguration,
  LogBrewAppleNativeDiagnosticsReplayResult,
  LogBrewAppleNativeDiagnosticsStatus
};
export {
  installLogBrewAppleNativeDiagnostics,
  replayLogBrewAppleNativeDiagnostics,
  getLogBrewAppleNativeDiagnosticsStatus,
  setLogBrewAppleNativeCrashContext
};
export default defaultExport;
