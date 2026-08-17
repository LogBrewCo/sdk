import type {
  IssueBreadcrumb,
  IssueAttributes,
  JavaScriptErrorIssueOptions,
  LogAttributes,
  LogBrewClient,
  TelemetryContext,
  Transport,
  TransportResponse
} from "@logbrew/sdk";
import type {
  BrowserTraceparentConfig,
  FetchTransportConfig,
  TraceparentFetchConfig as BrowserTraceparentFetchConfig,
  TracePropagationTarget as BrowserTracePropagationTarget
} from "@logbrew/browser";

export type CreateLogBrewSvelteClientConfig = {
  apiKey?: string;
  clientKey?: string;
  serverApiKey?: string;
  context?: TelemetryContext;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type TracePropagationTarget = BrowserTracePropagationTarget;
export type SvelteTraceparentConfig = BrowserTraceparentConfig;
export type TraceparentFetchLike = typeof fetch;
export type TraceparentFetchConfig = BrowserTraceparentFetchConfig;

export type LogBrewSvelteContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewSvelteRuntimeContext = {
  client: LogBrewClient;
};

export type LogBrewSvelteCaptureContext = {
  context: LogBrewSvelteContext;
};

export type LogBrewClientFactory = () => LogBrewClient;
export type LogBrewTransportFactory = (context: LogBrewSvelteRuntimeContext) => Transport;

export type LogBrewSvelteViewEvent = {
  id: string;
  timestamp: string;
  attributes: LogAttributes;
};

export type LogBrewSvelteErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

export type LogBrewSvelteOptions = CreateLogBrewSvelteClientConfig & FetchTransportConfig & {
  client?: LogBrewClient | LogBrewClientFactory;
  transport?: Transport | LogBrewTransportFactory;
};

export type LogBrewSvelteErrorOptions = JavaScriptErrorIssueOptions & {
  component?: string;
  info?: string;
  now?: () => string;
  idFactory?: (error: unknown, context: { component: string; info: string }) => string;
};

export type LogBrewSvelteCaptureOptions = LogBrewSvelteErrorOptions & {
  breadcrumbs?: IssueBreadcrumb[];
  errorEvent?: (error: unknown, context: LogBrewSvelteCaptureContext) => LogBrewSvelteErrorEvent;
  onFlush?: (response: TransportResponse, context: LogBrewSvelteCaptureContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewSvelteCaptureContext) => void | Promise<void>;
};

export type SvelteKitEvent = {
  request?: { headers?: { get?(name: string): string | null }; method?: string };
  route?: { id?: string | null };
};

export type SvelteKitHandleErrorInput<TEvent extends SvelteKitEvent = SvelteKitEvent> = {
  error: unknown;
  event: TEvent;
  message?: string;
  status?: number;
};

export type LogBrewSvelteKitHooksOptions<TResult = unknown> = Omit<LogBrewSvelteCaptureOptions, "breadcrumbs" | "errorEvent"> & {
  captureRequests?: boolean;
  flushOnCapture?: boolean;
  mapError?: (input: SvelteKitHandleErrorInput) => TResult | Promise<TResult>;
  nowMs?: () => number;
  raiseCaptureErrors?: boolean;
  randomValues?: (length: number) => ArrayLike<number>;
  traceFlags?: string;
};

export type LogBrewSvelteKitHooks<TResult = unknown> = {
  handle<TEvent extends SvelteKitEvent, TResponse>(input: {
    event: TEvent;
    resolve(event: TEvent): TResponse | Promise<TResponse>;
  }): Promise<TResponse>;
  handleError<TEvent extends SvelteKitEvent>(
    input: SvelteKitHandleErrorInput<TEvent>
  ): Promise<TResult | undefined>;
};

export declare const LOG_BREW_SVELTE_KEY: symbol;
export declare function createLogBrewSvelteClient(config?: CreateLogBrewSvelteClientConfig): LogBrewClient;
export declare function createSvelteTraceparent(config?: SvelteTraceparentConfig): string;
export declare function createTraceparentFetch(config?: TraceparentFetchConfig): TraceparentFetchLike;
export declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: TracePropagationTarget[]
): boolean;
export declare function createLogBrewSvelteContext(options?: LogBrewSvelteOptions): LogBrewSvelteContext;
export declare function createLogBrewSvelteKitHooks<TResult = unknown>(
  context: LogBrewSvelteContext,
  options?: LogBrewSvelteKitHooksOptions<TResult>
): LogBrewSvelteKitHooks<TResult>;
export declare function setLogBrewContext(
  options?: LogBrewSvelteOptions | LogBrewSvelteContext
): LogBrewSvelteContext;
export declare function useLogBrew(): LogBrewSvelteContext;
export declare const getLogBrewContext: typeof useLogBrew;
export declare function createSvelteViewEvent(
  name: string,
  options?: {
    now?: () => string;
    path?: string;
    idFactory?: (name: string, path: string) => string;
    metadata?: Record<string, string | number | boolean | null>;
  }
): LogBrewSvelteViewEvent;
export declare function createSvelteErrorEvent(
  error: unknown,
  options?: LogBrewSvelteErrorOptions
): LogBrewSvelteErrorEvent;
export declare function captureSvelteError(
  error: unknown,
  context: LogBrewSvelteContext,
  options?: LogBrewSvelteCaptureOptions
): Promise<TransportResponse>;

declare const defaultExport: {
  captureSvelteError: typeof captureSvelteError;
  createLogBrewSvelteClient: typeof createLogBrewSvelteClient;
  createLogBrewSvelteContext: typeof createLogBrewSvelteContext;
  createLogBrewSvelteKitHooks: typeof createLogBrewSvelteKitHooks;
  createSvelteTraceparent: typeof createSvelteTraceparent;
  createSvelteErrorEvent: typeof createSvelteErrorEvent;
  createSvelteViewEvent: typeof createSvelteViewEvent;
  createTraceparentFetch: typeof createTraceparentFetch;
  getLogBrewContext: typeof getLogBrewContext;
  LOG_BREW_SVELTE_KEY: typeof LOG_BREW_SVELTE_KEY;
  setLogBrewContext: typeof setLogBrewContext;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
  useLogBrew: typeof useLogBrew;
};

export default defaultExport;
