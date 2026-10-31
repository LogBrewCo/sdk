import type {
  DroppedEvent,
  LogBrewClient,
  TelemetryContext,
  Transport,
  TransportResponse
} from "@logbrew/sdk";
import type {
  addLogBrewBreadcrumb,
  captureHttpError,
  createHttpErrorEvent,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  createLogBrewNodeContext,
  createNodeFetchTransport,
  purgeLogBrewNodePersistentQueue,
  setLogBrewUser,
  withLogBrewHttpHandler
} from "./http-types.js";
import type {
  axiosRequestWithLogBrewSpan,
  fetchWithLogBrewSpan,
  installLogBrewFetchInstrumentation,
  instrumentLogBrewAxiosInstance
} from "./span-types.js";
import type {
  cacheOperationWithLogBrewSpan,
  databaseOperationWithLogBrewSpan,
  instrumentLogBrewMongoCollection,
  instrumentLogBrewMongooseModel,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient
} from "./data-types.js";
import type {
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  installLogBrewPinoInstrumentation,
  installLogBrewProcessErrorCapture,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} from "./queue-types.js";
import type {
  installLogBrewHttpClientInstrumentation,
  installLogBrewUndiciInstrumentation
} from "./outbound-types.js";

type CreateLogBrewNodeClientConfig = {
  serverApiKey?: string;
  apiKey?: string;
  /**
   * Record console calls, outbound HTTP requests, and Pino records as issue breadcrumbs, scoped to the
   * active request. Defaults to true.
   */
  breadcrumbs?: boolean;
  /** Add bounded Node version, OS type/release, and architecture context. Defaults to true. */
  captureRuntimeContext?: boolean;
  context?: TelemetryContext;
  /** Owned transport used for automatic delivery. Defaults to the Node fetch transport. */
  transport?: Transport;
  /** Disable to retain manual flush-only behavior. Defaults to true. */
  automaticDelivery?: boolean;
  /** One-shot delivery interval in milliseconds. Defaults to 5000 and is capped at 60000. */
  deliveryIntervalMs?: number;
  /** Queue event count that triggers immediate serialized delivery. Defaults to min(50, maxQueueSize). */
  deliveryQueueThreshold?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  sdkName?: string;
  sdkVersion?: string;
  /** Retry attempts after the first send. Must be a non-negative integer. */
  maxRetries?: number;
  maxQueueBytes?: number;
  maxQueueSize?: number;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  onEventDropped?: (drop: Readonly<DroppedEvent>) => void;
  /** Opt-in, app-scoped encrypted queue for POSIX Node runtimes. Default delivery remains memory-only. */
  persistentQueue?: LogBrewNodePersistentQueueConfig;
  /** Existing app-owned 0700 parent for the crash-safe plaintext queue. Mutually exclusive with persistentQueue. */
  persistentQueuePath?: string;
};

type LogBrewNodePersistentQueueWarning = {
  code: "accepted_prefix_recovered" | "orphaned_temp_removed" | "stale_lock_recovered";
};

type LogBrewNodePersistentQueueConfig = {
  /** Absolute, normalized, non-symlinked 0700 directory owned by the current user. */
  directory: string;
  /** Exactly 32 bytes used for AES-256-GCM. The SDK copies but never persists this key. */
  encryptionKey: Uint8Array;
  /** Content-free recovery warning callback. */
  onWarning?: (warning: Readonly<LogBrewNodePersistentQueueWarning>) => void;
};

type NodeFetchTransportConfig = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
};

type LogBrewTraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
};

type LogBrewTraceContextOptions = {
  readonly spanIdFactory?: () => string;
  readonly traceIdFactory?: () => string;
};

type LogBrewNodeContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  trace?: LogBrewTraceContext;
  /** Tag every event of this request with an opaque app-owned user ID. Returns false without a request trace. */
  setUser: (id: string, options?: { readonly kind?: "user" | "anonymous" }) => boolean;
  transport: Transport;
  previewJson: () => string;
  flush: () => Promise<TransportResponse>;
  shutdown: () => Promise<TransportResponse>;
};

declare function getActiveLogBrewTrace(): LogBrewTraceContext | undefined;

declare function runWithLogBrewTrace<Result>(
  trace: LogBrewTraceContext,
  operation: () => Result
): Result;

declare function enterWithLogBrewTrace(trace: LogBrewTraceContext): void;

declare function createLogBrewTraceContext(
  traceparent?: string,
  options?: LogBrewTraceContextOptions
): LogBrewTraceContext;

