import type { Metadata } from "@logbrew/sdk";
import type { ReactNativeTraceInput } from "./index.js";

type LogBrewNativeBridgeScope = {
  trace?: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    traceFlags: string;
    traceSampled: boolean;
  };
  metadata: Metadata;
};

type LogBrewNativeBridgeLike =
  | ((scope: LogBrewNativeBridgeScope | undefined) => void)
  | {
      setLogBrewScope?: (scope: LogBrewNativeBridgeScope) => void;
      syncLogBrewScope?: (scope: LogBrewNativeBridgeScope) => void;
      clearLogBrewScope?: () => void;
      clearLogBrewTraceContext?: () => void;
    };

type LogBrewNativeBridgeScopeInput = {
  logger?: string;
  metadata?: Metadata;
  screen?: string;
  sessionId?: string;
  source?: string;
  trace?: ReactNativeTraceInput;
};

type LogBrewAsyncNativeBridgeLike =
  | ((scope: LogBrewNativeBridgeScope | undefined) => void | PromiseLike<void>)
  | ({
      setLogBrewScope?: (scope: LogBrewNativeBridgeScope) => void | PromiseLike<void>;
      syncLogBrewScope?: (scope: LogBrewNativeBridgeScope) => void | PromiseLike<void>;
    } & (
      | { clearLogBrewScope: () => void | PromiseLike<void> }
      | { clearLogBrewTraceContext: () => void | PromiseLike<void> }
    ));

declare function createLogBrewNativeBridgeScope(
  input?: LogBrewNativeBridgeScopeInput
): LogBrewNativeBridgeScope;
declare function syncLogBrewNativeBridgeScope(
  nativeBridge: LogBrewNativeBridgeLike,
  input?: LogBrewNativeBridgeScopeInput
): LogBrewNativeBridgeScope;
declare function clearLogBrewNativeBridgeScope(
  nativeBridge: LogBrewNativeBridgeLike
): void;
declare function withLogBrewNativeBridgeScope<TResult>(
  nativeBridge: LogBrewNativeBridgeLike,
  operation: (scope: LogBrewNativeBridgeScope) => TResult
): TResult;
declare function withLogBrewNativeBridgeScope<TResult>(
  nativeBridge: LogBrewNativeBridgeLike,
  input: LogBrewNativeBridgeScopeInput,
  operation: (scope: LogBrewNativeBridgeScope) => TResult
): TResult;

/**
 * Serializes calls to this helper for the same adapter object or function.
 * Clears native scope before and after each callback, including rejection.
 * Snapshots input at enqueue time and awaits native setters and clear methods.
 * Allows 128 active or queued calls per adapter; excess calls reject with
 * native_scope_queue_full before input is snapshotted. Each scope permits at
 * most 64 metadata entries, including derived fields, and 8192 UTF-16 code
 * units in its JSON representation. Larger scopes reject with native_scope_too_large.
 * External scope writes and the synchronous helper do not share this queue.
 * Do not await another call on the same bridge from inside its callback.
 * An unsettled callback keeps its scope and queue slot. There is no timeout or
 * cancellation contract; queued callbacks wait until it settles and native scope is cleared.
 */
declare function withLogBrewNativeBridgeScopeAsync<TResult>(
  nativeBridge: LogBrewAsyncNativeBridgeLike,
  operation: (scope: LogBrewNativeBridgeScope) => TResult
): Promise<Awaited<TResult>>;
declare function withLogBrewNativeBridgeScopeAsync<TResult>(
  nativeBridge: LogBrewAsyncNativeBridgeLike,
  input: LogBrewNativeBridgeScopeInput,
  operation: (scope: LogBrewNativeBridgeScope) => TResult
): Promise<Awaited<TResult>>;

declare const defaultExport: {
  clearLogBrewNativeBridgeScope: typeof clearLogBrewNativeBridgeScope;
  createLogBrewNativeBridgeScope: typeof createLogBrewNativeBridgeScope;
  syncLogBrewNativeBridgeScope: typeof syncLogBrewNativeBridgeScope;
  withLogBrewNativeBridgeScope: typeof withLogBrewNativeBridgeScope;
  withLogBrewNativeBridgeScopeAsync: typeof withLogBrewNativeBridgeScopeAsync;
};

export type {
  LogBrewAsyncNativeBridgeLike,
  LogBrewNativeBridgeLike,
  LogBrewNativeBridgeScope,
  LogBrewNativeBridgeScopeInput
};
export {
  createLogBrewNativeBridgeScope,
  syncLogBrewNativeBridgeScope,
  clearLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScope,
  withLogBrewNativeBridgeScopeAsync
};
export default defaultExport;
