import type * as React from "react";
import type {
  ActionAttributes,
  EnvironmentAttributes,
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  Metadata,
  ReleaseAttributes,
  SpanAttributes,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type ReactNativePlatformLike = {
  OS?: string;
  Version?: string | number;
  isPad?: boolean;
  constants?: {
    isTesting?: boolean;
  };
};

export type ReactNativeAppStateLike = {
  currentState?: string | null;
  addEventListener?: (
    type: "change",
    listener: (state: string) => void
  ) => { remove(): void } | (() => void);
};

export type CreateLogBrewReactNativeClientConfig = {
  apiKey?: string;
  clientKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

export type ReactNativeTraceparentConfig = {
  traceId?: string;
  spanId?: string;
  traceFlags?: string;
  randomValues?: (length: number) => ArrayLike<number>;
};

export type ReactNativeTraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: string;
  sampled: boolean;
};

export type ReactNativeTraceInput = ReactNativeTraceContext | string;

export type ReactNativeTraceContextConfig = ReactNativeTraceparentConfig & {
  parentSpanId?: string;
  traceparent?: string;
};

export type ReactNativeSpanAttributesInput = {
  durationMs?: number;
  metadata?: Metadata;
  name?: string;
  spanId?: string;
  status?: SpanAttributes["status"];
  trace?: ReactNativeTraceInput;
};

export type TraceparentFetchLike<TResponse = unknown> = (
  input: any,
  init?: any
) => Promise<TResponse> | TResponse;

export type TraceparentFetchConfig<TResponse = unknown> = {
  fetchImpl?: TraceparentFetchLike<TResponse>;
  randomValues?: (length: number) => ArrayLike<number>;
  trace?: ReactNativeTraceInput;
  traceFlags?: string;
  traceparent?: string;
  traceparentFactory?: (context: {
    input: any;
    init?: any;
    url: string;
  }) => string | undefined;
  tracePropagationTargets?: TracePropagationTarget[];
};

export type ReactNativeContextOptions = {
  platform?: ReactNativePlatformLike;
  appState?: ReactNativeAppStateLike;
  metadata?: Metadata;
  trace?: ReactNativeTraceInput;
};

export type CaptureScreenViewOptions = ReactNativeContextOptions & {
  id?: string;
  timestamp?: string;
  status?: ActionAttributes["status"];
};

export type CaptureAppStateChangeOptions = ReactNativeContextOptions & {
  id?: string;
  timestamp?: string;
};

export type ReactNativeActionEvent = {
  id: string;
  timestamp: string;
  attributes: ActionAttributes;
};

export type ReactNativeActionInput = ReactNativeContextOptions & {
  id?: string;
  idFactory?: (context: ReactNativeActionIdFactoryContext) => string;
  name?: string;
  now?: () => string;
  screen?: string;
  sessionId?: string;
  status?: ActionAttributes["status"];
  timestamp?: string;
  traceId?: string;
};

export type ReactNativeActionIdFactoryContext = {
  name?: string;
  screen?: string;
};

export type ReactNativeNetworkInput = ReactNativeContextOptions & {
  durationMs?: number;
  id?: string;
  idFactory?: (context: ReactNativeNetworkIdFactoryContext) => string;
  method?: string;
  name?: string;
  now?: () => string;
  routeTemplate?: string;
  screen?: string;
  sessionId?: string;
  status?: ActionAttributes["status"];
  statusCode?: number;
  timestamp?: string;
  traceId?: string;
};

export type ReactNativeNetworkIdFactoryContext = {
  method?: string;
  routeTemplate?: string;
  screen?: string;
};

export type ReactNativeErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

export type ReactNativeErrorIdFactoryContext = {
  error: unknown;
  message: string;
  screen?: string;
};

export type CaptureReactNativeErrorOptions = ReactNativeContextOptions & {
  id?: string;
  idFactory?: (context: ReactNativeErrorIdFactoryContext) => string;
  includeStack?: boolean;
  level?: IssueAttributes["level"];
  now?: () => string;
  screen?: string;
  timestamp?: string;
};

export type LogBrewNativeProviderProps = {
  client: LogBrewClient;
  platform?: ReactNativePlatformLike;
  appState?: ReactNativeAppStateLike;
  trace?: ReactNativeTraceInput;
  children?: React.ReactNode;
};

export type LogBrewNativeContextValue = {
  client: LogBrewClient;
  platform?: ReactNativePlatformLike;
  appState?: ReactNativeAppStateLike;
  trace?: ReactNativeTraceContext;
};

export type LogBrewNativeActions = {
  release(id: string, timestamp: string, attributes: ReleaseAttributes): void;
  environment(id: string, timestamp: string, attributes: EnvironmentAttributes): void;
  issue(id: string, timestamp: string, attributes: IssueAttributes): void;
  log(id: string, timestamp: string, attributes: LogAttributes): void;
  span(id: string, timestamp: string, attributes: SpanAttributes): void;
  action(id: string, timestamp: string, attributes: ActionAttributes): void;
  flush(transport: Transport): Promise<TransportResponse>;
  shutdown(transport: Transport): Promise<TransportResponse>;
  previewJson(): string;
  pendingEvents(): number;
  trace?: ReactNativeTraceContext;
  captureScreenView(screenName: string, options?: CaptureScreenViewOptions): void;
  captureAppStateChange(state: string, options?: CaptureAppStateChangeOptions): void;
  captureReactNativeAction(input?: ReactNativeActionInput): ReactNativeActionEvent;
  captureReactNativeNetwork(input?: ReactNativeNetworkInput): ReactNativeActionEvent;
  captureReactNativeError(error: unknown, options?: CaptureReactNativeErrorOptions): ReactNativeErrorEvent;
};

export declare function createLogBrewReactNativeClient(
  config: CreateLogBrewReactNativeClientConfig
): LogBrewClient;
export declare function createReactNativeTraceparent(config?: ReactNativeTraceparentConfig): string;
export declare function createReactNativeTraceContext(
  config?: ReactNativeTraceContextConfig
): ReactNativeTraceContext;
export declare function getActiveLogBrewTrace(): ReactNativeTraceContext | undefined;
export declare function withLogBrewTrace<T>(
  trace: ReactNativeTraceInput | undefined,
  callback: (trace: ReactNativeTraceContext) => T
): T;
export declare function bindLogBrewTrace<TArgs extends unknown[], TResult>(
  trace: ReactNativeTraceInput | undefined,
  callback: (...args: TArgs) => TResult
): (...args: TArgs) => TResult;
export declare function getReactNativeTraceMetadata(trace?: ReactNativeTraceInput): Metadata;
export declare function createReactNativeSpanAttributes(
  input?: ReactNativeSpanAttributesInput
): SpanAttributes;
export declare function createReactNativeTraceHeaders(
  trace?: ReactNativeTraceInput
): { traceparent: string };
export declare function createTraceparentFetch<TResponse = unknown>(
  config?: TraceparentFetchConfig<TResponse>
): TraceparentFetchLike<TResponse>;
export declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: TracePropagationTarget[]
): boolean;
export declare function getReactNativeContext(options?: ReactNativeContextOptions): Metadata;
export declare function captureScreenView(
  client: LogBrewClient,
  screenName: string,
  options?: CaptureScreenViewOptions
): void;
export declare function captureAppStateChange(
  client: LogBrewClient,
  state: string,
  options?: CaptureAppStateChangeOptions
): void;
export declare function createReactNativeActionEvent(
  input?: ReactNativeActionInput
): ReactNativeActionEvent;
export declare function captureReactNativeAction(
  client: LogBrewClient,
  input?: ReactNativeActionInput
): ReactNativeActionEvent;
export declare function createReactNativeNetworkEvent(
  input?: ReactNativeNetworkInput
): ReactNativeActionEvent;
export declare function captureReactNativeNetwork(
  client: LogBrewClient,
  input?: ReactNativeNetworkInput
): ReactNativeActionEvent;
export declare function createReactNativeErrorEvent(
  error: unknown,
  options?: CaptureReactNativeErrorOptions
): ReactNativeErrorEvent;
export declare function captureReactNativeError(
  client: LogBrewClient,
  error: unknown,
  options?: CaptureReactNativeErrorOptions
): ReactNativeErrorEvent;
export declare function createAppStateListener(
  client: LogBrewClient,
  appState: ReactNativeAppStateLike,
  options?: CaptureAppStateChangeOptions
): () => void;
export declare function LogBrewNativeProvider(props: LogBrewNativeProviderProps): React.ReactElement;
export declare function useLogBrewNative(): LogBrewNativeContextValue;
export declare function useLogBrewNativeActions(): LogBrewNativeActions;

