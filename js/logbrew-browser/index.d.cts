import type {
  ActionAttributes,
  DroppedEvent,
  IssueAttributes,
  LogBrewClient,
  Metadata,
  SpanAttributes,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewBrowserClientConfig = {
  apiKey?: string;
  clientKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
  maxQueueSize?: number;
  onEventDropped?: (drop: DroppedEvent) => void;
};

export type FetchTransportConfig = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  keepalive?: boolean;
  maxKeepaliveBodyBytes?: number;
};

export type BeaconTransportConfig = {
  endpoint: string;
  fetchImpl?: typeof fetch;
  maxBeaconBodyBytes?: number;
  sendBeacon?: (endpoint: string, payload: string | Blob) => boolean;
};

export type BeaconTransportResponse = TransportResponse & {
  queued: boolean;
};

export type BeaconTransport = Transport & {
  send(apiKey: string, body: string): Promise<BeaconTransportResponse>;
};

export type BrowserPersistentStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type BrowserPersistError = {
  code:
    | "persisted_batch_too_large"
    | "persisted_queue_full"
    | "persisted_storage_corrupt"
    | "persisted_storage_unavailable";
  message: string;
};

export type BrowserPersistedReplay = {
  attempted: number;
  delivered: number;
  retained: number;
};

export type BrowserPersistedReplayOptions = {
  skipOwnBatches?: boolean;
};

export type PersistentBrowserTransport = Transport & {
  clearStoredBatches(): void;
  pendingStoredBatches(): number;
  replayStoredBatches(apiKey: string, options?: BrowserPersistedReplayOptions): Promise<BrowserPersistedReplay>;
};

export type PersistentBrowserTransportConfig = {
  maxStoredBatches?: number;
  maxStoredBytes?: number;
  onPersistError?: (error: BrowserPersistError) => void;
  storage?: BrowserPersistentStorage;
  storageKey?: string;
  transport: Transport;
};

export type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

export type BrowserTraceparentConfig = {
  traceId?: string;
  spanId?: string;
  traceFlags?: string;
  randomValues?: (length: number) => ArrayLike<number>;
};

export type BrowserTraceContext = {
  traceId: string;
  spanId: string;
  traceFlags: string;
  sampled: boolean;
};

export type BrowserTraceContextConfig = BrowserTraceparentConfig & {
  sampled?: boolean;
};

export type BrowserTraceContextInput = BrowserTraceContext | BrowserTraceContextConfig | string | false | undefined;

export type TraceparentFetchConfig = {
  fetchImpl?: typeof fetch;
  randomValues?: (length: number) => ArrayLike<number>;
  traceContext?: BrowserTraceContextInput | (() => BrowserTraceContextInput);
  traceFlags?: string;
  traceparent?: string;
  traceparentFactory?: (context: {
    input: RequestInfo | URL;
    init?: RequestInit;
    url: string;
  }) => string | undefined;
  tracePropagationTargets?: TracePropagationTarget[];
};

export type BrowserFetchInput = {
  input?: RequestInfo | URL;
  init?: RequestInit;
  method?: string;
  url?: string;
  statusCode?: number;
  durationMs?: number;
  responseBodySize?: number;
  errorType?: string;
  spanTraceContext?: BrowserTraceContextInput;
  tracePropagated?: boolean;
};

export type BrowserFetchTemplateContext = {
  input?: RequestInfo | URL;
  init?: RequestInit;
  method: string;
  path: string;
};

export type BrowserFetchPathTemplate =
  | string
  | ((context: BrowserFetchTemplateContext) => string | undefined);

export type BrowserXhrInput = {
  method?: string;
  url?: string;
  statusCode?: number;
  durationMs?: number;
  responseBodySize?: number;
  errorType?: string;
  spanTraceContext?: BrowserTraceContextInput;
  tracePropagated?: boolean;
};

export type BrowserXhrTemplateContext = {
  method: string;
  path: string;
};

export type BrowserXhrPathTemplate =
  | string
  | ((context: BrowserXhrTemplateContext) => string | undefined);

