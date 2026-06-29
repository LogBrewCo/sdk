import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  SpanAttributes,
  SpanEventSummary,
  SpanLinkSummary,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewNodeClientConfig = {
  serverApiKey?: string;
  apiKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type NodeFetchTransportConfig = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
};

export type LogBrewTraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
};

export type LogBrewQueueTraceHeaders = {
  traceparent?: string;
};

export type LogBrewQueueTraceCarrier = string | {
  traceparent?: unknown;
  traceParent?: unknown;
  get?: (name: string) => unknown;
};

export type LogBrewQueueBatchMessage = LogBrewQueueTraceCarrier | {
  headers?: LogBrewQueueTraceCarrier;
  [key: string]: unknown;
};

export type LogBrewNodeContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  trace?: LogBrewTraceContext;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewNodeRuntimeContext = {
  req: IncomingMessage;
  res: ServerResponse;
  client: LogBrewClient;
  trace?: LogBrewTraceContext;
};

export type LogBrewClientFactory = (
  context: Omit<LogBrewNodeRuntimeContext, "client">
) => LogBrewClient;

export type LogBrewTransportFactory = (
  context: LogBrewNodeRuntimeContext
) => Transport;

export type LogBrewHttpLogRequestEvent = {
  id: string;
  timestamp: string;
  type?: "log";
  attributes: LogAttributes;
};

export type LogBrewHttpSpanRequestEvent = {
  id: string;
  timestamp: string;
  type: "span";
  attributes: SpanAttributes;
};

export type LogBrewHttpRequestEvent = LogBrewHttpLogRequestEvent | LogBrewHttpSpanRequestEvent;

export type LogBrewHttpErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

export type LogBrewHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  context: LogBrewNodeContext
) => void | Promise<void>;

export type LogBrewNodeOptions = CreateLogBrewNodeClientConfig & {
  client?: LogBrewClient | LogBrewClientFactory;
  transport?: Transport | LogBrewTransportFactory;
  captureRequests?: boolean;
  now?: () => string;
  nowMs?: () => number;
  idFactory?: (req: IncomingMessage, res: ServerResponse) => string;
  spanIdFactory?: (req: IncomingMessage, res: ServerResponse) => string;
  requestEvent?: (
    req: IncomingMessage,
    res: ServerResponse,
    context: { client: LogBrewClient; durationMs: number; trace?: LogBrewTraceContext }
  ) => LogBrewHttpRequestEvent;
  errorEvent?: (
    error: unknown,
    context: LogBrewNodeRuntimeContext
  ) => LogBrewHttpErrorEvent;
  onFlush?: (
    response: TransportResponse,
    context: LogBrewNodeRuntimeContext
  ) => void | Promise<void>;
  onCaptureError?: (
    error: unknown,
    context: LogBrewNodeRuntimeContext
  ) => void | Promise<void>;
  onError?: (
    error: unknown,
    context: LogBrewNodeRuntimeContext
  ) => void | Promise<void>;
};

export type FetchWithLogBrewSpanOptions = {
  client: LogBrewClient;
  fetchImpl?: typeof fetch;
  trace?: LogBrewTraceContext;
  id?: string;
  routeTemplate?: string;
  events?: SpanEventSummary[];
  links?: SpanLinkSummary[];
  metadata?: Record<string, string | number | boolean | null>;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: (
    error: unknown,
    context: {
      client: LogBrewClient;
      error?: unknown;
      response?: Response;
      trace: LogBrewTraceContext;
    }
  ) => void | Promise<void>;
};

export type DatabaseOperationWithLogBrewSpanOptions<Result = unknown> = {
  client: LogBrewClient;
  operation: () => Result | Promise<Result>;
  system?: string;
  operationKind?: string;
  databaseName?: string;
  statementTemplate?: string;
  rowCount?: number;
  trace?: LogBrewTraceContext;
  id?: string;
  events?: SpanEventSummary[];
  links?: SpanLinkSummary[];
  metadata?: Record<string, string | number | boolean | null>;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: (
    error: unknown,
    context: {
      client: LogBrewClient;
      error?: unknown;
      trace: LogBrewTraceContext;
    }
  ) => void | Promise<void>;
};