export declare function createDefaultLogBrewReactNativeClient(
  config: CreateLogBrewReactNativeClientConfig
): LogBrewClient;
export declare function getDefaultReactNativeContext(options?: { metadata?: Metadata }): Metadata;
export declare function captureDefaultScreenView(
  client: LogBrewClient,
  screenName: string,
  options?: Omit<CaptureScreenViewOptions, "platform" | "appState">
): void;
export declare function captureDefaultAppStateChange(
  client: LogBrewClient,
  state: string,
  options?: Omit<CaptureAppStateChangeOptions, "platform" | "appState">
): void;
export declare function captureDefaultReactNativeAction(
  client: LogBrewClient,
  input?: Omit<ReactNativeActionInput, "platform" | "appState">
): ReactNativeActionEvent;
export declare function captureDefaultReactNativeNetwork(
  client: LogBrewClient,
  input?: Omit<ReactNativeNetworkInput, "platform" | "appState">
): ReactNativeActionEvent;
export declare function captureDefaultReactNativeError(
  client: LogBrewClient,
  error: unknown,
  options?: Omit<CaptureReactNativeErrorOptions, "platform" | "appState">
): ReactNativeErrorEvent;
export declare function createDefaultAppStateListener(
  client: LogBrewClient,
  options?: Omit<CaptureAppStateChangeOptions, "appState">
): () => void;