export type LogBrewBrowserContext = {
  browserWindow?: Window;
  client: LogBrewClient;
  logbrew: LogBrewClient;
  traceContext?: BrowserTraceContext;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  replayStoredBatches(): Promise<BrowserPersistedReplay>;
  shutdown(): Promise<TransportResponse>;
  uninstall(): void;
};

export type LogBrewBrowserEvent<TAttributes> = {
  id: string;
  timestamp: string;
  attributes: TAttributes;
};

export type BrowserActionInput = string | {
  name: string;
  status?: ActionAttributes["status"];
  metadata?: Metadata;
};

export type BrowserNetworkInput = string | {
  name?: string;
  method?: string;
  routeTemplate: string;
  status?: ActionAttributes["status"];
  statusCode?: number;
  durationMs?: number;
  sessionId?: string;
  traceId?: string;
  metadata?: Metadata;
};

export type BrowserResourceTimingInput = PerformanceResourceTiming | {
  entryType?: string;
  name?: string;
  initiatorType?: string;
  startTime?: number;
  duration?: number;
  workerStart?: number;
  redirectStart?: number;
  redirectEnd?: number;
  fetchStart?: number;
  domainLookupStart?: number;
  domainLookupEnd?: number;
  connectStart?: number;
  secureConnectionStart?: number;
  connectEnd?: number;
  requestStart?: number;
  responseStart?: number;
  responseEnd?: number;
  responseStatus?: number;
  statusCode?: number;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  deliveryType?: string;
};

export type BrowserResourceTimingTemplateContext = {
  entry: BrowserResourceTimingInput;
  initiatorType: string;
  path: string;
};

export type BrowserResourcePathTemplate =
  | string
  | ((context: BrowserResourceTimingTemplateContext) => string | undefined);

export type BrowserNavigationTimingInput = PerformanceNavigationTiming | {
  activationStart?: number;
  connectEnd?: number;
  connectStart?: number;
  decodedBodySize?: number;
  domComplete?: number;
  domContentLoadedEventEnd?: number;
  domContentLoadedEventStart?: number;
  domInteractive?: number;
  domainLookupEnd?: number;
  domainLookupStart?: number;
  duration?: number;
  encodedBodySize?: number;
  entryType?: string;
  fetchStart?: number;
  initiatorType?: string;
  loadEventEnd?: number;
  loadEventStart?: number;
  name?: string;
  navigationType?: string;
  redirectCount?: number;
  redirectEnd?: number;
  redirectStart?: number;
  requestStart?: number;
  responseEnd?: number;
  responseStart?: number;
  responseStatus?: number;
  secureConnectionStart?: number;
  startTime?: number;
  statusCode?: number;
  transferSize?: number;
  type?: string;
  workerStart?: number;
};

export type BrowserNavigationTimingTemplateContext = {
  entry: BrowserNavigationTimingInput;
  navigationType: string;
  path: string;
};

export type BrowserNavigationPathTemplate =
  | string
  | ((context: BrowserNavigationTimingTemplateContext) => string | undefined);

export type BrowserWebVitalInput = {
  attribution?: Record<string, unknown>;
  delta?: number;
  entries?: unknown[];
  id?: string;
  name: string;
  navigationType?: string;
  rating?: string;
  url?: string;
  value: number;
};

export type BrowserWebVitalTemplateContext = {
  metric: BrowserWebVitalInput;
  metricName: string;
  name: string;
  path: string;
};

export type BrowserWebVitalPathTemplate =
  | string
  | ((context: BrowserWebVitalTemplateContext) => string | undefined);

export type BrowserInteractionTimingInput = PerformanceEntry | {
  attribution?: unknown;
  blockingDuration?: number;
  duration: number;
  entryType?: string;
  firstUIEventTimestamp?: number;
  interactionId?: number;
  name?: string;
  processingEnd?: number;
  processingStart?: number;
  renderStart?: number;
  scripts?: unknown;
  startTime?: number;
  styleAndLayoutStart?: number;
  target?: unknown;
};

