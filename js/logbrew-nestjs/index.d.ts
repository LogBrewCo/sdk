import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
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
import type { Request, Response } from "express";
import type { Observable } from "rxjs";

type CreateLogBrewNestClientConfig = {
  serverApiKey?: string;
  apiKey?: string;
  captureRuntimeContext?: boolean;
  context?: TelemetryContext;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

/** Request context; the same type as the Node package's request context, so both declarations of `logbrew` agree. */
type LogBrewNestContext = LogBrewNodeContext;

type LogBrewNestRuntimeContext = {
  readonly executionContext: ExecutionContext;
  readonly request: Request;
  readonly response: Response;
  readonly client: LogBrewClient;
  readonly trace?: Readonly<LogBrewTraceContext> | undefined;
};

/** The request fields the event helpers read; an Express request has all of them. */
type LogBrewNestRequestLike = {
  readonly method?: string;
  readonly originalUrl?: string;
  readonly url?: string;
};

type LogBrewClientFactory = (context: Omit<LogBrewNestRuntimeContext, "client">) => LogBrewClient;
type LogBrewTransportFactory = (context: LogBrewNestRuntimeContext) => Transport;

type LogBrewRequestLogEvent = {
  id: string;
  timestamp: string;
  type?: "log";
  attributes: LogAttributes;
};

type LogBrewRequestSpanEvent = {
  id: string;
  timestamp: string;
  type: "span";
  attributes: SpanAttributes;
};

type LogBrewRequestEvent = LogBrewRequestLogEvent | LogBrewRequestSpanEvent;

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

type LogBrewNestLoggerLevel = "info" | "warning" | "error" | "critical";

type LogBrewNestBaseLogger = {
  log?: (message: unknown, context?: string) => void;
  error?: (message: unknown, stack?: string, context?: string) => void;
  warn?: (message: unknown, context?: string) => void;
  debug?: (message: unknown, context?: string) => void;
  verbose?: (message: unknown, context?: string) => void;
  fatal?: (message: unknown, stack?: string, context?: string) => void;
  setLogLevels?: (levels: readonly string[]) => void;
};

type LogBrewNestLogger = {
  client: LogBrewClient;
  /** Delivery transport used by flush and shutdown. Defaults to the Node fetch transport. */
  transport: Transport;
  log: (message: unknown, context?: string) => void;
  error: (message: unknown, stack?: string, context?: string) => void;
  warn: (message: unknown, context?: string) => void;
  debug: (message: unknown, context?: string) => void;
  verbose: (message: unknown, context?: string) => void;
  fatal: (message: unknown, stack?: string, context?: string) => void;
  setLogLevels: (levels: readonly string[]) => void;
  flush: () => Promise<TransportResponse | null>;
  shutdown: () => Promise<TransportResponse | null>;
};

type LogBrewNestLoggerOptions = CreateLogBrewNestClientConfig & NodeFetchTransportConfig & {
  client?: LogBrewClient;
  baseLogger?: LogBrewNestBaseLogger;
  logger?: string;
  /** Override the default Node fetch transport. */
  transport?: Transport;
  now?: () => string;
  idFactory?: (level: LogBrewNestLoggerLevel, message: unknown, context: string | undefined, sequence: number) => string;
  captureErrorsAsIssues?: boolean;
  flushOnCapture?: boolean;
  onCaptureError?: (error: unknown) => void | Promise<void>;
};

type LogBrewNestRequestHookContext = {
  readonly client: LogBrewClient;
  readonly durationMs: number;
  readonly executionContext: ExecutionContext;
  readonly trace?: Readonly<LogBrewTraceContext> | undefined;
};

type LogBrewNestOptions = CreateLogBrewNestClientConfig & NodeFetchTransportConfig & {
  client?: LogBrewClient | LogBrewClientFactory;
  /** Override the default Node fetch transport, optionally per request. */
  transport?: Transport | LogBrewTransportFactory;
  captureRequests?: boolean;
  captureRequestMetrics?: boolean;
  now?: () => string;
  nowMs?: () => number;
  idFactory?: (request: Request, response: Response) => string;
  spanIdFactory?: (request: Request, response: Response) => string;
  traceIdFactory?: (request: Request, response: Response) => string;
  metricName?: string;
  metricIdFactory?: (request: Request, response: Response) => string;
  requestEvent?: (request: Request, response: Response, context: LogBrewNestRequestHookContext) => LogBrewRequestEvent;
  requestMetricEvent?: (
    request: Request,
    response: Response,
    context: LogBrewNestRequestHookContext
  ) => LogBrewRequestMetricEvent;
  errorEvent?: (error: unknown, context: LogBrewNestRuntimeContext) => LogBrewErrorEvent;
  onFlush?: (response: Readonly<TransportResponse>, context: LogBrewNestRuntimeContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewNestRuntimeContext) => void | Promise<void>;
};

declare function createLogBrewNestClient(config?: CreateLogBrewNestClientConfig): LogBrewClient;
declare function createLogBrewNestLogger(options?: LogBrewNestLoggerOptions): LogBrewNestLogger;
declare class LogBrewInterceptor implements NestInterceptor {
  public constructor(options?: LogBrewNestOptions);
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>;
}
declare function getActiveLogBrewTrace(): LogBrewTraceContext | undefined;
declare function createRequestEvent<
  RequestType extends LogBrewNestRequestLike = Request,
  ResponseType = Response
>(
  request: RequestType,
  response: ResponseType,
  options?: {
    readonly now?: (() => string) | undefined;
    readonly durationMs?: number | undefined;
    readonly idFactory?: ((request: RequestType, response: ResponseType) => string) | undefined;
    readonly spanIdFactory?: ((request: RequestType, response: ResponseType) => string) | undefined;
    readonly traceIdFactory?: ((request: RequestType, response: ResponseType) => string) | undefined;
    readonly trace?: Readonly<LogBrewTraceContext> | undefined;
  }
): LogBrewRequestSpanEvent;
declare function createErrorEvent<RequestType extends LogBrewNestRequestLike = Request>(
  error: unknown,
  request: RequestType,
  options?: {
    readonly now?: (() => string) | undefined;
    readonly idFactory?: ((error: unknown, request: RequestType) => string) | undefined;
    readonly trace?: Readonly<LogBrewTraceContext> | undefined;
  }
): LogBrewErrorEvent;
declare function createRequestMetricEvent<
  RequestType extends LogBrewNestRequestLike = Request,
  ResponseType = Response
>(
  request: RequestType,
  response: ResponseType,
  options?: {
    readonly now?: (() => string) | undefined;
    readonly durationMs?: number | undefined;
    readonly idFactory?: ((request: RequestType, response: ResponseType) => string) | undefined;
    readonly metricName?: string | undefined;
  }
): LogBrewRequestMetricEvent;

declare global {
  namespace Express {
    interface Request {
      logbrew?: LogBrewNestContext;
    }
  }
}

declare const defaultExport: {
  createErrorEvent: typeof createErrorEvent;
  getActiveLogBrewTrace: typeof getActiveLogBrewTrace;
  createLogBrewNestLogger: typeof createLogBrewNestLogger;
  createLogBrewNestClient: typeof createLogBrewNestClient;
  createRequestMetricEvent: typeof createRequestMetricEvent;
  createRequestEvent: typeof createRequestEvent;
  LogBrewInterceptor: typeof LogBrewInterceptor;
};

export type {
  CreateLogBrewNestClientConfig,
  LogBrewClientFactory,
  LogBrewErrorEvent,
  LogBrewNestBaseLogger,
  LogBrewNestContext,
  LogBrewNestLogger,
  LogBrewNestLoggerLevel,
  LogBrewNestLoggerOptions,
  LogBrewNestOptions,
  LogBrewNestRequestHookContext,
  LogBrewNestRequestLike,
  LogBrewNestRuntimeContext,
  LogBrewRequestEvent,
  LogBrewRequestLogEvent,
  LogBrewRequestMetricEvent,
  LogBrewRequestSpanEvent,
  LogBrewTransportFactory
};
export {
  createErrorEvent,
  createLogBrewNestClient,
  createLogBrewNestLogger,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,
  LogBrewInterceptor
};
export type { LogBrewTraceContext } from "@logbrew/node";
export default defaultExport;
