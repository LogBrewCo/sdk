import type {
  DroppedEvent,
  IssueAttributes,
  IssueBreadcrumbInput,
  LogAttributes,
  LogBrewClient,
  SpanAttributes,
  TelemetryContext,
  Transport,
  TransportResponse
} from "@logbrew/sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LogBrewNodeContext, LogBrewTraceContext } from "./index.js";

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

type LogBrewNodeRuntimeContext = {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly client: LogBrewClient;
  readonly trace?: LogBrewTraceContext | undefined;
};

type LogBrewClientFactory = (
  context: Omit<LogBrewNodeRuntimeContext, "client">
) => LogBrewClient;

type LogBrewTransportFactory = (
  context: LogBrewNodeRuntimeContext
) => Transport;

type LogBrewHttpLogRequestEvent = {
  id: string;
  timestamp: string;
  type?: "log";
  attributes: LogAttributes;
};

type LogBrewHttpSpanRequestEvent = {
  id: string;
  timestamp: string;
  type: "span";
  attributes: SpanAttributes;
};

type LogBrewHttpRequestEvent = LogBrewHttpLogRequestEvent | LogBrewHttpSpanRequestEvent;

type LogBrewHttpErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

type LogBrewHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  context: LogBrewNodeContext
) => void | Promise<void>;

type LogBrewHttpRequestHookContext = {
  readonly client: LogBrewClient;
  readonly durationMs: number;
  readonly trace?: LogBrewTraceContext | undefined;
};

type LogBrewNodeOptions = Omit<CreateLogBrewNodeClientConfig, "transport"> & {
  client?: LogBrewClient | LogBrewClientFactory;
  transport?: Transport | LogBrewTransportFactory;
  captureRequests?: boolean;
  now?: () => string;
  nowMs?: () => number;
  idFactory?: (req: IncomingMessage, res: ServerResponse) => string;
  spanIdFactory?: (req: IncomingMessage, res: ServerResponse) => string;
  traceIdFactory?: (req: IncomingMessage, res: ServerResponse) => string;
  requestEvent?: (
    req: IncomingMessage,
    res: ServerResponse,
    context: LogBrewHttpRequestHookContext
  ) => LogBrewHttpRequestEvent;
  errorEvent?: (
    error: unknown,
    context: LogBrewNodeRuntimeContext
  ) => LogBrewHttpErrorEvent;
  onFlush?: (
    response: Readonly<TransportResponse>,
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

type LogBrewHttpRequestEventOptions = {
  now?: () => string;
  durationMs?: number;
  idFactory?: (req: IncomingMessage, res: ServerResponse) => string;
  spanIdFactory?: (req: IncomingMessage, res: ServerResponse) => string;
  traceIdFactory?: (req: IncomingMessage, res: ServerResponse) => string;
  trace?: LogBrewTraceContext | undefined;
};

type LogBrewHttpErrorEventOptions = {
  now?: () => string;
  idFactory?: (error: unknown, req: IncomingMessage) => string;
  trace?: LogBrewTraceContext | undefined;
};

type LogBrewUserOptions = {
  readonly kind?: "user" | "anonymous";
  readonly trace?: Readonly<LogBrewTraceContext>;
};

type LogBrewBreadcrumbInput = IssueBreadcrumbInput & { timestamp?: string };

declare function createLogBrewNodeClient(
  config?: CreateLogBrewNodeClientConfig
): LogBrewClient;

declare function purgeLogBrewNodePersistentQueue(
  config: { readonly persistentQueuePath: string }
): boolean;

declare function createNodeFetchTransport(
  config?: NodeFetchTransportConfig
): Transport;

declare function withLogBrewHttpHandler(
  handler: LogBrewHttpHandler,
  options?: LogBrewNodeOptions
): (req: IncomingMessage, res: ServerResponse) => void;

declare function createLogBrewNodeContext(
  client: LogBrewClient,
  transport: Transport,
  trace?: LogBrewTraceContext
): LogBrewNodeContext;

/** Add an app-owned breadcrumb to the active request scope, or the process scope outside a request. */
declare function addLogBrewBreadcrumb(breadcrumb: LogBrewBreadcrumbInput): void;

/**
 * Tag every event of the active request with an opaque app-owned user ID (not an email or name).
 * Returns false outside a request trace, so one request's user never reaches another request.
 */
declare function setLogBrewUser(
  id: string,
  options?: LogBrewUserOptions
): boolean;

declare function createHttpRequestEvent(
  req: IncomingMessage,
  res: ServerResponse,
  options?: LogBrewHttpRequestEventOptions
): LogBrewHttpSpanRequestEvent;

declare function createHttpErrorEvent(
  error: unknown,
  req: IncomingMessage,
  options?: LogBrewHttpErrorEventOptions
): LogBrewHttpErrorEvent;

declare function captureHttpError(
  error: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  context: LogBrewNodeContext,
  options?: LogBrewNodeOptions
): Promise<TransportResponse>;

export type {
  CreateLogBrewNodeClientConfig,
  LogBrewBreadcrumbInput,
  LogBrewClientFactory,
  LogBrewHttpErrorEvent,
  LogBrewHttpErrorEventOptions,
  LogBrewHttpHandler,
  LogBrewHttpLogRequestEvent,
  LogBrewHttpRequestEvent,
  LogBrewHttpRequestEventOptions,
  LogBrewHttpRequestHookContext,
  LogBrewHttpSpanRequestEvent,
  LogBrewNodeOptions,
  LogBrewNodePersistentQueueConfig,
  LogBrewNodePersistentQueueWarning,
  LogBrewNodeRuntimeContext,
  LogBrewTransportFactory,
  LogBrewUserOptions,
  NodeFetchTransportConfig
};
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
};