export type BrowserInteractionTimingTemplateContext = {
  entry: BrowserInteractionTimingInput;
  entryType?: string;
  name?: string;
  path: string;
};

export type BrowserInteractionTimingPathTemplate =
  | string
  | ((context: BrowserInteractionTimingTemplateContext) => string | undefined);

export type BrowserMetadataKind =
  | "page_view"
  | "action"
  | "network"
  | "document"
  | "resource"
  | "web_vital"
  | "interaction"
  | "fetch"
  | "xhr"
  | "error"
  | "unhandledrejection";

export type BrowserFlushReason = "capture" | "online" | "pagehide" | "visibility_hidden";

export type BrowserFlushDetails = {
  reason: BrowserFlushReason;
};

export type LogBrewBrowserOptions = CreateLogBrewBrowserClientConfig & FetchTransportConfig & {
  browserWindow?: Window;
  client?: LogBrewClient;
  transport?: Transport;
  captureGlobalErrors?: boolean;
  captureUnhandledRejections?: boolean;
  capturePageViews?: boolean;
  flushOnCapture?: boolean;
  flushOnOnline?: boolean;
  flushOnPageHide?: boolean;
  flushOnVisibilityHidden?: boolean;
  /** Map of sanitized browser frame paths or minified URLs to release-artifact Debug IDs. */
  debugIdMap?: Record<string, string>;
  /** Release name associated with browser errors. */
  release?: string;
  /** Environment associated with browser errors. */
  environment?: string;
  /** Service name associated with browser errors. */
  service?: string;
  /** Runtime label such as `browser`. */
  runtime?: string;
  /** Platform label such as `web`. */
  platform?: string;
  /** Optional stable app-owned grouping fingerprint for explicit error capture. Keep it safe and low-cardinality. */
  fingerprint?: string;
  /** Include raw error stack text only when the app has explicitly approved it. Defaults to false. */
  includeErrorStack?: boolean;
  includeDocumentTitle?: boolean;
  includeHash?: boolean;
  includeQueryString?: boolean;
  includeUserAgent?: boolean;
  metadata?: Metadata;
  now?: () => string;
  persistOffline?: boolean | Omit<PersistentBrowserTransportConfig, "transport">;
  preventDefault?: boolean;
  randomValues?: (length: number) => ArrayLike<number>;
  raiseCaptureErrors?: boolean;
  replayPersistedOnInstall?: boolean;
  sampled?: boolean;
  sanitizeMetadata?: (metadata: Metadata, kind: BrowserMetadataKind) => Metadata;
  spanId?: string;
  traceContext?: BrowserTraceContextInput;
  traceFlags?: string;
  traceId?: string;
  pageViewEvent?: (
    context: { browserWindow?: Window; client: LogBrewClient; traceContext?: BrowserTraceContext }
  ) => LogBrewBrowserEvent<SpanAttributes>;
  errorEvent?: (
    error: unknown,
    context: { browserWindow?: Window; client: LogBrewClient; traceContext?: BrowserTraceContext }
  ) => LogBrewBrowserEvent<IssueAttributes>;
  rejectionEvent?: (
    rejection: unknown,
    context: { browserWindow?: Window; client: LogBrewClient; traceContext?: BrowserTraceContext }
  ) => LogBrewBrowserEvent<IssueAttributes>;
  actionEvent?: (
    action: BrowserActionInput,
    context: { browserWindow?: Window; client: LogBrewClient; traceContext?: BrowserTraceContext }
  ) => LogBrewBrowserEvent<ActionAttributes>;
  networkEvent?: (
    request: BrowserNetworkInput,
    context: { browserWindow?: Window; client: LogBrewClient; traceContext?: BrowserTraceContext }
  ) => LogBrewBrowserEvent<ActionAttributes>;
  idFactory?: (context: {
    action?: BrowserActionInput;
    browserWindow?: Window;
    error?: unknown;
    message?: string;
    request?: BrowserNetworkInput;
    path: string;
    source?: string;
  }) => string;
  onFlush?: (
    response: TransportResponse,
    context: LogBrewBrowserContext,
    details: BrowserFlushDetails
  ) => void | Promise<void>;
  onCaptureError?: (
    error: unknown,
    context: LogBrewBrowserContext,
    details: BrowserFlushDetails
  ) => void | Promise<void>;
};

