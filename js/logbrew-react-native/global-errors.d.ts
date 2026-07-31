import type { LogBrewClient } from "@logbrew/sdk";

export type ReactNativeGlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

export type ReactNativeErrorUtilsLike = {
  getGlobalHandler(): ReactNativeGlobalErrorHandler | undefined;
  setGlobalHandler(handler: ReactNativeGlobalErrorHandler | undefined): void;
};

export type ReactNativePromiseRejectionDiagnosticCode =
  | "promise_rejection_capture_failed"
  | "promise_rejection_configuration_invalid"
  | "promise_rejection_duplicate_suppressed"
  | "promise_rejection_handler_unavailable"
  | "promise_rejection_id_unavailable"
  | "promise_rejection_recursive_capture_suppressed"
  | "promise_rejection_tracker_installation_failed"
  | "promise_rejection_tracker_ownership_required"
  | "promise_rejection_tracker_unavailable"
  | "promise_rejection_tracking_evicted";

export type ReactNativePromiseRejectionDiagnostic = Readonly<{
  code: ReactNativePromiseRejectionDiagnosticCode;
}>;

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

export type ReactNativePromiseRejectionHealth = Readonly<{
  available: boolean;
  capturedEvents: number;
  evictedRejections: number;
  handledLaterEvents: number;
  lastOutcome:
    | "capture_failed"
    | "captured"
    | "captured_untracked"
    | "captured_with_eviction"
    | "duplicate_suppressed"
    | "handled_later"
    | "handled_unknown"
    | "idle"
    | "recursive_suppressed"
    | "unavailable";
  maxTrackedRejections: number;
  suppressedEvents: number;
  trackedRejections: number;
  unknownHandledEvents: number;
  untrackedEvents: number;
}>;

export type CreateLogBrewReactNativePromiseRejectionHandlersOptions = {
  client: Pick<LogBrewClient, "issue">;
  /**
   * Maximum number of safe runtime rejection identifiers retained for duplicate
   * suppression and later-handled health. Defaults to 128 and must be 1-1024.
   */
  maxTrackedRejections?: number;
  onDiagnostic?: (diagnostic: ReactNativePromiseRejectionDiagnostic) => void;
};

export type LogBrewReactNativePromiseRejectionHandlers = Readonly<{
  health(): ReactNativePromiseRejectionHealth;
  onHandled(runtimeRejectionId: unknown): void;
  onUnhandled(runtimeRejectionId: unknown, rejection?: unknown): void;
}>;

export type ReactNativePromiseRejectionTrackerLike = {
  enable(options: Readonly<{
    allRejections: true;
    onHandled(runtimeRejectionId: unknown): void;
    onUnhandled(runtimeRejectionId: unknown, rejection?: unknown): void;
  }>): void;
};

export type InstallLogBrewReactNativePromiseRejectionTrackerOptions = {
  client: Pick<LogBrewClient, "issue">;
  /**
   * Confirms that LogBrew may claim the runtime's single Promise rejection
   * tracker slot. Do not install another tracker owner at the same time.
   */
  takeOwnership: true;
  /**
   * Optional tracker seam. The React Native conditional export discovers the
   * active Hermes tracker when this is omitted.
   */
  tracker?: ReactNativePromiseRejectionTrackerLike;
  maxTrackedRejections?: number;
  onDiagnostic?: (diagnostic: ReactNativePromiseRejectionDiagnostic) => void;
};

export type ReactNativePromiseRejectionTrackerHealth = Readonly<{
  active: boolean;
  available: boolean;
  engine: "custom" | "hermes" | "unavailable";
  lastOutcome:
    | "deactivated"
    | "handler_unavailable"
    | "installation_failed"
    | "installed"
    | "ownership_required"
    | "tracker_unavailable";
  restoration: "deactivate_only";
}>;

export type LogBrewReactNativePromiseRejectionTrackerInstallation = Readonly<{
  /**
   * Stops LogBrew capture through the installed callbacks. Hermes does not
   * expose a previous-owner restoration API, so this cannot restore one.
   */
  deactivate(): boolean;
  health(): ReactNativePromiseRejectionTrackerHealth;
  rejectionHealth(): ReactNativePromiseRejectionHealth;
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
 * Create privacy-safe callbacks for a Promise rejection tracker owned by the app.
 *
 * The callbacks do not install or patch Promise, Hermes, JavaScriptCore, or globals.
 * Automatic reports never inspect or emit the rejection value or runtime identifier.
 * Tracking is bounded and suppresses duplicate callbacks only while an identifier is retained.
 */
export declare function createLogBrewReactNativePromiseRejectionHandlers(
  options: CreateLogBrewReactNativePromiseRejectionHandlersOptions
): LogBrewReactNativePromiseRejectionHandlers;

/**
 * Install privacy-safe automatic Promise rejection capture.
 *
 * Installation is opt-in because React Native runtimes expose one tracker slot.
 * The React Native conditional export discovers Hermes without replacing the
 * global Promise. Other runtimes can inject a compatible tracker explicitly.
 */
export declare function installLogBrewReactNativePromiseRejectionTracker(
  options: InstallLogBrewReactNativePromiseRejectionTrackerOptions
): LogBrewReactNativePromiseRejectionTrackerInstallation;

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
  createLogBrewReactNativePromiseRejectionHandlers: typeof createLogBrewReactNativePromiseRejectionHandlers;
  installLogBrewReactNativeGlobalErrorHandler: typeof installLogBrewReactNativeGlobalErrorHandler;
  installLogBrewReactNativePromiseRejectionTracker: typeof installLogBrewReactNativePromiseRejectionTracker;
};

export default logBrewReactNativeGlobalErrors;