export type LogBrewPgQueryable = {
  query: (...args: unknown[]) => unknown;
};

export type LogBrewPgInstrumentation = {
  isInstalled(): boolean;
  uninstall(): void;
};

export type LogBrewPgClientInstrumentationOptions = {
  client: LogBrewClient;
  databaseName?: string;
  operationKind?: string;
  operationName?: string;
  trace?: LogBrewTraceContext;
  id?: string;
  metadata?: Record<string, string | number | boolean | null>;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: (
    error: unknown,
    context: {
      client: LogBrewClient;
      error?: unknown;
      trace: LogBrewTraceContext;
    }
  ) => void | Promise<void>;
};

export type LogBrewRedisCommand =
  | string
  | Array<string | number | Buffer>
  | {
      name?: string;
      args?: unknown[];
      [key: string]: unknown;
    };

export type LogBrewRedisCommandClient = {
  sendCommand: (command: LogBrewRedisCommand, ...args: unknown[]) => unknown;
  connect?: (...args: unknown[]) => unknown;
};

export type LogBrewRedisClientInstrumentation = {
  isInstalled(): boolean;
  uninstall(): void;
};

export type LogBrewRedisClientInstrumentationOptions = {
  client: LogBrewClient;
  cacheName?: string;
  operationKind?: string;
  operationName?: string;
  trace?: LogBrewTraceContext;
  id?: string;
  metadata?: Record<string, string | number | boolean | null>;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: (
    error: unknown,
    context: {
      client: LogBrewClient;
      error?: unknown;
      trace: LogBrewTraceContext;
    }
  ) => void | Promise<void>;
};

export type CacheOperationWithLogBrewSpanOptions<Result = unknown> = {
  client: LogBrewClient;
  operation: () => Result | Promise<Result>;
  system?: string;
  operationKind?: string;
  cacheName?: string;
  hit?: boolean;
  itemSizeBytes?: number;
  itemCount?: number;
  trace?: LogBrewTraceContext;
  id?: string;
  events?: SpanEventSummary[];
  links?: SpanLinkSummary[];
  metadata?: Record<string, string | number | boolean | null>;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: (
    error: unknown,
    context: {
      client: LogBrewClient;
      error?: unknown;
      trace: LogBrewTraceContext;
    }
  ) => void | Promise<void>;
};

export type QueueOperationWithLogBrewSpanOptions<Result = unknown> = {
  client: LogBrewClient;
  operation: () => Result | Promise<Result>;
  system?: string;
  operationKind?: string;
  queueName?: string;
  taskName?: string;
  messageCount?: number;
  traceparent?: string;
  trace?: LogBrewTraceContext;
  id?: string;
  events?: SpanEventSummary[];
  links?: SpanLinkSummary[];
  metadata?: Record<string, string | number | boolean | null>;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: (
    error: unknown,
    context: {
      client: LogBrewClient;
      error?: unknown;
      trace: LogBrewTraceContext;
    }
  ) => void | Promise<void>;
};

export type QueueBatchOperationWithLogBrewSpanOptions<Result = unknown> = QueueOperationWithLogBrewSpanOptions<Result> & {
  messages?: LogBrewQueueBatchMessage[];
  linkMetadata?: Record<string, string | number | boolean | null>;
};

export declare function createLogBrewNodeClient(
  config?: CreateLogBrewNodeClientConfig
): LogBrewClient;

export declare function createNodeFetchTransport(
  config?: NodeFetchTransportConfig
): Transport;

export declare function withLogBrewHttpHandler(
  handler: LogBrewHttpHandler,
  options?: LogBrewNodeOptions
): (req: IncomingMessage, res: ServerResponse) => void;

export declare function createLogBrewNodeContext(
  client: LogBrewClient,
  transport: Transport,
  trace?: LogBrewTraceContext
): LogBrewNodeContext;

export declare function getActiveLogBrewTrace(): LogBrewTraceContext | undefined;