export type BrowserNavigationInstrumentationOptions = LogBrewBrowserOptions & {
  captureInitial?: boolean;
};

export type BrowserNavigationInstrumentation = {
  uninstall(): void;
};

export type BrowserResourceTimingObserver = {
  observe(options: { buffered?: boolean; type: "resource" } | { entryTypes: string[] }): void;
  disconnect(): void;
};

export type BrowserResourceTimingObserverConstructor = new (
  callback: (entryList: { getEntries(): BrowserResourceTimingInput[] }) => void
) => BrowserResourceTimingObserver;

export type BrowserResourceTimingOptions = LogBrewBrowserOptions & {
  buffered?: boolean;
  performanceObserver?: BrowserResourceTimingObserverConstructor;
  resourcePathTemplate?: BrowserResourcePathTemplate;
};

export type BrowserResourceTimingInstrumentation = {
  uninstall(): void;
};

export type BrowserNavigationTimingOptions = LogBrewBrowserOptions & {
  captureInitial?: boolean;
  deferAfterLoad?: boolean;
  entry?: BrowserNavigationTimingInput;
  navigationPathTemplate?: BrowserNavigationPathTemplate;
  setTimeout?: (callback: () => void, delay?: number) => unknown;
};

export type BrowserNavigationTimingInstrumentation = {
  uninstall(): void;
};

export type BrowserWebVitalCallback = (metric: BrowserWebVitalInput) => void;

export type BrowserWebVitalsModule = {
  onCLS?: (callback: BrowserWebVitalCallback) => void | (() => void);
  onFCP?: (callback: BrowserWebVitalCallback) => void | (() => void);
  onFID?: (callback: BrowserWebVitalCallback) => void | (() => void);
  onINP?: (callback: BrowserWebVitalCallback) => void | (() => void);
  onLCP?: (callback: BrowserWebVitalCallback) => void | (() => void);
  onTTFB?: (callback: BrowserWebVitalCallback) => void | (() => void);
};

export type BrowserWebVitalsOptions = LogBrewBrowserOptions & BrowserWebVitalsModule & {
  metricNames?: string[];
  webVitalPathTemplate?: BrowserWebVitalPathTemplate;
  webVitals?: BrowserWebVitalsModule;
};

export type BrowserWebVitalsInstrumentation = {
  uninstall(): void;
};

export type BrowserInteractionTimingObserverEntryType =
  | "event"
  | "first-input"
  | "long-animation-frame"
  | "longtask";

export type BrowserInteractionTimingObserver = {
  observe(
    options:
      | { buffered?: boolean; durationThreshold?: number; type: "event" | "first-input" }
      | { buffered?: boolean; type: "long-animation-frame" | "longtask" }
      | { entryTypes: string[] }
  ): void;
  disconnect(): void;
};

export type BrowserInteractionTimingObserverConstructor = new (
  callback: (entryList: { getEntries(): BrowserInteractionTimingInput[] }) => void
) => BrowserInteractionTimingObserver;

export type BrowserInteractionTimingOptions = LogBrewBrowserOptions & {
  buffered?: boolean;
  entryTypes?: BrowserInteractionTimingObserverEntryType[];
  interactionDurationThresholdMs?: number;
  interactionPathTemplate?: BrowserInteractionTimingPathTemplate;
  maxDurationMs?: number;
  performanceObserver?: BrowserInteractionTimingObserverConstructor;
};

export type BrowserInteractionToNextPaintOptions = BrowserInteractionTimingOptions & {
  interactionCount?: number;
  maxRankedInteractions?: number;
};

export type BrowserInteractionTimingInstrumentation = {
  uninstall(): void;
};

