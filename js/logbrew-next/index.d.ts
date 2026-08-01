import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  MetricAttributes,
  SpanAttributes,
  TelemetryContext,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

type NodeFetchTransportConfig = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
};

export type CreateLogBrewNextClientConfig = {
  apiKey?: string;
  serverApiKey?: string;
  context?: TelemetryContext;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type LogBrewNextRequestError = unknown;

export type LogBrewNextRequestErrorRequest = Readonly<{
  path: string;
  method: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}>;

export type LogBrewNextRequestErrorContext = Readonly<{
  routerKind: "App Router" | "Pages Router";
  routePath: string;
  routeType: "action" | "middleware" | "proxy" | "render" | "route";
  renderSource?: "react-server-components" | "react-server-components-payload" | "server-rendering";
  revalidateReason?: "on-demand" | "stale";
  renderType?: "dynamic" | "dynamic-resume";
}>;

export type LogBrewNextRequestErrorInput = {
  error: LogBrewNextRequestError;
  request: LogBrewNextRequestErrorRequest;
  context: LogBrewNextRequestErrorContext;
};

export type LogBrewNextRequestErrorRuntimeContext = LogBrewNextRequestErrorInput & {
  client?: LogBrewClient;
  transport?: Transport;
};

export type LogBrewNextRequestErrorCaptureContext = LogBrewNextRequestErrorInput & {
  client: LogBrewClient;
  transport: Transport;
};

export type LogBrewNextRequestErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

export type LogBrewNextRequestErrorHandler = (
  error: LogBrewNextRequestError,
  request: LogBrewNextRequestErrorRequest,
  context: LogBrewNextRequestErrorContext
) => Promise<void>;

export type LogBrewNextRequestErrorOptions = CreateLogBrewNextClientConfig & NodeFetchTransportConfig & {
  /** A fixed client stays caller-owned and is flushed, not shut down. A factory must return a fresh client per error. */
  client?: LogBrewClient | ((input: LogBrewNextRequestErrorInput) => LogBrewClient);
  transport?: Transport | ((context: LogBrewNextRequestErrorInput & { client: LogBrewClient }) => Transport);
  /** Opt into a query-free concrete pathname. Stable routePath metadata remains the default. */
  includePathname?: boolean;
  now?: () => string;
  idFactory?: (
    error: LogBrewNextRequestError,
    request: LogBrewNextRequestErrorRequest,
    context: LogBrewNextRequestErrorContext
  ) => string;
  errorEvent?: (
    error: LogBrewNextRequestError,
    context: LogBrewNextRequestErrorCaptureContext
  ) => LogBrewNextRequestErrorEvent;
  onFlush?: (
    response: TransportResponse,
    context: LogBrewNextRequestErrorCaptureContext
  ) => void | Promise<void>;
  onCaptureError?: (
    error: unknown,
    context: LogBrewNextRequestErrorRuntimeContext
  ) => void | Promise<void>;
};

export type LogBrewRouteContext = Record<string, unknown>;

export type LogBrewTraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  sampled: boolean;
};

export type LogBrewRouteHelpers = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  trace?: LogBrewTraceContext;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewRouteHandler<TContext = LogBrewRouteContext> = (
  request: Request,
  context: TContext,
  helpers: LogBrewRouteHelpers
) => Response | Promise<Response>;

export type LogBrewRouteRuntimeContext<TContext = LogBrewRouteContext> = {
  request: Request;
  context: TContext;
  client: LogBrewClient;
  trace?: LogBrewTraceContext;
};

export type LogBrewRouteRequestRuntimeContext<TContext = LogBrewRouteContext> =
  LogBrewRouteRuntimeContext<TContext> & {
    response: Response;
    durationMs: number;
  };

export type LogBrewClientFactory<TContext = LogBrewRouteContext> = (
  context: Omit<LogBrewRouteRuntimeContext<TContext>, "client">
) => LogBrewClient;

export type LogBrewTransportFactory<TContext = LogBrewRouteContext> = (
  context: LogBrewRouteRuntimeContext<TContext>
) => Transport;

export type LogBrewRouteErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

export type LogBrewRouteLogRequestEvent = {
  id: string;
  timestamp: string;
  type?: "log";
  attributes: LogAttributes;
};

export type LogBrewRouteSpanRequestEvent = {
  id: string;
  timestamp: string;
  type: "span";
  attributes: SpanAttributes;
};

