import type { ActionAttributes, IssueAttributes, Metadata, SpanAttributes } from "@logbrew/sdk";
import type { ReactNativeAppStateLike, ReactNativePlatformLike } from "./config.js";
import type { ReactNativeTraceInput } from "./trace.js";

type ReactNavigationRouteLike = {
  key?: string | number | null;
  name?: string | null;
  path?: string | null;
};

type ReactNavigationContainerLike = {
  current?: ReactNavigationContainerLike | null;
  addListener(
    eventName: string,
    listener: (event?: unknown) => void
  ): { remove(): void } | (() => void) | void;
  getCurrentRoute(): ReactNavigationRouteLike | undefined | null;
};

type ReactNativeContextOptions = {
  platform?: ReactNativePlatformLike;
  appState?: ReactNativeAppStateLike;
  metadata?: Metadata;
  trace?: ReactNativeTraceInput;
};

type CaptureScreenViewOptions = ReactNativeContextOptions & {
  id?: string;
  timestamp?: string;
  status?: ActionAttributes["status"];
};

type CaptureAppStateChangeOptions = ReactNativeContextOptions & {
  id?: string;
  timestamp?: string;
};

type CreateAppStateListenerOptions = CaptureAppStateChangeOptions & {
  /** Flush the configured client transport when AppState becomes inactive or background. */
  flushOnBackground?: boolean;
  /** Observe a background flush failure without throwing from the AppState callback. */
  onFlushError?: (error: unknown) => void;
};

type ReactNativeActionEvent = {
  id: string;
  timestamp: string;
  attributes: ActionAttributes;
};

type ReactNativeActionInput = ReactNativeContextOptions & {
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

type ReactNativeActionIdFactoryContext = {
  name?: string;
  screen?: string;
};

type ReactNativeNetworkInput = ReactNativeContextOptions & {
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

type ReactNativeNetworkIdFactoryContext = {
  method?: string;
  routeTemplate?: string;
  screen?: string;
};

type ReactNativeSpanEvent = {
  id: string;
  timestamp: string;
  attributes: SpanAttributes;
};

type ReactNativeNavigationSpanInput = ReactNativeContextOptions & {
  actionType?: string;
  durationMs?: number;
  id?: string;
  idFactory?: (context: ReactNativeNavigationSpanIdFactoryContext) => string;
  includeRouteKey?: boolean;
  name?: string;
  now?: () => string;
  previousRouteKey?: string | number | null;
  previousRouteName?: string;
  routeKey?: string | number | null;
  routeName?: string;
  routePath?: string;
  screen?: string;
  status?: SpanAttributes["status"];
  timestamp?: string;
};

type ReactNativeNavigationSpanIdFactoryContext = {
  routeName?: string;
  routePath?: string;
  screen?: string;
};

type ReactNativeResourceSpanInput = ReactNativeContextOptions & {
  durationMs?: number;
  id?: string;
  idFactory?: (context: ReactNativeResourceSpanIdFactoryContext) => string;
  kind?: string;
  method?: string;
  name?: string;
  now?: () => string;
  responseSizeBytes?: number;
  routeTemplate?: string;
  screen?: string;
  sessionId?: string;
  status?: SpanAttributes["status"];
  statusCode?: number;
  timestamp?: string;
};

type ReactNativeResourceSpanIdFactoryContext = {
  method?: string;
  routeTemplate?: string;
  screen?: string;
};

type ReactNavigationSpanListenerOptions = ReactNativeContextOptions & {
  captureInitialRoute?: boolean;
  includeRouteKey?: boolean;
  now?: () => string;
  nowMs?: () => number;
  onError?: (error: unknown) => void;
};

type ReactNativeErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

type ReactNativeErrorIdFactoryContext = {
  error: unknown;
  message: string;
  screen?: string;
};

type CaptureReactNativeErrorOptions = ReactNativeContextOptions & {
  debugIdMap?: Record<string, string>;
  evidence?: IssueAttributes["evidence"];
  environment?: string;
  fingerprint?: string;
  handled?: boolean;
  id?: string;
  idFactory?: (context: ReactNativeErrorIdFactoryContext) => string;
  includeStack?: boolean;
  level?: IssueAttributes["level"];
  mechanism?: string;
  now?: () => string;
  release?: string;
  runtime?: string;
  screen?: string;
  service?: string;
  timestamp?: string;
};

export type {
  CaptureAppStateChangeOptions,
  CaptureReactNativeErrorOptions,
  CaptureScreenViewOptions,
  CreateAppStateListenerOptions,
  ReactNativeActionEvent,
  ReactNativeActionIdFactoryContext,
  ReactNativeActionInput,
  ReactNativeContextOptions,
  ReactNativeErrorEvent,
  ReactNativeErrorIdFactoryContext,
  ReactNativeNavigationSpanIdFactoryContext,
  ReactNativeNavigationSpanInput,
  ReactNativeNetworkIdFactoryContext,
  ReactNativeNetworkInput,
  ReactNativeResourceSpanIdFactoryContext,
  ReactNativeResourceSpanInput,
  ReactNativeSpanEvent,
  ReactNavigationContainerLike,
  ReactNavigationRouteLike,
  ReactNavigationSpanListenerOptions
};