export type BrowserFetchOptions = LogBrewBrowserOptions & {
  captureTargets?: TracePropagationTarget[];
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  resourcePathTemplate?: BrowserFetchPathTemplate;
  tracePropagationTargets?: TracePropagationTarget[];
};

export type BrowserFetchInstrumentation = {
  uninstall(): void;
};

export type BrowserXhrOptions = LogBrewBrowserOptions & {
  captureTargets?: TracePropagationTarget[];
  nowMs?: () => number;
  resourcePathTemplate?: BrowserXhrPathTemplate;
  tracePropagationTargets?: TracePropagationTarget[];
  XMLHttpRequest?: typeof XMLHttpRequest;
};

export type BrowserXhrInstrumentation = {
  uninstall(): void;
};

export declare function createLogBrewBrowserClient(
  config?: CreateLogBrewBrowserClientConfig
): LogBrewClient;

export declare function createFetchTransport(
  config?: FetchTransportConfig
): Transport;

export declare function createBeaconTransport(
  config: BeaconTransportConfig
): BeaconTransport;

export declare function createPersistentBrowserTransport(
  config: PersistentBrowserTransportConfig
): PersistentBrowserTransport;

export declare function createBrowserTraceparent(
  config?: BrowserTraceparentConfig
): string;

export declare function createBrowserTraceContext(
  config?: BrowserTraceContextConfig
): BrowserTraceContext;

export declare function createTraceparentFetch(
  config?: TraceparentFetchConfig
): typeof fetch;

export declare function createLogBrewBrowserFetch(
  context: LogBrewBrowserContext,
  options?: BrowserFetchOptions
): typeof fetch;

export declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: TracePropagationTarget[]
): boolean;

export declare function installLogBrewBrowser(
  options?: LogBrewBrowserOptions
): LogBrewBrowserContext;

export declare function installLogBrewBrowserNavigationInstrumentation(
  context: LogBrewBrowserContext,
  options?: BrowserNavigationInstrumentationOptions
): BrowserNavigationInstrumentation;

export declare function installLogBrewBrowserResourceTimingInstrumentation(
  context: LogBrewBrowserContext,
  options?: BrowserResourceTimingOptions
): BrowserResourceTimingInstrumentation;

export declare function installLogBrewBrowserNavigationTimingInstrumentation(
  context: LogBrewBrowserContext,
  options?: BrowserNavigationTimingOptions
): BrowserNavigationTimingInstrumentation;

export declare function installLogBrewBrowserWebVitalsInstrumentation(
  context: LogBrewBrowserContext,
  options?: BrowserWebVitalsOptions
): BrowserWebVitalsInstrumentation;

export declare function installLogBrewBrowserFetchInstrumentation(
  context: LogBrewBrowserContext,
  options?: BrowserFetchOptions
): BrowserFetchInstrumentation;

export declare function installLogBrewBrowserInteractionTimingInstrumentation(
  context: LogBrewBrowserContext,
  options?: BrowserInteractionTimingOptions
): BrowserInteractionTimingInstrumentation;

export declare function installLogBrewBrowserXhrInstrumentation(
  context: LogBrewBrowserContext,
  options?: BrowserXhrOptions
): BrowserXhrInstrumentation;

export declare function createLogBrewBrowserContext(
  client: LogBrewClient,
  transport: Transport,
  browserWindow?: Window,
  uninstall?: () => void,
  traceContext?: BrowserTraceContextInput
): LogBrewBrowserContext;

export declare function capturePageView(
  context: LogBrewBrowserContext,
  options?: LogBrewBrowserOptions
): Promise<TransportResponse | undefined>;

export declare function captureBrowserError(
  error: unknown,
  context: LogBrewBrowserContext,
  options?: LogBrewBrowserOptions
): Promise<TransportResponse | undefined>;

export declare function captureUnhandledRejection(
  rejection: unknown,
  context: LogBrewBrowserContext,
  options?: LogBrewBrowserOptions
): Promise<TransportResponse | undefined>;

