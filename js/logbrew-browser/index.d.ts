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

export type TraceparentFetchConfig = {
  fetchImpl?: typeof fetch;
  randomValues?: (length: number) => ArrayLike<number>;
  traceContext?: BrowserTraceContext | BrowserTraceContextConfig | string | false;
  traceFlags?: string;
  traceparent?: string;
  traceparentFactory?: (context: {
    input: RequestInfo | URL;
    init?: RequestInit;
    url: string;
  }) => string | undefined;
  tracePropagationTargets?: TracePropagationTarget[];
};

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

export type BrowserMetadataKind = "page_view" | "action" | "network" | "error" | "unhandledrejection";

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
  includeDocumentTitle?: boolean;
  includeHash?: boolean;
  includeQueryString?: boolean;
  includeUserAgent?: boolean;
  metadata?: Metadata;
  now?: () => string;
  persistOffline?: boolean | Omit<PersistentBrowserTransportConfig, "transport">;
  preventDefault?: boolean;
  raiseCaptureErrors?: boolean;
  replayPersistedOnInstall?: boolean;
  sanitizeMetadata?: (metadata: Metadata, kind: BrowserMetadataKind) => Metadata;
  traceContext?: BrowserTraceContext | BrowserTraceContextConfig | string | false;
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

export declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: TracePropagationTarget[]
): boolean;

export declare function installLogBrewBrowser(
  options?: LogBrewBrowserOptions
): LogBrewBrowserContext;

export declare function createLogBrewBrowserContext(
  client: LogBrewClient,
  transport: Transport,
  browserWindow?: Window,
  uninstall?: () => void,
  traceContext?: BrowserTraceContext | BrowserTraceContextConfig | string | false
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
  captureBrowserNetwork: typeof captureBrowserNetwork;
  capturePageView: typeof capturePageView;
  captureUnhandledRejection: typeof captureUnhandledRejection;
  createBrowserTraceContext: typeof createBrowserTraceContext;
  createBrowserTraceparent: typeof createBrowserTraceparent;
  createBrowserActionEvent: typeof createBrowserActionEvent;
  createBrowserErrorEvent: typeof createBrowserErrorEvent;
  createFetchTransport: typeof createFetchTransport;
  createLogBrewBrowserClient: typeof createLogBrewBrowserClient;
  createLogBrewBrowserContext: typeof createLogBrewBrowserContext;
  createBrowserNetworkEvent: typeof createBrowserNetworkEvent;
  createPageViewEvent: typeof createPageViewEvent;
  createPersistentBrowserTransport: typeof createPersistentBrowserTransport;
  createTraceparentFetch: typeof createTraceparentFetch;
  createUnhandledRejectionEvent: typeof createUnhandledRejectionEvent;
  installLogBrewBrowser: typeof installLogBrewBrowser;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
};

export default defaultExport;
