import type {
  CreateLogBrewNodeClientConfig,
  LogBrewNodeContext,
  LogBrewTraceContext,
  NodeFetchTransportConfig
} from "./index.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  IssueAttributes,
  IssueBreadcrumbInput,
  LogAttributes,
  LogBrewClient,
  SpanAttributes,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

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
  LogBrewNodeRuntimeContext,
  LogBrewTransportFactory,
  LogBrewUserOptions
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
