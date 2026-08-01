import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest
} from "fastify";
import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  MetricAttributes,
  SpanAttributes,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

type NodeFetchTransportConfig = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
};

export type CreateLogBrewFastifyClientConfig = {
  serverApiKey?: string;
  apiKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type LogBrewTraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  sampled: boolean;
};

export type LogBrewFastifyContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  trace?: LogBrewTraceContext;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewFastifyRuntimeContext = {
  request: FastifyRequest;
  reply: FastifyReply;
  client: LogBrewClient;
  trace?: LogBrewTraceContext;
};

export type LogBrewFastifyApplicationLogContext = {
  client: LogBrewClient;
};

export type LogBrewClientFactory = (context: Omit<LogBrewFastifyRuntimeContext, "client">) => LogBrewClient;
export type LogBrewTransportFactory = (context: LogBrewFastifyRuntimeContext) => Transport;

export type LogBrewLogRequestEvent = {
  id: string;
  timestamp: string;
  type?: "log";
  attributes: LogAttributes;
};

export type LogBrewSpanRequestEvent = {
  id: string;
  timestamp: string;
  type: "span";
  attributes: SpanAttributes;
};

export type LogBrewRequestEvent = LogBrewLogRequestEvent | LogBrewSpanRequestEvent;

export type LogBrewErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

export type LogBrewRequestMetricEvent = {
  id: string;
  timestamp: string;
  attributes: MetricAttributes;
};

export type LogBrewFastifyOptions = CreateLogBrewFastifyClientConfig & NodeFetchTransportConfig & {
  client?: LogBrewClient | LogBrewClientFactory;
  /** Override the default Node fetch transport, optionally per request. */
  transport?: Transport | LogBrewTransportFactory;
  /** Capture existing app.log and request.log Pino records without replacing Fastify's destination. */
  captureApplicationLogs?: boolean;
  /** Override the dedicated application-log client. */
  applicationLogClient?: LogBrewClient;
  /** Override delivery for application logs when request transport is a factory or uses another destination. */
  applicationLogTransport?: Transport;
  /** Observe advisory application-log capture failures without interrupting Fastify or Pino. */
  onApplicationLogCaptureError?: (
    error: unknown,
    context: LogBrewFastifyApplicationLogContext
  ) => void | Promise<void>;
  captureRequests?: boolean;
  captureRequestMetrics?: boolean;
  now?: () => string;
  nowMs?: () => number;
  idFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
  spanIdFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
  metricName?: string;
  metricIdFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
  requestEvent?: (
    request: FastifyRequest,
    reply: FastifyReply,
    context: { client: LogBrewClient; durationMs: number; trace?: LogBrewTraceContext }
  ) => LogBrewRequestEvent;
  requestMetricEvent?: (
    request: FastifyRequest,
    reply: FastifyReply,
    context: { client: LogBrewClient; durationMs: number; trace?: LogBrewTraceContext }
  ) => LogBrewRequestMetricEvent;
  errorEvent?: (error: unknown, context: LogBrewFastifyRuntimeContext) => LogBrewErrorEvent;
  onFlush?: (response: TransportResponse, context: LogBrewFastifyRuntimeContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewFastifyRuntimeContext) => void | Promise<void>;
};

export declare function createLogBrewFastifyClient(config?: CreateLogBrewFastifyClientConfig): LogBrewClient;
export declare const logbrewFastifyPlugin: FastifyPluginAsync<LogBrewFastifyOptions>;
export declare const logbrewPlugin: typeof logbrewFastifyPlugin;
export declare function getActiveLogBrewTrace(): LogBrewTraceContext | undefined;
export declare function createRequestEvent(
  request: FastifyRequest,
  reply: FastifyReply,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
    spanIdFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
    trace?: LogBrewTraceContext;
  }
): LogBrewRequestEvent;
export declare function createRequestMetricEvent(
  request: FastifyRequest,
  reply: FastifyReply,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
    metricName?: string;
  }
): LogBrewRequestMetricEvent;
export declare function createErrorEvent(
  error: unknown,
  request: FastifyRequest,
  options?: {
    now?: () => string;
    idFactory?: (error: unknown, request: FastifyRequest) => string;
    trace?: LogBrewTraceContext;
  }
): LogBrewErrorEvent;

declare module "fastify" {
  interface FastifyRequest {
    logbrew?: LogBrewFastifyContext;
  }
}

declare const defaultExport: {
  createErrorEvent: typeof createErrorEvent;
  createLogBrewFastifyClient: typeof createLogBrewFastifyClient;
  createRequestMetricEvent: typeof createRequestMetricEvent;
  createRequestEvent: typeof createRequestEvent;
  getActiveLogBrewTrace: typeof getActiveLogBrewTrace;
  logbrewFastifyPlugin: typeof logbrewFastifyPlugin;
  logbrewPlugin: typeof logbrewPlugin;
};

export default defaultExport;
