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
  TelemetryContext,
  Transport,
  TransportResponse
} from "@logbrew/sdk";
import type { LogBrewTraceContext, NodeFetchTransportConfig } from "@logbrew/node";

type CreateLogBrewFastifyClientConfig = {
  serverApiKey?: string;
  apiKey?: string;
  captureRuntimeContext?: boolean;
  context?: TelemetryContext;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

type LogBrewFastifyContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  trace?: LogBrewTraceContext;
  transport: Transport;
  previewJson: () => string;
  flush: () => Promise<TransportResponse>;
  shutdown: () => Promise<TransportResponse>;
};

type LogBrewFastifyRuntimeContext = {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly client: LogBrewClient;
  readonly trace?: Readonly<LogBrewTraceContext> | undefined;
};

/** The request fields the event helpers read; a FastifyRequest has both. */
type LogBrewFastifyRequestLike = {
  readonly method?: string;
  readonly url?: string;
};

type LogBrewFastifyApplicationLogContext = {
  readonly client: LogBrewClient;
};

type LogBrewFastifyClientFactoryContext = {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
};

type LogBrewClientFactory = (context: LogBrewFastifyClientFactoryContext) => LogBrewClient;
type LogBrewTransportFactory = (context: LogBrewFastifyRuntimeContext) => Transport;

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

type LogBrewFastifyOptions = CreateLogBrewFastifyClientConfig & NodeFetchTransportConfig & {
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
  traceIdFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
  metricName?: string;
  metricIdFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
  requestEvent?: (
    request: FastifyRequest,
    reply: FastifyReply,
    context: {
      readonly client: LogBrewClient;
      readonly durationMs: number;
      readonly trace?: Readonly<LogBrewTraceContext> | undefined;
    }
  ) => LogBrewRequestEvent;
  requestMetricEvent?: (
    request: FastifyRequest,
    reply: FastifyReply,
    context: {
      readonly client: LogBrewClient;
      readonly durationMs: number;
      readonly trace?: Readonly<LogBrewTraceContext> | undefined;
    }
  ) => LogBrewRequestMetricEvent;
  errorEvent?: (error: unknown, context: LogBrewFastifyRuntimeContext) => LogBrewErrorEvent;
  onFlush?: (response: Readonly<TransportResponse>, context: LogBrewFastifyRuntimeContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewFastifyRuntimeContext) => void | Promise<void>;
};

declare function createLogBrewFastifyClient(config?: CreateLogBrewFastifyClientConfig): LogBrewClient;
declare const logbrewFastifyPlugin: FastifyPluginAsync<LogBrewFastifyOptions>;
declare const logbrewPlugin: typeof logbrewFastifyPlugin;
declare function getActiveLogBrewTrace(): LogBrewTraceContext | undefined;
declare function createRequestEvent<
  Request extends LogBrewFastifyRequestLike = FastifyRequest,
  Reply = FastifyReply
>(
  request: Request,
  reply: Reply,
  options?: {
    readonly now?: (() => string) | undefined;
    readonly durationMs?: number | undefined;
    readonly idFactory?: ((request: Request, reply: Reply) => string) | undefined;
    readonly spanIdFactory?: ((request: Request, reply: Reply) => string) | undefined;
    readonly traceIdFactory?: ((request: Request, reply: Reply) => string) | undefined;
    readonly trace?: Readonly<LogBrewTraceContext> | undefined;
  }
): LogBrewSpanRequestEvent;
declare function createRequestMetricEvent<
  Request extends LogBrewFastifyRequestLike = FastifyRequest,
  Reply = FastifyReply
>(
  request: Request,
  reply: Reply,
  options?: {
    readonly now?: (() => string) | undefined;
    readonly durationMs?: number | undefined;
    readonly idFactory?: ((request: Request, reply: Reply) => string) | undefined;
    readonly metricName?: string | undefined;
  }
): LogBrewRequestMetricEvent;
declare function createErrorEvent<Request extends LogBrewFastifyRequestLike = FastifyRequest>(
  error: unknown,
  request: Request,
  options?: {
    readonly now?: (() => string) | undefined;
    readonly idFactory?: ((error: unknown, request: Request) => string) | undefined;
    readonly trace?: Readonly<LogBrewTraceContext> | undefined;
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

export type {
  CreateLogBrewFastifyClientConfig,
  LogBrewClientFactory,
  LogBrewErrorEvent,
  LogBrewFastifyApplicationLogContext,
  LogBrewFastifyClientFactoryContext,
  LogBrewFastifyContext,
  LogBrewFastifyOptions,
  LogBrewFastifyRequestLike,
  LogBrewFastifyRuntimeContext,
  LogBrewLogRequestEvent,
  LogBrewRequestEvent,
  LogBrewRequestMetricEvent,
  LogBrewSpanRequestEvent,
  LogBrewTransportFactory
};
export {
  createErrorEvent,
  createLogBrewFastifyClient,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,
  logbrewFastifyPlugin,
  logbrewPlugin
};
export type { LogBrewTraceContext } from "@logbrew/node";
export default defaultExport;