declare module "node:http" {
  interface IncomingMessage {
    logbrew?: LogBrewNodeContext;
  }
}

declare const defaultExport: {
  addLogBrewBreadcrumb: typeof addLogBrewBreadcrumb;
  axiosRequestWithLogBrewSpan: typeof axiosRequestWithLogBrewSpan;
  cacheOperationWithLogBrewSpan: typeof cacheOperationWithLogBrewSpan;
  captureHttpError: typeof captureHttpError;
  createNodeFetchTransport: typeof createNodeFetchTransport;
  createHttpErrorEvent: typeof createHttpErrorEvent;
  createHttpRequestEvent: typeof createHttpRequestEvent;
  createLogBrewNodeClient: typeof createLogBrewNodeClient;
  createLogBrewNodeContext: typeof createLogBrewNodeContext;
  createLogBrewTraceContext: typeof createLogBrewTraceContext;
  createLogBrewQueueTraceHeaders: typeof createLogBrewQueueTraceHeaders;
  createLogBrewQueueTraceLinks: typeof createLogBrewQueueTraceLinks;
  databaseOperationWithLogBrewSpan: typeof databaseOperationWithLogBrewSpan;
  fetchWithLogBrewSpan: typeof fetchWithLogBrewSpan;
  enterWithLogBrewTrace: typeof enterWithLogBrewTrace;
  getActiveLogBrewTrace: typeof getActiveLogBrewTrace;
  installLogBrewFetchInstrumentation: typeof installLogBrewFetchInstrumentation;
  installLogBrewHttpClientInstrumentation: typeof installLogBrewHttpClientInstrumentation;
  installLogBrewPinoInstrumentation: typeof installLogBrewPinoInstrumentation;
  installLogBrewProcessErrorCapture: typeof installLogBrewProcessErrorCapture;
  installLogBrewUndiciInstrumentation: typeof installLogBrewUndiciInstrumentation;
  instrumentLogBrewAxiosInstance: typeof instrumentLogBrewAxiosInstance;
  instrumentLogBrewMongoCollection: typeof instrumentLogBrewMongoCollection;
  instrumentLogBrewMongooseModel: typeof instrumentLogBrewMongooseModel;
  instrumentLogBrewPgClient: typeof instrumentLogBrewPgClient;
  instrumentLogBrewRedisClient: typeof instrumentLogBrewRedisClient;
  queueBatchOperationWithLogBrewSpan: typeof queueBatchOperationWithLogBrewSpan;
  queueOperationWithLogBrewSpan: typeof queueOperationWithLogBrewSpan;
  purgeLogBrewNodePersistentQueue: typeof purgeLogBrewNodePersistentQueue;
  runWithLogBrewTrace: typeof runWithLogBrewTrace;
  setLogBrewUser: typeof setLogBrewUser;
  withLogBrewHttpHandler: typeof withLogBrewHttpHandler;
};

export type {
  CreateLogBrewNodeClientConfig,
  LogBrewNodeContext,
  LogBrewNodePersistentQueueConfig,
  LogBrewNodePersistentQueueWarning,
  LogBrewTraceContext,
  LogBrewTraceContextOptions,
  NodeFetchTransportConfig
};
export {
  createLogBrewTraceContext,
  enterWithLogBrewTrace,
  getActiveLogBrewTrace,
  runWithLogBrewTrace
};
export type * from "./data-types.js";
export type * from "./http-types.js";
export type * from "./outbound-types.js";
export type * from "./queue-types.js";
export type * from "./span-types.js";
export {
  cacheOperationWithLogBrewSpan,
  databaseOperationWithLogBrewSpan,
  instrumentLogBrewMongoCollection,
  instrumentLogBrewMongooseModel,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient
} from "./data-types.js";
export {
  addLogBrewBreadcrumb,
  captureHttpError,
  createHttpErrorEvent,
  createHttpRequestEvent,
  createLogBrewNodeClient,
  createLogBrewNodeContext,
  createNodeFetchTransport,
  purgeLogBrewNodePersistentQueue,
  setLogBrewUser,
  withLogBrewHttpHandler
} from "./http-types.js";
export {
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  installLogBrewPinoInstrumentation,
  installLogBrewProcessErrorCapture,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} from "./queue-types.js";
export {
  axiosRequestWithLogBrewSpan,
  fetchWithLogBrewSpan,
  installLogBrewFetchInstrumentation,
  instrumentLogBrewAxiosInstance
} from "./span-types.js";
export { installLogBrewHttpClientInstrumentation, installLogBrewUndiciInstrumentation } from "./outbound-types.js";
export default defaultExport;
