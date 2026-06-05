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
  SpanAttributes,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewFastifyClientConfig = {
  serverApiKey?: string;
  apiKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type LogBrewFastifyContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewFastifyRuntimeContext = {
  request: FastifyRequest;
  reply: FastifyReply;
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

export type LogBrewFastifyOptions = CreateLogBrewFastifyClientConfig & {
  client?: LogBrewClient | LogBrewClientFactory;
  transport?: Transport | LogBrewTransportFactory;
  captureRequests?: boolean;
  now?: () => string;
  nowMs?: () => number;
  idFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
  spanIdFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
  requestEvent?: (
    request: FastifyRequest,
    reply: FastifyReply,
    context: { client: LogBrewClient; durationMs: number }
  ) => LogBrewRequestEvent;
  errorEvent?: (error: unknown, context: LogBrewFastifyRuntimeContext) => LogBrewErrorEvent;
  onFlush?: (response: TransportResponse, context: LogBrewFastifyRuntimeContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewFastifyRuntimeContext) => void | Promise<void>;
};

export declare function createLogBrewFastifyClient(config?: CreateLogBrewFastifyClientConfig): LogBrewClient;
export declare const logbrewFastifyPlugin: FastifyPluginAsync<LogBrewFastifyOptions>;
export declare const logbrewPlugin: typeof logbrewFastifyPlugin;
export declare function createRequestEvent(
  request: FastifyRequest,
  reply: FastifyReply,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
    spanIdFactory?: (request: FastifyRequest, reply: FastifyReply) => string;
  }
): LogBrewRequestEvent;
export declare function createErrorEvent(
  error: unknown,
  request: FastifyRequest,
  options?: {
    now?: () => string;
    idFactory?: (error: unknown, request: FastifyRequest) => string;
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
  createRequestEvent: typeof createRequestEvent;
  logbrewFastifyPlugin: typeof logbrewFastifyPlugin;
  logbrewPlugin: typeof logbrewPlugin;
};

export default defaultExport;
