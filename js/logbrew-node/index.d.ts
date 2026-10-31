import type { LogBrewClient, Transport, TransportResponse } from "@logbrew/sdk";
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

export type { LogBrewNodeContext, LogBrewTraceContext, LogBrewTraceContextOptions };
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