export declare function captureBrowserAction(
  action: BrowserActionInput,
  context: LogBrewBrowserContext,
  options?: LogBrewBrowserOptions
): Promise<TransportResponse | undefined>;

export declare function captureBrowserNetwork(
  request: BrowserNetworkInput,
  context: LogBrewBrowserContext,
  options?: LogBrewBrowserOptions
): Promise<TransportResponse | undefined>;

export declare function captureBrowserResourceTiming(
  entry: BrowserResourceTimingInput,
  context: LogBrewBrowserContext,
  options?: BrowserResourceTimingOptions
): Promise<TransportResponse | undefined>;

export declare function captureBrowserNavigationTiming(
  entry: BrowserNavigationTimingInput,
  context: LogBrewBrowserContext,
  options?: BrowserNavigationTimingOptions
): Promise<TransportResponse | undefined>;

export declare function captureBrowserWebVital(
  metric: BrowserWebVitalInput,
  context: LogBrewBrowserContext,
  options?: BrowserWebVitalsOptions
): Promise<TransportResponse | undefined>;

export declare function captureBrowserInteractionTiming(
  entry: BrowserInteractionTimingInput,
  context: LogBrewBrowserContext,
  options?: BrowserInteractionTimingOptions
): Promise<TransportResponse | undefined>;

export declare function captureBrowserInteractionToNextPaint(
  entries: BrowserInteractionTimingInput[],
  context: LogBrewBrowserContext,
  options?: BrowserInteractionToNextPaintOptions
): Promise<TransportResponse | undefined>;

export declare function captureBrowserFetchSpan(
  request: BrowserFetchInput,
  context: LogBrewBrowserContext,
  options?: BrowserFetchOptions
): Promise<TransportResponse | undefined>;

export declare function captureBrowserXhrSpan(
  request: BrowserXhrInput,
  context: LogBrewBrowserContext,
  options?: BrowserXhrOptions
): Promise<TransportResponse | undefined>;

export declare function createPageViewEvent(
  browserWindow?: Window,
  options?: LogBrewBrowserOptions
): LogBrewBrowserEvent<SpanAttributes>;

export declare function createBrowserActionEvent(
  action: BrowserActionInput,
  browserWindow?: Window,
  options?: LogBrewBrowserOptions
): LogBrewBrowserEvent<ActionAttributes>;

export declare function createBrowserNetworkEvent(
  request: BrowserNetworkInput,
  browserWindow?: Window,
  options?: LogBrewBrowserOptions
): LogBrewBrowserEvent<ActionAttributes>;

export declare function createBrowserResourceTimingEvent(
  entry: BrowserResourceTimingInput,
  browserWindow?: Window,
  options?: BrowserResourceTimingOptions
): LogBrewBrowserEvent<SpanAttributes>;

export declare function createBrowserNavigationTimingEvent(
  entry: BrowserNavigationTimingInput,
  browserWindow?: Window,
  options?: BrowserNavigationTimingOptions
): LogBrewBrowserEvent<SpanAttributes>;

export declare function createBrowserWebVitalEvent(
  metric: BrowserWebVitalInput,
  browserWindow?: Window,
  options?: BrowserWebVitalsOptions
): LogBrewBrowserEvent<SpanAttributes>;

export declare function createBrowserInteractionTimingEvent(
  entry: BrowserInteractionTimingInput,
  browserWindow?: Window,
  options?: BrowserInteractionTimingOptions
): LogBrewBrowserEvent<SpanAttributes>;

export declare function createBrowserInteractionToNextPaintEvent(
  entries: BrowserInteractionTimingInput[],
  browserWindow?: Window,
  options?: BrowserInteractionToNextPaintOptions
): LogBrewBrowserEvent<SpanAttributes>;

export declare function createBrowserFetchSpanEvent(
  request: BrowserFetchInput,
  browserWindow?: Window,
  options?: BrowserFetchOptions
): LogBrewBrowserEvent<SpanAttributes>;

