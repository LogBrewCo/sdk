import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  SpanAttributes,
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

export type LogBrewNodeContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewNodeRuntimeContext = {
  req: IncomingMessage;
  res: ServerResponse;
  client: LogBrewClient;
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
    context: { client: LogBrewClient; durationMs: number }
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
  transport: Transport
): LogBrewNodeContext;

export declare function createHttpRequestEvent(
  req: IncomingMessage,
  res: ServerResponse,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (req: IncomingMessage, res: ServerResponse) => string;
    spanIdFactory?: (req: IncomingMessage, res: ServerResponse) => string;
  }
): LogBrewHttpRequestEvent;

export declare function createHttpErrorEvent(
  error: unknown,
  req: IncomingMessage,
  options?: {
    now?: () => string;
    idFactory?: (error: unknown, req: IncomingMessage) => string;
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
  captureHttpError: typeof captureHttpError;
  createNodeFetchTransport: typeof createNodeFetchTransport;
  createHttpErrorEvent: typeof createHttpErrorEvent;
  createHttpRequestEvent: typeof createHttpRequestEvent;
  createLogBrewNodeClient: typeof createLogBrewNodeClient;
  createLogBrewNodeContext: typeof createLogBrewNodeContext;
  withLogBrewHttpHandler: typeof withLogBrewHttpHandler;
};

export default defaultExport;