declare const defaultExport: {
  LogBrewNativeProvider: typeof LogBrewNativeProvider;
  bindLogBrewTrace: typeof bindLogBrewTrace;
  captureAppStateChange: typeof captureAppStateChange;
  captureReactNativeAction: typeof captureReactNativeAction;
  captureReactNativeError: typeof captureReactNativeError;
  captureReactNativeNetwork: typeof captureReactNativeNetwork;
  captureScreenView: typeof captureScreenView;
  createAppStateListener: typeof createAppStateListener;
  createLogBrewReactNativeClient: typeof createLogBrewReactNativeClient;
  createReactNativeSpanAttributes: typeof createReactNativeSpanAttributes;
  createReactNativeTraceContext: typeof createReactNativeTraceContext;
  createReactNativeTraceHeaders: typeof createReactNativeTraceHeaders;
  createReactNativeActionEvent: typeof createReactNativeActionEvent;
  createReactNativeErrorEvent: typeof createReactNativeErrorEvent;
  createReactNativeNetworkEvent: typeof createReactNativeNetworkEvent;
  createReactNativeTraceparent: typeof createReactNativeTraceparent;
  createTraceparentFetch: typeof createTraceparentFetch;
  getActiveLogBrewTrace: typeof getActiveLogBrewTrace;
  getReactNativeContext: typeof getReactNativeContext;
  getReactNativeTraceMetadata: typeof getReactNativeTraceMetadata;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
  useLogBrewNative: typeof useLogBrewNative;
  useLogBrewNativeActions: typeof useLogBrewNativeActions;
  withLogBrewTrace: typeof withLogBrewTrace;
};

export default defaultExport;