export declare function createBrowserXhrSpanEvent(
  request: BrowserXhrInput,
  browserWindow?: Window,
  options?: BrowserXhrOptions
): LogBrewBrowserEvent<SpanAttributes>;

export declare function createBrowserErrorEvent(
  error: unknown,
  browserWindow?: Window,
  options?: LogBrewBrowserOptions
): LogBrewBrowserEvent<IssueAttributes>;

export declare function createUnhandledRejectionEvent(
  rejection: unknown,
  browserWindow?: Window,
  options?: LogBrewBrowserOptions
): LogBrewBrowserEvent<IssueAttributes>;

declare const defaultExport: {
  captureBrowserAction: typeof captureBrowserAction;
  captureBrowserError: typeof captureBrowserError;
  captureBrowserFetchSpan: typeof captureBrowserFetchSpan;
  captureBrowserInteractionTiming: typeof captureBrowserInteractionTiming;
  captureBrowserInteractionToNextPaint: typeof captureBrowserInteractionToNextPaint;
  captureBrowserNetwork: typeof captureBrowserNetwork;
  captureBrowserNavigationTiming: typeof captureBrowserNavigationTiming;
  captureBrowserResourceTiming: typeof captureBrowserResourceTiming;
  captureBrowserWebVital: typeof captureBrowserWebVital;
  captureBrowserXhrSpan: typeof captureBrowserXhrSpan;
  capturePageView: typeof capturePageView;
  captureUnhandledRejection: typeof captureUnhandledRejection;
  createBrowserTraceContext: typeof createBrowserTraceContext;
  createBrowserTraceparent: typeof createBrowserTraceparent;
  createBrowserActionEvent: typeof createBrowserActionEvent;
  createBrowserErrorEvent: typeof createBrowserErrorEvent;
  createBrowserFetchSpanEvent: typeof createBrowserFetchSpanEvent;
  createBrowserInteractionTimingEvent: typeof createBrowserInteractionTimingEvent;
  createBrowserInteractionToNextPaintEvent: typeof createBrowserInteractionToNextPaintEvent;
  createBrowserNavigationTimingEvent: typeof createBrowserNavigationTimingEvent;
  createBrowserResourceTimingEvent: typeof createBrowserResourceTimingEvent;
  createBrowserWebVitalEvent: typeof createBrowserWebVitalEvent;
  createBrowserXhrSpanEvent: typeof createBrowserXhrSpanEvent;
  createFetchTransport: typeof createFetchTransport;
  createLogBrewBrowserFetch: typeof createLogBrewBrowserFetch;
  createLogBrewBrowserClient: typeof createLogBrewBrowserClient;
  createLogBrewBrowserContext: typeof createLogBrewBrowserContext;
  createBrowserNetworkEvent: typeof createBrowserNetworkEvent;
  createPageViewEvent: typeof createPageViewEvent;
  createPersistentBrowserTransport: typeof createPersistentBrowserTransport;
  createTraceparentFetch: typeof createTraceparentFetch;
  createUnhandledRejectionEvent: typeof createUnhandledRejectionEvent;
  installLogBrewBrowserFetchInstrumentation: typeof installLogBrewBrowserFetchInstrumentation;
  installLogBrewBrowserInteractionTimingInstrumentation: typeof installLogBrewBrowserInteractionTimingInstrumentation;
  installLogBrewBrowserNavigationInstrumentation: typeof installLogBrewBrowserNavigationInstrumentation;
  installLogBrewBrowserNavigationTimingInstrumentation: typeof installLogBrewBrowserNavigationTimingInstrumentation;
  installLogBrewBrowserResourceTimingInstrumentation: typeof installLogBrewBrowserResourceTimingInstrumentation;
  installLogBrewBrowserWebVitalsInstrumentation: typeof installLogBrewBrowserWebVitalsInstrumentation;
  installLogBrewBrowserXhrInstrumentation: typeof installLogBrewBrowserXhrInstrumentation;
  installLogBrewBrowser: typeof installLogBrewBrowser;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
};

export default defaultExport;
