import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type {
  DroppedEvent,
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
  /** Retry attempts after the first send. Must be a non-negative integer. */
  maxRetries?: number;
  maxQueueBytes?: number;
  maxQueueSize?: number;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  onEventDropped?: (drop: DroppedEvent) => void;
  /** Existing POSIX owner-only parent directory for opt-in crash-safe Node delivery. */
  persistentQueuePath?: string;
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

export type LogBrewFetchTimings = {
  connectMs?: number;
  decodedBodySize?: number;
  encodedBodySize?: number;
  nameLookupMs?: number;
  redirectMs?: number;
  requestBodyBytes?: number;
  requestMs?: number;
  responseBodyBytes?: number;
  responseMs?: number;
  tlsMs?: number;
  waitMs?: number;
};

export type LogBrewFetchTimingContext = {
  durationMs: number;
  error?: unknown;
  method: string;
  path: string;
  response?: Response;
  trace: LogBrewTraceContext;
};

export type LogBrewFetchTimingSource =
  | LogBrewFetchTimings
  | ((context: LogBrewFetchTimingContext) => LogBrewFetchTimings | null | undefined);

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
  timings?: LogBrewFetchTimingSource;
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

export type LogBrewFetchInstrumentationContext = {
  input: Parameters<typeof fetch>[0];
  init?: Parameters<typeof fetch>[1];
  method: string;
  path: string;
  url: string;
};

export type LogBrewFetchInstrumentationTarget =
  | string
  | RegExp
  | ((context: LogBrewFetchInstrumentationContext) => boolean);

export type LogBrewFetchInstrumentationHandle = {
  isInstalled(): boolean;
  uninstall(): void;
};

export type LogBrewAxiosRequestConfig = {
  baseURL?: string;
  data?: unknown;
  headers?: unknown;
  method?: string;
  url?: string;
  [key: string]: unknown;
};

export type LogBrewAxiosInstanceLike = {
  request: (config: any) => unknown;
  delete?: (url: string, config?: any) => unknown;
  get?: (url: string, config?: any) => unknown;
  head?: (url: string, config?: any) => unknown;
  options?: (url: string, config?: any) => unknown;
  patch?: (url: string, data?: unknown, config?: any) => unknown;
  post?: (url: string, data?: unknown, config?: any) => unknown;
  put?: (url: string, data?: unknown, config?: any) => unknown;
};

export type LogBrewAxiosInstrumentableInstance = LogBrewAxiosInstanceLike & {
  interceptors: {
    request: {
      use: (onFulfilled: (config: any) => any) => number;
      eject: (id: number) => void;
    };
    response: {
      use: (
        onFulfilled: (response: unknown) => unknown | Promise<unknown>,
        onRejected: (error: unknown) => unknown | Promise<unknown>
      ) => number;
      eject: (id: number) => void;
    };
  };
};

export type LogBrewAxiosInstrumentationContext = {
  config: LogBrewAxiosRequestConfig;
  method: string;
  path: string;
  routeTemplate?: string;
  url: string;
};

export type LogBrewAxiosInstrumentationTarget =
  | string
  | RegExp
  | ((context: LogBrewAxiosInstrumentationContext) => boolean);

export type LogBrewAxiosInstrumentation = {
  isInstalled(): boolean;
  uninstall(): void;
};

export type LogBrewAxiosSpanOptions = {
  client: LogBrewClient;
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
      response?: unknown;
      trace: LogBrewTraceContext;
    }
  ) => void | Promise<void>;
};

export type LogBrewAxiosInstrumentationOptions = LogBrewAxiosSpanOptions & {
  captureTargets?: LogBrewAxiosInstrumentationTarget | LogBrewAxiosInstrumentationTarget[];
  routeTemplateFactory?: (context: LogBrewAxiosInstrumentationContext) => string;
  tracePropagationTargets?: LogBrewAxiosInstrumentationTarget | LogBrewAxiosInstrumentationTarget[];
};

export type LogBrewHttpClientModule = {
  request: (...args: any[]) => ClientRequest;
  get: (...args: any[]) => ClientRequest;
};

export type LogBrewHttpClientInstrumentationModules = {
  http?: LogBrewHttpClientModule;
  https?: LogBrewHttpClientModule;
};

export type LogBrewHttpClientInstrumentationContext = {
  method: string;
  module: string;
  path: string;
  protocol: string;
  url: string;
};

export type LogBrewHttpClientInstrumentationTarget =
  | string
  | RegExp
  | ((context: LogBrewHttpClientInstrumentationContext) => boolean);

export type LogBrewHttpClientInstrumentation = {
  isInstalled(): boolean;
  uninstall(): void;
};

