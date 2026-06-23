import type { LogBrewClient, Metadata } from "@logbrew/sdk";
import type {
  ReactNavigationContainerLike,
  ReactNativeAppStateLike,
  ReactNativePlatformLike,
  ReactNativeTraceContext,
  ReactNativeTraceInput,
  TracePropagationTarget
} from "./index.js";
import type { LogBrewNativeBridgeLike, LogBrewNativeBridgeScope, LogBrewNativeBridgeScopeInput } from "./native-bridge.js";
import type { ReactNativeResourceFetchOptions } from "./resource-fetch.js";

export type ReactNativeInstrumentationOptions<TInput = unknown, TInit = unknown, TResponse = unknown> = {
  appState?: ReactNativeAppStateLike;
  captureInitialLifecycleState?: boolean;
  captureInitialNavigationRoute?: boolean;
  fetchImpl?: ReactNativeResourceFetchOptions<TInput, TInit, TResponse>["fetchImpl"];
  globalObject?: ReactNativeGlobalObjectLike;
  includeRouteKey?: boolean;
  instrumentGlobalFetch?: boolean;
  logger?: string;
  metadata?: Metadata;
  nativeBridge?: LogBrewNativeBridgeLike;
  navigation?: ReactNavigationContainerLike;
  navigationContainer?: ReactNavigationContainerLike;
  now?: () => string;
  nowMs?: () => number;
  onError?: (error: unknown) => void;
  platform?: ReactNativePlatformLike;
  randomValues?: (length: number) => ArrayLike<number>;
  routeTemplate?: string;
  routeTemplateFactory?: ReactNativeResourceFetchOptions<TInput, TInit, TResponse>["routeTemplateFactory"];
  screen?: string;
  sessionId?: string;
  trace?: ReactNativeTraceInput;
  traceFlags?: string;
  tracePropagationTargets?: TracePropagationTarget[];
};

export type ReactNativeGlobalObjectLike = {
  fetch?: unknown;
};

export type ReactNativeGlobalFetchInstrumentation<TInput = unknown, TInit = unknown, TResponse = unknown> = {
  readonly fetch: (input: TInput, init?: TInit) => Promise<TResponse>;
  remove(): void;
  stop(): void;
};

export type ReactNativeInstrumentation<TInput = unknown, TInit = unknown, TResponse = unknown> = {
  readonly trace: ReactNativeTraceContext;
  readonly globalFetch?: ReactNativeGlobalFetchInstrumentation<TInput, TInit, TResponse>;
  readonly resourceFetch: (input: TInput, init?: TInit) => Promise<TResponse>;
  remove(): void;
  stop(): void;
  syncNativeBridgeScope(input?: LogBrewNativeBridgeScopeInput): LogBrewNativeBridgeScope | undefined;
  withNativeBridgeScope<TResult>(callback: (scope: LogBrewNativeBridgeScope) => TResult): TResult;
  withNativeBridgeScope<TResult>(
    input: LogBrewNativeBridgeScopeInput,
    callback: (scope: LogBrewNativeBridgeScope) => TResult
  ): TResult;
};

export declare function createLogBrewReactNativeInstrumentation<TInput = unknown, TInit = unknown, TResponse = unknown>(
  client: LogBrewClient,
  options?: ReactNativeInstrumentationOptions<TInput, TInit, TResponse>
): ReactNativeInstrumentation<TInput, TInit, TResponse>;

declare const defaultExport: {
  createLogBrewReactNativeInstrumentation: typeof createLogBrewReactNativeInstrumentation;
};

export default defaultExport;
