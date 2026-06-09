import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  MetricAttributes,
  SpanAttributes,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewExpressClientConfig = {
  serverApiKey?: string;
  apiKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type LogBrewExpressContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewExpressRuntimeContext = {
  req: Request;
  res: Response;
  client: LogBrewClient;
};

export type LogBrewClientFactory = (context: Omit<LogBrewExpressRuntimeContext, "client">) => LogBrewClient;
export type LogBrewTransportFactory = (context: LogBrewExpressRuntimeContext) => Transport;

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

export type LogBrewRequestMetricEvent = {
  id: string;
  timestamp: string;
  attributes: MetricAttributes;
};

export type LogBrewExpressOptions = CreateLogBrewExpressClientConfig & {
  client?: LogBrewClient | LogBrewClientFactory;
  transport?: Transport | LogBrewTransportFactory;
  captureRequests?: boolean;
  captureRequestMetrics?: boolean;
  now?: () => string;
  nowMs?: () => number;
  idFactory?: (req: Request, res: Response) => string;
  spanIdFactory?: (req: Request, res: Response) => string;
  metricName?: string;
  metricIdFactory?: (req: Request, res: Response) => string;
  requestEvent?: (
    req: Request,
    res: Response,
    context: { client: LogBrewClient; durationMs: number }
  ) => LogBrewRequestEvent;
  requestMetricEvent?: (
    req: Request,
    res: Response,
    context: { client: LogBrewClient; durationMs: number }
  ) => LogBrewRequestMetricEvent;
  errorEvent?: (error: unknown, context: LogBrewExpressRuntimeContext) => LogBrewErrorEvent;
  onFlush?: (response: TransportResponse, context: LogBrewExpressRuntimeContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewExpressRuntimeContext) => void | Promise<void>;
};

export declare function createLogBrewExpressClient(config?: CreateLogBrewExpressClientConfig): LogBrewClient;
export declare function logbrewMiddleware(options?: LogBrewExpressOptions): RequestHandler;
export declare function logbrewErrorHandler(options?: LogBrewExpressOptions): ErrorRequestHandler;
export declare function createRequestEvent(
  req: Request,
  res: Response,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (req: Request, res: Response) => string;
    spanIdFactory?: (req: Request, res: Response) => string;
  }
): LogBrewRequestEvent;
export declare function createErrorEvent(
  error: unknown,
  req: Request,
  options?: {
    now?: () => string;
    idFactory?: (error: unknown, req: Request) => string;
  }
): LogBrewErrorEvent;
export declare function createRequestMetricEvent(
  req: Request,
  res: Response,
  options?: {
    now?: () => string;
    durationMs?: number;
    idFactory?: (req: Request, res: Response) => string;
    metricName?: string;
  }
): LogBrewRequestMetricEvent;

declare global {
  namespace Express {
    interface Request {
      logbrew?: LogBrewExpressContext;
    }
  }
}

declare const defaultExport: {
  createErrorEvent: typeof createErrorEvent;
  createLogBrewExpressClient: typeof createLogBrewExpressClient;
  createRequestMetricEvent: typeof createRequestMetricEvent;
  createRequestEvent: typeof createRequestEvent;
  logbrewErrorHandler: typeof logbrewErrorHandler;
  logbrewMiddleware: typeof logbrewMiddleware;
};

export default defaultExport;