export type LogBrewHttpClientInstrumentationOptions = {
  client: LogBrewClient;
  modules: LogBrewHttpClientInstrumentationModules;
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
  captureTargets?: LogBrewHttpClientInstrumentationTarget | LogBrewHttpClientInstrumentationTarget[];
  routeTemplateFactory?: (context: LogBrewHttpClientInstrumentationContext) => string;
  tracePropagationTargets?: LogBrewHttpClientInstrumentationTarget | LogBrewHttpClientInstrumentationTarget[];
  onCaptureError?: (
    error: unknown,
    context: {
      client: LogBrewClient;
      error?: unknown;
      response?: IncomingMessage;
      trace: LogBrewTraceContext;
    }
  ) => void | Promise<void>;
};

export type LogBrewUndiciInstrumentationContext = {
  method: string;
  path: string;
  url: string;
};

export type LogBrewUndiciInstrumentationTarget =
  | string
  | RegExp
  | ((context: LogBrewUndiciInstrumentationContext) => boolean);

export type LogBrewUndiciInstrumentationHandle = {
  isInstalled(): boolean;
  uninstall(): void;
};

export type LogBrewFetchInstrumentationOptions = Omit<
  FetchWithLogBrewSpanOptions,
  "fetchImpl" | "routeTemplate"
> & {
  globalObject?: {
    fetch?: typeof fetch;
  };
  captureTargets?: LogBrewFetchInstrumentationTarget | LogBrewFetchInstrumentationTarget[];
  routeTemplate?: string;
  routeTemplateFactory?: (context: LogBrewFetchInstrumentationContext) => string;
  tracePropagationTargets?: LogBrewFetchInstrumentationTarget | LogBrewFetchInstrumentationTarget[];
};

