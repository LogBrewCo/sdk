import type { LogBrewClient } from "@logbrew/sdk";

export type ReactNativeGlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

export type ReactNativeErrorUtilsLike = {
  getGlobalHandler(): ReactNativeGlobalErrorHandler | undefined;
  setGlobalHandler(handler: ReactNativeGlobalErrorHandler | undefined): void;
};

export type ReactNativeGlobalErrorDiagnosticCode =
  | "capture_failed"
  | "duplicate_capture_suppressed"
  | "fatal_acknowledge_failed"
  | "fatal_capture_requires_sync_store"
  | "fatal_corrupt_record_discarded"
  | "fatal_discard_failed"
  | "fatal_record_dropped"
  | "fatal_replay_failed"
  | "fatal_replay_not_admitted"
  | "fatal_store_failed"
  | "handler_unavailable"
  | "recursive_capture_suppressed";

export type ReactNativeGlobalErrorDiagnostic = Readonly<{
  code: ReactNativeGlobalErrorDiagnosticCode;
}>;

export type ReactNativeGlobalErrorHealth = Readonly<{
  active: boolean;
  capturedEvents: number;
  lastOutcome:
    | "capture_failed"
    | "captured"
    | "duplicate_suppressed"
    | "fatal_stored"
    | "fatal_store_failed"
    | "fatal_unsupported"
    | "handler_replaced"
    | "idle"
    | "recursive_suppressed"
    | "remove_failed"
    | "removed"
    | "unavailable";
  suppressedEvents: number;
}>;

export type ReactNativeFatalRecord = Readonly<{
  corruptRecords: number;
  droppedRecords: number;
  errorName: string;
  id: string;
  schemaVersion: 1;
  stackFrames: ReadonlyArray<Readonly<{
    column: number;
    filename: string;
    line: number;
  }>>;
  timestamp: string;
}>;

export type ReactNativeFatalStoreResult = Readonly<{
  corruptRecords?: number;
  droppedRecords?: number;
  record?: ReactNativeFatalRecord;
  recordId?: string;
  status: string;
}>;

export type ReactNativeFatalStoreLike = {
  writeFatalRecord(record: ReactNativeFatalRecord): ReactNativeFatalStoreResult;
  readFatalRecord(): ReactNativeFatalStoreResult;
  acknowledgeFatalRecord(recordId: string): ReactNativeFatalStoreResult;
  discardFatalRecord(): ReactNativeFatalStoreResult;
};

export type ReactNativeFatalReplayHealth = Readonly<{
  acknowledgedRecords: number;
  available: boolean;
  corruptRecords: number;
  droppedRecords: number;
  lastOutcome:
    | "acknowledge_failed"
    | "acknowledged"
    | "corrupt_discarded"
    | "discard_failed"
    | "discarded"
    | "dropped_pending"
    | "empty"
    | "idle"
    | "replay_failed"
    | "replay_not_admitted"
    | "storage_error"
    | "stored"
    | "stored_after_corruption"
    | "unavailable";
  replayedRecords: number;
  storedRecords: number;
}>;

export type InstallLogBrewReactNativeGlobalErrorHandlerOptions = {
  client: Pick<LogBrewClient, "issue">
    & Partial<Pick<LogBrewClient, "droppedEvents" | "pendingEvents">>;
  errorUtils?: ReactNativeErrorUtilsLike;
  fatalStore?: ReactNativeFatalStoreLike;
  onDiagnostic?: (diagnostic: ReactNativeGlobalErrorDiagnostic) => void;
};

export type LogBrewReactNativeGlobalErrorHandlerInstallation = Readonly<{
  discardPendingFatalRecord(): boolean;
  fatalHealth(): ReactNativeFatalReplayHealth;
  health(): ReactNativeGlobalErrorHealth;
  remove(): boolean;
}>;

/**
 * Install reversible automatic capture for React Native global JavaScript errors.
 *
 * The React Native conditional export injects its synchronous native fatal store by default.
 * Direct Node ESM/CJS callers can inject a compatible store explicitly. Fatal replay is
 * stable-ID at-least-once and acknowledges only after observable local queue admission.
 * This helper does not claim local exactly-once delivery or install Promise rejection handling.
 */
export declare function installLogBrewReactNativeGlobalErrorHandler(
  options: InstallLogBrewReactNativeGlobalErrorHandlerOptions
): LogBrewReactNativeGlobalErrorHandlerInstallation;

declare const logBrewReactNativeGlobalErrors: {
  installLogBrewReactNativeGlobalErrorHandler: typeof installLogBrewReactNativeGlobalErrorHandler;
};

export default logBrewReactNativeGlobalErrors;