export declare function createLogBrewQueueTraceHeaders(
  trace?: LogBrewTraceContext
): LogBrewQueueTraceHeaders;

export declare function createLogBrewQueueTraceLinks(
  carriers?: LogBrewQueueTraceCarrier | Array<LogBrewQueueTraceCarrier | undefined>,
  metadata?: Record<string, string | number | boolean | null>
): SpanLinkSummary[];

export declare function fetchWithLogBrewSpan(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined,
  options: FetchWithLogBrewSpanOptions
): Promise<Response>;

export declare function databaseOperationWithLogBrewSpan<Result>(
  operationName: string,
  options: DatabaseOperationWithLogBrewSpanOptions<Result>
): Promise<Awaited<Result>>;

export declare function instrumentLogBrewPgClient(
  pgClient: LogBrewPgQueryable,
  options: LogBrewPgClientInstrumentationOptions
): LogBrewPgInstrumentation;

export declare function instrumentLogBrewRedisClient(
  redisClient: LogBrewRedisCommandClient,
  options: LogBrewRedisClientInstrumentationOptions
): LogBrewRedisClientInstrumentation;

export declare function cacheOperationWithLogBrewSpan<Result>(
  operationName: string,
  options: CacheOperationWithLogBrewSpanOptions<Result>
): Promise<Awaited<Result>>;

export declare function queueOperationWithLogBrewSpan<Result>(
  operationName: string,
  options: QueueOperationWithLogBrewSpanOptions<Result>
): Promise<Awaited<Result>>;

export declare function queueBatchOperationWithLogBrewSpan<Result>(
  operationName: string,
  options: QueueBatchOperationWithLogBrewSpanOptions<Result>
): Promise<Awaited<Result>>;

export declare function createHttpRequestEvent(
  req: IncomingMessage,
  res: ServerResponse,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (req: IncomingMessage, res: ServerResponse) => string;
    spanIdFactory?: (req: IncomingMessage, res: ServerResponse) => string;
    trace?: LogBrewTraceContext;
  }
): LogBrewHttpRequestEvent;

export declare function createHttpErrorEvent(
  error: unknown,
  req: IncomingMessage,
  options?: {
    now?: () => string;
    idFactory?: (error: unknown, req: IncomingMessage) => string;
    trace?: LogBrewTraceContext;
  }
): LogBrewHttpErrorEvent;

export declare function captureHttpError(
  error: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  context: LogBrewNodeContext,
  options?: LogBrewNodeOptions
): Promise<TransportResponse>;

declare module "node:http" {
  interface IncomingMessage {
    logbrew?: LogBrewNodeContext;
  }
}

declare const defaultExport: {
  cacheOperationWithLogBrewSpan: typeof cacheOperationWithLogBrewSpan;
  captureHttpError: typeof captureHttpError;
  createNodeFetchTransport: typeof createNodeFetchTransport;
  createHttpErrorEvent: typeof createHttpErrorEvent;
  createHttpRequestEvent: typeof createHttpRequestEvent;
  createLogBrewNodeClient: typeof createLogBrewNodeClient;
  createLogBrewNodeContext: typeof createLogBrewNodeContext;
  createLogBrewQueueTraceHeaders: typeof createLogBrewQueueTraceHeaders;
  createLogBrewQueueTraceLinks: typeof createLogBrewQueueTraceLinks;
  databaseOperationWithLogBrewSpan: typeof databaseOperationWithLogBrewSpan;
  fetchWithLogBrewSpan: typeof fetchWithLogBrewSpan;
  getActiveLogBrewTrace: typeof getActiveLogBrewTrace;
  instrumentLogBrewPgClient: typeof instrumentLogBrewPgClient;
  instrumentLogBrewRedisClient: typeof instrumentLogBrewRedisClient;
  queueBatchOperationWithLogBrewSpan: typeof queueBatchOperationWithLogBrewSpan;
  queueOperationWithLogBrewSpan: typeof queueOperationWithLogBrewSpan;
  withLogBrewHttpHandler: typeof withLogBrewHttpHandler;
};

export default defaultExport;