export type LogBrewUndiciInstrumentationOptions = {
  client: LogBrewClient;
  trace?: LogBrewTraceContext;
  metadata?: Record<string, string | number | boolean | null>;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  captureTargets?: LogBrewUndiciInstrumentationTarget | LogBrewUndiciInstrumentationTarget[];
  routeTemplate?: string;
  routeTemplateFactory?: (context: LogBrewUndiciInstrumentationContext) => string;
  tracePropagationTargets?: LogBrewUndiciInstrumentationTarget | LogBrewUndiciInstrumentationTarget[];
  onCaptureError?: (
    error: unknown,
    context: {
      client: LogBrewClient;
      error?: unknown;
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
  multi?: (...args: unknown[]) => LogBrewRedisPipeline;
  MULTI?: (...args: unknown[]) => LogBrewRedisPipeline;
  pipeline?: (...args: unknown[]) => LogBrewRedisPipeline;
};

export type LogBrewRedisPipeline = {
  addCommand?: (command: LogBrewRedisCommand, ...args: unknown[]) => LogBrewRedisPipeline | unknown;
  exec?: (...args: unknown[]) => unknown;
  execAsPipeline?: (...args: unknown[]) => unknown;
  [commandName: string]: unknown;
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
  tracePipelines?: boolean;
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

export type LogBrewMongoCursor = {
  forEach?: (...args: unknown[]) => unknown;
  hasNext?: (...args: unknown[]) => unknown;
  next?: (...args: unknown[]) => unknown;
  toArray?: (...args: unknown[]) => unknown;
  tryNext?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
};

export type LogBrewMongoCollection = {
  collectionName?: string;
  dbName?: string;
  namespace?: string | {
    db?: string;
    collection?: string;
  };
  aggregate?: (...args: unknown[]) => LogBrewMongoCursor | unknown;
  bulkWrite?: (...args: unknown[]) => unknown;
  count?: (...args: unknown[]) => unknown;
  countDocuments?: (...args: unknown[]) => unknown;
  deleteMany?: (...args: unknown[]) => unknown;
  deleteOne?: (...args: unknown[]) => unknown;
  distinct?: (...args: unknown[]) => unknown;
  estimatedDocumentCount?: (...args: unknown[]) => unknown;
  find?: (...args: unknown[]) => LogBrewMongoCursor | unknown;
  findOne?: (...args: unknown[]) => unknown;
  insertMany?: (...args: unknown[]) => unknown;
  insertOne?: (...args: unknown[]) => unknown;
  replaceOne?: (...args: unknown[]) => unknown;
  updateMany?: (...args: unknown[]) => unknown;
  updateOne?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
};

export type LogBrewMongoCollectionInstrumentation = {
  isInstalled(): boolean;
  uninstall(): void;
};

export type LogBrewMongoCollectionInstrumentationOptions = {
  client: LogBrewClient;
  databaseName?: string;
  collectionName?: string;
  operationKind?: string;
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

export type LogBrewMongooseExecutable = {
  exec?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
};

export type LogBrewMongooseDocumentPrototype = {
  save?: (...args: unknown[]) => unknown;
  $save?: (...args: unknown[]) => unknown;
  updateOne?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  deleteOne?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  [key: string]: unknown;
};

export type LogBrewMongooseModel = {
  modelName?: string;
  collection?: {
    collectionName?: string;
    name?: string;
    [key: string]: unknown;
  };
  prototype?: LogBrewMongooseDocumentPrototype;
  aggregate?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  bulkWrite?: (...args: unknown[]) => unknown;
  count?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  countDocuments?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  create?: (...args: unknown[]) => unknown;
  deleteMany?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  deleteOne?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  distinct?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  estimatedDocumentCount?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  find?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  findById?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  findByIdAndDelete?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  findByIdAndRemove?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  findByIdAndUpdate?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  findOne?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  findOneAndDelete?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  findOneAndRemove?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  findOneAndReplace?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  findOneAndUpdate?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  insertMany?: (...args: unknown[]) => unknown;
  replaceOne?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  updateMany?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  updateOne?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  where?: (...args: unknown[]) => LogBrewMongooseExecutable | unknown;
  [key: string]: unknown;
};

export type LogBrewMongooseModelInstrumentation = {
  isInstalled(): boolean;
  uninstall(): void;
};

export type LogBrewMongooseModelInstrumentationOptions = {
  client: LogBrewClient;
  databaseName?: string;
  collectionName?: string;
  modelName?: string;
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

export declare function axiosRequestWithLogBrewSpan<Instance extends LogBrewAxiosInstanceLike>(
  axiosInstance: Instance,
  config: Parameters<Instance["request"]>[0],
  options: LogBrewAxiosSpanOptions
): Promise<Awaited<ReturnType<Instance["request"]>>>;

export declare function instrumentLogBrewAxiosInstance<Instance extends LogBrewAxiosInstrumentableInstance>(
  axiosInstance: Instance,
  options: LogBrewAxiosInstrumentationOptions
): LogBrewAxiosInstrumentation;

export declare function installLogBrewFetchInstrumentation(
  options: LogBrewFetchInstrumentationOptions
): LogBrewFetchInstrumentationHandle;

export declare function installLogBrewHttpClientInstrumentation(
  options: LogBrewHttpClientInstrumentationOptions
): LogBrewHttpClientInstrumentation;

export declare function installLogBrewUndiciInstrumentation(
  options: LogBrewUndiciInstrumentationOptions
): LogBrewUndiciInstrumentationHandle;

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

export declare function instrumentLogBrewMongoCollection(
  mongoCollection: LogBrewMongoCollection,
  options: LogBrewMongoCollectionInstrumentationOptions
): LogBrewMongoCollectionInstrumentation;

export declare function instrumentLogBrewMongooseModel(
  mongooseModel: LogBrewMongooseModel,
  options: LogBrewMongooseModelInstrumentationOptions
): LogBrewMongooseModelInstrumentation;

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

/** Remove the inactive SDK-owned persistent queue directory without following links. */
export declare function purgeLogBrewNodePersistentQueue(config: {
  persistentQueuePath: string;
}): boolean;

declare module "node:http" {
  interface IncomingMessage {
    logbrew?: LogBrewNodeContext;
  }
}

declare const defaultExport: {
  axiosRequestWithLogBrewSpan: typeof axiosRequestWithLogBrewSpan;
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
  installLogBrewFetchInstrumentation: typeof installLogBrewFetchInstrumentation;
  installLogBrewHttpClientInstrumentation: typeof installLogBrewHttpClientInstrumentation;
  installLogBrewUndiciInstrumentation: typeof installLogBrewUndiciInstrumentation;
  instrumentLogBrewAxiosInstance: typeof instrumentLogBrewAxiosInstance;
  instrumentLogBrewMongoCollection: typeof instrumentLogBrewMongoCollection;
  instrumentLogBrewMongooseModel: typeof instrumentLogBrewMongooseModel;
  instrumentLogBrewPgClient: typeof instrumentLogBrewPgClient;
  instrumentLogBrewRedisClient: typeof instrumentLogBrewRedisClient;
  queueBatchOperationWithLogBrewSpan: typeof queueBatchOperationWithLogBrewSpan;
  queueOperationWithLogBrewSpan: typeof queueOperationWithLogBrewSpan;
  purgeLogBrewNodePersistentQueue: typeof purgeLogBrewNodePersistentQueue;
  withLogBrewHttpHandler: typeof withLogBrewHttpHandler;
};

export default defaultExport;
