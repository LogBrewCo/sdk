import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  MetricAttributes,
  SpanAttributes,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewNextClientConfig = {
  apiKey?: string;
  serverApiKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type LogBrewRouteContext = Record<string, unknown>;

export type LogBrewRouteHelpers = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
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

export type LogBrewRouteOptions<TContext = LogBrewRouteContext> = CreateLogBrewNextClientConfig & {
  client?: LogBrewClient | LogBrewClientFactory<TContext>;
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
  spanIdFactory?: (request: Request, response: Response) => string;
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

export declare function withLogBrewRouteHandler<TContext = LogBrewRouteContext>(
  handler: LogBrewRouteHandler<TContext>,
  options?: LogBrewRouteOptions<TContext>
): (request: Request, context?: TContext) => Promise<Response>;

export declare function createRouteRequestEvent(
  request: Request,
  response: Response,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (request: Request, response: Response) => string;
    spanIdFactory?: (request: Request, response: Response) => string;
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
  }
): LogBrewRouteErrorEvent;

declare const defaultExport: {
  createLogBrewNextClient: typeof createLogBrewNextClient;
  createRequestMetricEvent: typeof createRequestMetricEvent;
  createRouteErrorEvent: typeof createRouteErrorEvent;
  createRouteRequestEvent: typeof createRouteRequestEvent;
  withLogBrewRouteHandler: typeof withLogBrewRouteHandler;
};

export default defaultExport;
