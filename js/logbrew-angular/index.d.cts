import type { ErrorHandler, InjectionToken, Injector, Provider } from "@angular/core";
import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewAngularClientConfig = {
  apiKey?: string;
  clientKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

export type AngularTraceparentConfig = {
  traceId?: string;
  spanId?: string;
  traceFlags?: string;
  randomValues?: (length: number) => ArrayLike<number>;
};

export type TraceparentFetchLike<TResponse = unknown> = (
  input: any,
  init?: any
) => Promise<TResponse> | TResponse;

export type TraceparentFetchConfig<TResponse = unknown> = {
  fetchImpl?: TraceparentFetchLike<TResponse>;
  randomValues?: (length: number) => ArrayLike<number>;
  traceFlags?: string;
  traceparent?: string;
  traceparentFactory?: (context: {
    input: any;
    init?: any;
    url: string;
  }) => string | undefined;
  tracePropagationTargets?: TracePropagationTarget[];
};

export type LogBrewAngularContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewAngularRuntimeContext = {
  injector: Injector;
  client: LogBrewClient;
};

export type LogBrewAngularCaptureContext = {
  context: LogBrewAngularContext;
};

export type LogBrewAngularErrorMetadata = {
  component?: string;
  info?: string;
  path?: string;
  route?: string;
};

export type LogBrewClientFactory = (context: { injector: Injector }) => LogBrewClient;
export type LogBrewTransportFactory = (context: LogBrewAngularRuntimeContext) => Transport;
export type LogBrewErrorDelegate = ErrorHandler | ((error: unknown) => void);

export type LogBrewAngularViewEvent = {
  id: string;
  timestamp: string;
  attributes: LogAttributes;
};

export type LogBrewAngularErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

export type LogBrewAngularOptions = CreateLogBrewAngularClientConfig & LogBrewAngularErrorMetadata & {
  client?: LogBrewClient | LogBrewClientFactory;
  transport?: Transport | LogBrewTransportFactory;
  captureErrors?: boolean;
  delegateErrorHandler?: LogBrewErrorDelegate;
  now?: () => string;
  errorEvent?: (error: unknown, context: LogBrewAngularCaptureContext) => LogBrewAngularErrorEvent;
  onFlush?: (response: TransportResponse, context: LogBrewAngularCaptureContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewAngularCaptureContext) => void | Promise<void>;
};

export declare const LOG_BREW_ANGULAR_CONTEXT: InjectionToken<LogBrewAngularContext>;
export declare function createLogBrewAngularClient(config?: CreateLogBrewAngularClientConfig): LogBrewClient;
export declare function createAngularTraceparent(config?: AngularTraceparentConfig): string;
export declare function createTraceparentFetch<TResponse = unknown>(
  config?: TraceparentFetchConfig<TResponse>
): TraceparentFetchLike<TResponse>;
export declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: TracePropagationTarget[]
): boolean;
export declare function createLogBrewAngularContext(
  client: LogBrewClient,
  transport: Transport
): LogBrewAngularContext;
export declare function provideLogBrew(options?: LogBrewAngularOptions): Provider[];
export declare function injectLogBrew(): LogBrewAngularContext;
export declare class LogBrewErrorHandler implements ErrorHandler {
  constructor(context: LogBrewAngularContext, options?: LogBrewAngularOptions, delegate?: ErrorHandler | null);
  handleError(error: unknown): void;
}
export declare function createAngularViewEvent(
  name: string,
  options?: {
    now?: () => string;
    path?: string;
    route?: string;
    idFactory?: (name: string, path: string) => string;
    metadata?: Record<string, string | number | boolean | null>;
  }
): LogBrewAngularViewEvent;
export declare function createAngularErrorEvent(
  error: unknown,
  context?: LogBrewAngularErrorMetadata,
  options?: {
    now?: () => string;
    idFactory?: (error: unknown, context: LogBrewAngularErrorMetadata) => string;
  }
): LogBrewAngularErrorEvent;
export declare function captureAngularError(
  error: unknown,
  context: LogBrewAngularContext,
  options?: LogBrewAngularOptions
): Promise<TransportResponse>;

declare const defaultExport: {
  captureAngularError: typeof captureAngularError;
  createAngularErrorEvent: typeof createAngularErrorEvent;
  createAngularTraceparent: typeof createAngularTraceparent;
  createAngularViewEvent: typeof createAngularViewEvent;
  createLogBrewAngularClient: typeof createLogBrewAngularClient;
  createLogBrewAngularContext: typeof createLogBrewAngularContext;
  createTraceparentFetch: typeof createTraceparentFetch;
  injectLogBrew: typeof injectLogBrew;
  LogBrewErrorHandler: typeof LogBrewErrorHandler;
  LOG_BREW_ANGULAR_CONTEXT: typeof LOG_BREW_ANGULAR_CONTEXT;
  provideLogBrew: typeof provideLogBrew;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
};

export default defaultExport;
