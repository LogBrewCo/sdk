import type { LogBrewClient, Metadata } from "@logbrew/sdk";
import type {
  LogBrewNativeBridgeLike,
  LogBrewNativeBridgeScope,
  LogBrewNativeBridgeScopeInput
} from "./native-bridge.js";
import type {
  ReactNativeAppStateLike,
  ReactNativePlatformLike,
  ReactNativeTraceContext,
  ReactNativeTraceInput,
  ReactNavigationContainerLike,
  TracePropagationTarget
} from "./index.js";
import type { ReactNativeResourceFetchOptions } from "./resource-fetch.js";

type ReactNativeInstrumentationOptions<TInput = unknown, TInit = unknown, TResponse = unknown> = {
  appState?: ReactNativeAppStateLike;
  captureInitialLifecycleState?: boolean;
  captureInitialNavigationRoute?: boolean;
  fetchImpl?: ReactNativeResourceFetchOptions<TInput, TInit, TResponse>["fetchImpl"];
  globalObject?: ReactNativeGlobalObjectLike;
  includeRouteKey?: boolean;
  instrumentGlobalFetch?: boolean;
  instrumentGlobalXMLHttpRequest?: boolean;
  logger?: string;
  measureFetchResponseBodySize?: boolean;
  measureXhrResponseBodySize?: boolean;
  metadata?: Metadata;
  metadataFactory?: ReactNativeResourceFetchOptions<TInput, TInit, TResponse>["metadataFactory"];
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

type ReactNativeGlobalObjectLike = {
  fetch?: unknown;
  XMLHttpRequest?: unknown;
};

type ReactNativeGlobalFetchInstrumentation<TInput = unknown, TInit = unknown, TResponse = unknown> = {
  readonly fetch: (input: TInput, init?: TInit) => Promise<TResponse>;
  remove(): void;
  stop(): void;
};

type ReactNativeGlobalXMLHttpRequestInstrumentation = {
  remove(): void;
  stop(): void;
};

type ReactNativeInstrumentation<TInput = unknown, TInit = unknown, TResponse = unknown> = {
  readonly trace: ReactNativeTraceContext;
  readonly globalFetch?: ReactNativeGlobalFetchInstrumentation<TInput, TInit, TResponse>;
  readonly globalXMLHttpRequest?: ReactNativeGlobalXMLHttpRequestInstrumentation;
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

declare function createLogBrewReactNativeInstrumentation<TInput = unknown, TInit = unknown, TResponse = unknown>(
  client: LogBrewClient,
  options?: ReactNativeInstrumentationOptions<TInput, TInit, TResponse>
): ReactNativeInstrumentation<TInput, TInit, TResponse>;

declare const defaultExport: {
  createLogBrewReactNativeInstrumentation: typeof createLogBrewReactNativeInstrumentation;
};

export type {
  ReactNativeGlobalFetchInstrumentation,
  ReactNativeGlobalObjectLike,
  ReactNativeGlobalXMLHttpRequestInstrumentation,
  ReactNativeInstrumentation,
  ReactNativeInstrumentationOptions
};
export {
  createLogBrewReactNativeInstrumentation
};
export default defaultExport;
