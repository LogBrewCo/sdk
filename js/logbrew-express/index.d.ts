import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
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
import type { LogBrewNodeContext, LogBrewTraceContext, NodeFetchTransportConfig } from "@logbrew/node";

type CreateLogBrewExpressClientConfig = {
  serverApiKey?: string;
  apiKey?: string;
  captureRuntimeContext?: boolean;
  context?: TelemetryContext;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

/** Request context; the same type as the Node package's request context, so both declarations of `logbrew` agree. */
type LogBrewExpressContext = LogBrewNodeContext;

type LogBrewExpressRuntimeContext = {
  readonly req: Request;
  readonly res: Response;
  readonly client: LogBrewClient;
  readonly trace?: Readonly<LogBrewTraceContext> | undefined;
};

/** The request fields the event helpers read; an Express request has all of them. */
type LogBrewExpressRequestLike = {
  readonly method?: string;
  readonly route?: unknown;
};

type LogBrewExpressRequestHookContext = {
  readonly client: LogBrewClient;
  readonly durationMs: number;
  readonly trace?: Readonly<LogBrewTraceContext> | undefined;
};

type LogBrewClientFactory = (context: Omit<LogBrewExpressRuntimeContext, "client">) => LogBrewClient;
type LogBrewTransportFactory = (context: LogBrewExpressRuntimeContext) => Transport;

type LogBrewLogRequestEvent = {
  id: string;
  timestamp: string;
  type?: "log";
  attributes: LogAttributes;
};

type LogBrewSpanRequestEvent = {
  id: string;
  timestamp: string;
  type: "span";
  attributes: SpanAttributes;
};

type LogBrewRequestEvent = LogBrewLogRequestEvent | LogBrewSpanRequestEvent;

type LogBrewErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

type LogBrewRequestMetricEvent = {
  id: string;
  timestamp: string;
  attributes: MetricAttributes;
};

/** Options that both the middleware and the error handler accept. */
type LogBrewExpressSharedOptions = CreateLogBrewExpressClientConfig & NodeFetchTransportConfig & {
  client?: LogBrewClient | LogBrewClientFactory;
  /** Override the default Node fetch transport, optionally per request. */
  transport?: Transport | LogBrewTransportFactory;
  captureRequests?: boolean;
  captureRequestMetrics?: boolean;
  /** Include raw stack text only when the app has explicitly approved it. Defaults to false. */
  includeErrorStack?: boolean;
  /** Report errors with a 4xx `status` or `statusCode` as issues too. Defaults to false. */
  captureClientErrors?: boolean;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: (req: Request, res: Response) => string;
  traceIdFactory?: (req: Request, res: Response) => string;
  metricName?: string;
  metricIdFactory?: (req: Request, res: Response) => string;
  requestEvent?: (req: Request, res: Response, context: LogBrewExpressRequestHookContext) => LogBrewRequestEvent;
  requestMetricEvent?: (
    req: Request,
    res: Response,
    context: LogBrewExpressRequestHookContext
  ) => LogBrewRequestMetricEvent;
  errorEvent?: (error: unknown, context: LogBrewExpressRuntimeContext) => LogBrewErrorEvent;
  onFlush?: (response: Readonly<TransportResponse>, context: LogBrewExpressRuntimeContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewExpressRuntimeContext) => void | Promise<void>;
};

type LogBrewExpressOptions = LogBrewExpressSharedOptions & {
  /** ID of each request span, from the request and the response. */
  idFactory?: (req: Request, res: Response) => string;
};

type LogBrewExpressErrorHandlerOptions = LogBrewExpressSharedOptions & {
  /** ID of each captured issue, from the error and the request. */
  idFactory?: (error: unknown, req: Request) => string;
};

type LogBrewExpressHandler<Result = unknown, Receiver = unknown> = (
  this: Receiver,
  req: Request,
  res: Response,
  next: NextFunction
) => Result;

declare function createLogBrewExpressClient(config?: CreateLogBrewExpressClientConfig): LogBrewClient;
declare function logbrewMiddleware(options?: LogBrewExpressOptions): RequestHandler;
declare function logbrewErrorHandler(options?: LogBrewExpressErrorHandlerOptions): ErrorRequestHandler;
/** Track returned handler work; forward promise rejections to next once on Express 4 and 5. */
declare function withLogBrewExpressHandler<Receiver, Result>(
  handler: LogBrewExpressHandler<Result, Receiver>
): LogBrewExpressHandler<Result extends PromiseLike<unknown> ? Promise<Awaited<Result> | undefined> : Result, Receiver>;
declare function getActiveLogBrewTrace(): LogBrewTraceContext | undefined;
declare function createRequestEvent<
  RequestType extends LogBrewExpressRequestLike = Request,
  ResponseType = Response
>(
  req: RequestType,
  res: ResponseType,
  options?: {
    readonly now?: (() => string) | undefined;
    readonly durationMs?: number | undefined;
    readonly idFactory?: ((req: RequestType, res: ResponseType) => string) | undefined;
    readonly spanIdFactory?: ((req: RequestType, res: ResponseType) => string) | undefined;
    readonly traceIdFactory?: ((req: RequestType, res: ResponseType) => string) | undefined;
    readonly trace?: Readonly<LogBrewTraceContext> | undefined;
  }
): LogBrewSpanRequestEvent;
declare function createErrorEvent<RequestType extends LogBrewExpressRequestLike = Request>(
  error: unknown,
  req: RequestType,
  options?: {
    readonly now?: (() => string) | undefined;
    readonly idFactory?: ((error: unknown, req: RequestType) => string) | undefined;
    readonly trace?: Readonly<LogBrewTraceContext> | undefined;
    readonly includeErrorStack?: boolean | undefined;
  }
): LogBrewErrorEvent;
declare function createRequestMetricEvent<
  RequestType extends LogBrewExpressRequestLike = Request,
  ResponseType = Response
>(
  req: RequestType,
  res: ResponseType,
  options?: {
    readonly now?: (() => string) | undefined;
    readonly durationMs?: number | undefined;
    readonly idFactory?: ((req: RequestType, res: ResponseType) => string) | undefined;
    readonly metricName?: string | undefined;
  }
): LogBrewRequestMetricEvent;

declare global {
  namespace Express {
    interface Request {
      logbrew?: LogBrewExpressContext;
    }
  }
}

declare const defaultExport: {
  createErrorEvent: typeof createErrorEvent;
  createLogBrewExpressClient: typeof createLogBrewExpressClient;
  createRequestMetricEvent: typeof createRequestMetricEvent;
  createRequestEvent: typeof createRequestEvent;
  getActiveLogBrewTrace: typeof getActiveLogBrewTrace;
  logbrewErrorHandler: typeof logbrewErrorHandler;
  logbrewMiddleware: typeof logbrewMiddleware;
  withLogBrewExpressHandler: typeof withLogBrewExpressHandler;
};

export type {
  CreateLogBrewExpressClientConfig,
  LogBrewClientFactory,
  LogBrewErrorEvent,
  LogBrewExpressContext,
  LogBrewExpressErrorHandlerOptions,
  LogBrewExpressHandler,
  LogBrewExpressOptions,
  LogBrewExpressRequestHookContext,
  LogBrewExpressRequestLike,
  LogBrewExpressRuntimeContext,
  LogBrewExpressSharedOptions,
  LogBrewLogRequestEvent,
  LogBrewRequestEvent,
  LogBrewRequestMetricEvent,
  LogBrewSpanRequestEvent,
  LogBrewTransportFactory
};
export {
  createErrorEvent,
  createLogBrewExpressClient,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware,
  withLogBrewExpressHandler
};
export type { LogBrewTraceContext } from "@logbrew/node";
export default defaultExport;
