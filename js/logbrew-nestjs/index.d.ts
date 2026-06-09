import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Observable } from "rxjs";
import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  MetricAttributes,
  SpanAttributes,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewNestClientConfig = {
  serverApiKey?: string;
  apiKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type LogBrewNestContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewNestRuntimeContext = {
  executionContext: ExecutionContext;
  request: Request;
  response: Response;
  client: LogBrewClient;
};

export type LogBrewClientFactory = (context: Omit<LogBrewNestRuntimeContext, "client">) => LogBrewClient;
export type LogBrewTransportFactory = (context: LogBrewNestRuntimeContext) => Transport;

export type LogBrewRequestLogEvent = {
  id: string;
  timestamp: string;
  type?: "log";
  attributes: LogAttributes;
};

export type LogBrewRequestSpanEvent = {
  id: string;
  timestamp: string;
  type: "span";
  attributes: SpanAttributes;
};

export type LogBrewRequestEvent = LogBrewRequestLogEvent | LogBrewRequestSpanEvent;

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

export type LogBrewNestOptions = CreateLogBrewNestClientConfig & {
  client?: LogBrewClient | LogBrewClientFactory;
  transport?: Transport | LogBrewTransportFactory;
  captureRequests?: boolean;
  captureRequestMetrics?: boolean;
  now?: () => string;
  nowMs?: () => number;
  idFactory?: (request: Request, response: Response) => string;
  spanIdFactory?: (request: Request, response: Response) => string;
  metricName?: string;
  metricIdFactory?: (request: Request, response: Response) => string;
  requestEvent?: (
    request: Request,
    response: Response,
    context: { client: LogBrewClient; durationMs: number; executionContext: ExecutionContext }
  ) => LogBrewRequestEvent;
  requestMetricEvent?: (
    request: Request,
    response: Response,
    context: { client: LogBrewClient; durationMs: number; executionContext: ExecutionContext }
  ) => LogBrewRequestMetricEvent;
  errorEvent?: (error: unknown, context: LogBrewNestRuntimeContext) => LogBrewErrorEvent;
  onFlush?: (response: TransportResponse, context: LogBrewNestRuntimeContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewNestRuntimeContext) => void | Promise<void>;
};

export declare function createLogBrewNestClient(config?: CreateLogBrewNestClientConfig): LogBrewClient;
export declare class LogBrewInterceptor implements NestInterceptor {
  constructor(options?: LogBrewNestOptions);
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>;
}
export declare function createRequestEvent(
  request: Request,
  response: Response,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (request: Request, response: Response) => string;
    spanIdFactory?: (request: Request, response: Response) => string;
  }
): LogBrewRequestEvent;
export declare function createErrorEvent(
  error: unknown,
  request: Request,
  options?: {
    now?: () => string;
    idFactory?: (error: unknown, request: Request) => string;
  }
): LogBrewErrorEvent;
export declare function createRequestMetricEvent(
  request: Request,
  response: Response,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (request: Request, response: Response) => string;
    metricName?: string;
  }
): LogBrewRequestMetricEvent;

declare global {
  namespace Express {
    interface Request {
      logbrew?: LogBrewNestContext;
    }
  }
}

declare const defaultExport: {
  createErrorEvent: typeof createErrorEvent;
  createLogBrewNestClient: typeof createLogBrewNestClient;
  createRequestMetricEvent: typeof createRequestMetricEvent;
  createRequestEvent: typeof createRequestEvent;
  LogBrewInterceptor: typeof LogBrewInterceptor;
};

export default defaultExport;
