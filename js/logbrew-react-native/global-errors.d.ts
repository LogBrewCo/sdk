import type { LogBrewClient } from "@logbrew/sdk";

export type ReactNativeGlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

export type ReactNativeErrorUtilsLike = {
  getGlobalHandler(): ReactNativeGlobalErrorHandler | undefined;
  setGlobalHandler(handler: ReactNativeGlobalErrorHandler | undefined): void;
};

export type ReactNativeGlobalErrorDiagnosticCode =
  | "capture_failed"
  | "duplicate_capture_suppressed"
  | "fatal_capture_requires_sync_store"
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
    | "fatal_unsupported"
    | "handler_replaced"
    | "idle"
    | "recursive_suppressed"
    | "remove_failed"
    | "removed"
    | "unavailable";
  suppressedEvents: number;
}>;

export type InstallLogBrewReactNativeGlobalErrorHandlerOptions = {
  client: Pick<LogBrewClient, "issue">;
  errorUtils?: ReactNativeErrorUtilsLike;
  onDiagnostic?: (diagnostic: ReactNativeGlobalErrorDiagnostic) => void;
};

export type LogBrewReactNativeGlobalErrorHandlerInstallation = Readonly<{
  health(): ReactNativeGlobalErrorHealth;
  remove(): boolean;
}>;

/**
 * Install reversible automatic capture for nonfatal React Native global JavaScript errors.
 *
 * Fatal errors are chained without capture until a synchronous native durable handoff is
 * available. This helper does not install Promise rejection handling.
 */
export declare function installLogBrewReactNativeGlobalErrorHandler(
  options: InstallLogBrewReactNativeGlobalErrorHandlerOptions
): LogBrewReactNativeGlobalErrorHandlerInstallation;

declare const logBrewReactNativeGlobalErrors: {
  installLogBrewReactNativeGlobalErrorHandler: typeof installLogBrewReactNativeGlobalErrorHandler;
};

export default logBrewReactNativeGlobalErrors;
