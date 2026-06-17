import type { Metadata } from "@logbrew/sdk";
import type { ReactNativeTraceInput } from "./index.js";

export type LogBrewNativeBridgeScope = {
  trace?: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    traceFlags: string;
    traceSampled: boolean;
  };
  metadata: Metadata;
};

export type LogBrewNativeBridgeLike =
  | ((scope: LogBrewNativeBridgeScope | undefined) => void)
  | {
      setLogBrewScope?: (scope: LogBrewNativeBridgeScope) => void;
      syncLogBrewScope?: (scope: LogBrewNativeBridgeScope) => void;
      clearLogBrewScope?: () => void;
      clearLogBrewTraceContext?: () => void;
    };

export type LogBrewNativeBridgeScopeInput = {
  logger?: string;
  metadata?: Metadata;
  screen?: string;
  sessionId?: string;
  source?: string;
  trace?: ReactNativeTraceInput;
};

export declare function createLogBrewNativeBridgeScope(
  input?: LogBrewNativeBridgeScopeInput
): LogBrewNativeBridgeScope;
export declare function syncLogBrewNativeBridgeScope(
  nativeBridge: LogBrewNativeBridgeLike,
  input?: LogBrewNativeBridgeScopeInput
): LogBrewNativeBridgeScope;
export declare function clearLogBrewNativeBridgeScope(
  nativeBridge: LogBrewNativeBridgeLike
): void;
export declare function withLogBrewNativeBridgeScope<TResult>(
  nativeBridge: LogBrewNativeBridgeLike,
  callback: (scope: LogBrewNativeBridgeScope) => TResult
): TResult;
export declare function withLogBrewNativeBridgeScope<TResult>(
  nativeBridge: LogBrewNativeBridgeLike,
  input: LogBrewNativeBridgeScopeInput,
  callback: (scope: LogBrewNativeBridgeScope) => TResult
): TResult;

declare const defaultExport: {
  clearLogBrewNativeBridgeScope: typeof clearLogBrewNativeBridgeScope;
  createLogBrewNativeBridgeScope: typeof createLogBrewNativeBridgeScope;
  syncLogBrewNativeBridgeScope: typeof syncLogBrewNativeBridgeScope;
  withLogBrewNativeBridgeScope: typeof withLogBrewNativeBridgeScope;
};

export default defaultExport;