export type LogBrewRouteRequestEvent =
  LogBrewRouteLogRequestEvent | LogBrewRouteSpanRequestEvent;

export type LogBrewRouteMetricEvent = {
  id: string;
  timestamp: string;
  attributes: MetricAttributes;
};

export type LogBrewRouteOptions<TContext = LogBrewRouteContext> = CreateLogBrewNextClientConfig & NodeFetchTransportConfig & {
  client?: LogBrewClient | LogBrewClientFactory<TContext>;
  /** Override the default Node fetch transport, optionally per request. */
  transport?: Transport | LogBrewTransportFactory<TContext>;
  captureRequests?: boolean;
  captureRequestMetrics?: boolean;
  captureErrors?: boolean;
  includeSearchParams?: boolean;
  metricName?: string;
  routeTemplate?: string | ((request: Request, context: TContext) => string | null | undefined);
  now?: () => string;
  nowMs?: () => number;
  idFactory?: (request: Request) => string;
  requestIdFactory?: (request: Request, response: Response) => string;
  metricIdFactory?: (request: Request, response: Response) => string;
  spanIdFactory?: (request: Request, response?: Response) => string;
  requestEvent?: (
    request: Request,
    response: Response,
    context: LogBrewRouteRequestRuntimeContext<TContext>
  ) => LogBrewRouteRequestEvent;
  requestMetricEvent?: (
    request: Request,
    response: Response,
    context: LogBrewRouteRequestRuntimeContext<TContext>
  ) => LogBrewRouteMetricEvent;
  errorEvent?: (
    error: unknown,
    context: LogBrewRouteRuntimeContext<TContext>
  ) => LogBrewRouteErrorEvent;
  onFlush?: (
    response: TransportResponse,
    context: LogBrewRouteRuntimeContext<TContext>
  ) => void | Promise<void>;
  onCaptureError?: (
    error: unknown,
    context: LogBrewRouteRuntimeContext<TContext>
  ) => void | Promise<void>;
};

export declare function createLogBrewNextClient(
  config?: CreateLogBrewNextClientConfig
): LogBrewClient;

export declare function createLogBrewNextRequestErrorHandler(
  options?: LogBrewNextRequestErrorOptions
): LogBrewNextRequestErrorHandler;

export declare function createNextRequestErrorEvent(
  error: LogBrewNextRequestError,
  request: LogBrewNextRequestErrorRequest,
  context: LogBrewNextRequestErrorContext,
  options?: {
    includePathname?: boolean;
    now?: () => string;
    idFactory?: (
      error: LogBrewNextRequestError,
      request: LogBrewNextRequestErrorRequest,
      context: LogBrewNextRequestErrorContext
    ) => string;
  }
): LogBrewNextRequestErrorEvent;

export declare function withLogBrewRouteHandler<TContext = LogBrewRouteContext>(
  handler: LogBrewRouteHandler<TContext>,
  options?: LogBrewRouteOptions<TContext>
): (request: Request, context?: TContext) => Promise<Response>;

export declare function getActiveLogBrewTrace(): LogBrewTraceContext | undefined;

export declare function createRouteRequestEvent(
  request: Request,
  response: Response,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (request: Request, response: Response) => string;
    spanIdFactory?: (request: Request, response?: Response) => string;
    trace?: LogBrewTraceContext;
  }
): LogBrewRouteRequestEvent;

export declare function createRequestMetricEvent(
  request: Request,
  response: Response,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (request: Request, response: Response) => string;
    metricName?: string;
    routeTemplate?: string;
  }
): LogBrewRouteMetricEvent;

export declare function createRouteErrorEvent(
  error: unknown,
  request: Request,
  options?: {
    includeSearchParams?: boolean;
    now?: () => string;
    idFactory?: (request: Request) => string;
    trace?: LogBrewTraceContext;
  }
): LogBrewRouteErrorEvent;

declare const defaultExport: {
  createLogBrewNextClient: typeof createLogBrewNextClient;
  createLogBrewNextRequestErrorHandler: typeof createLogBrewNextRequestErrorHandler;
  createNextRequestErrorEvent: typeof createNextRequestErrorEvent;
  createRequestMetricEvent: typeof createRequestMetricEvent;
  createRouteErrorEvent: typeof createRouteErrorEvent;
  createRouteRequestEvent: typeof createRouteRequestEvent;
  getActiveLogBrewTrace: typeof getActiveLogBrewTrace;
  withLogBrewRouteHandler: typeof withLogBrewRouteHandler;
};

export default defaultExport;
