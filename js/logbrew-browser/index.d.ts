import type {
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
};

export type FetchTransportConfig = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  keepalive?: boolean;
};

export type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

export type BrowserTraceparentConfig = {
  traceId?: string;
  spanId?: string;
  traceFlags?: string;
  randomValues?: (length: number) => ArrayLike<number>;
};

export type TraceparentFetchConfig = {
  fetchImpl?: typeof fetch;
  randomValues?: (length: number) => ArrayLike<number>;
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
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
  uninstall(): void;
};

export type LogBrewBrowserEvent<TAttributes> = {
  id: string;
  timestamp: string;
  attributes: TAttributes;
};

export type BrowserMetadataKind = "page_view" | "error" | "unhandledrejection";

export type LogBrewBrowserOptions = CreateLogBrewBrowserClientConfig & FetchTransportConfig & {
  browserWindow?: Window;
  client?: LogBrewClient;
  transport?: Transport;
  captureGlobalErrors?: boolean;
  captureUnhandledRejections?: boolean;
  capturePageViews?: boolean;
  flushOnCapture?: boolean;
  flushOnPageHide?: boolean;
  flushOnVisibilityHidden?: boolean;
  includeDocumentTitle?: boolean;
  includeHash?: boolean;
  includeQueryString?: boolean;
  includeUserAgent?: boolean;
  metadata?: Metadata;
  now?: () => string;
  preventDefault?: boolean;
  raiseCaptureErrors?: boolean;
  sanitizeMetadata?: (metadata: Metadata, kind: BrowserMetadataKind) => Metadata;
  pageViewEvent?: (
    context: { browserWindow?: Window; client: LogBrewClient }
  ) => LogBrewBrowserEvent<SpanAttributes>;
  errorEvent?: (
    error: unknown,
    context: { browserWindow?: Window; client: LogBrewClient }
  ) => LogBrewBrowserEvent<IssueAttributes>;
  rejectionEvent?: (
    rejection: unknown,
    context: { browserWindow?: Window; client: LogBrewClient }
  ) => LogBrewBrowserEvent<IssueAttributes>;
  idFactory?: (context: {
    browserWindow?: Window;
    error?: unknown;
    message?: string;
    path: string;
    source?: string;
  }) => string;
  onFlush?: (
    response: TransportResponse,
    context: LogBrewBrowserContext
  ) => void | Promise<void>;
  onCaptureError?: (
    error: unknown,
    context: LogBrewBrowserContext
  ) => void | Promise<void>;
};

export declare function createLogBrewBrowserClient(
  config?: CreateLogBrewBrowserClientConfig
): LogBrewClient;

export declare function createFetchTransport(
  config?: FetchTransportConfig
): Transport;

export declare function createBrowserTraceparent(
  config?: BrowserTraceparentConfig
): string;

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
  uninstall?: () => void
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

export declare function createPageViewEvent(
  browserWindow?: Window,
  options?: LogBrewBrowserOptions
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
  captureBrowserError: typeof captureBrowserError;
  capturePageView: typeof capturePageView;
  captureUnhandledRejection: typeof captureUnhandledRejection;
  createBrowserTraceparent: typeof createBrowserTraceparent;
  createBrowserErrorEvent: typeof createBrowserErrorEvent;
  createFetchTransport: typeof createFetchTransport;
  createLogBrewBrowserClient: typeof createLogBrewBrowserClient;
  createLogBrewBrowserContext: typeof createLogBrewBrowserContext;
  createPageViewEvent: typeof createPageViewEvent;
  createTraceparentFetch: typeof createTraceparentFetch;
  createUnhandledRejectionEvent: typeof createUnhandledRejectionEvent;
  installLogBrewBrowser: typeof installLogBrewBrowser;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
};

export default defaultExport;
