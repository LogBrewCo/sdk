import type { ErrorHandler, FactoryProvider, InjectionToken, Injector } from "@angular/core";
import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  TelemetryContext,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

type CreateLogBrewAngularClientConfig = {
  apiKey?: string | undefined;
  clientKey?: string | undefined;
  context?: TelemetryContext | undefined;
  sdkName?: string | undefined;
  sdkVersion?: string | undefined;
  maxRetries?: number | undefined;
};

type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

type AngularTraceparentConfig = {
  traceId?: string | undefined;
  spanId?: string | undefined;
  traceFlags?: string | undefined;
  randomValues?: ((length: number) => ArrayLike<number>) | undefined;
};

/** A fetch function: the global fetch or one with the same parameters. */
type TraceparentFetchLike<TResponse = unknown> = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<TResponse> | TResponse;

/** The request a traceparentFactory creates a traceparent for. */
type TraceparentRequestContext = {
  readonly input: RequestInfo | URL;
  readonly init?: RequestInit | undefined;
  readonly url: string;
};

type TraceparentFetchConfig<TResponse = unknown> = {
  fetchImpl?: TraceparentFetchLike<TResponse> | undefined;
  randomValues?: ((length: number) => ArrayLike<number>) | undefined;
  traceFlags?: string | undefined;
  traceparent?: string | undefined;
  traceparentFactory?: ((context: TraceparentRequestContext) => string | undefined) | undefined;
  tracePropagationTargets?: readonly TracePropagationTarget[] | undefined;
};

type LogBrewAngularContext = {
  readonly client: LogBrewClient;
  readonly logbrew: LogBrewClient;
  readonly transport: Transport;
  readonly previewJson: () => string;
  readonly flush: () => Promise<TransportResponse>;
  readonly shutdown: () => Promise<TransportResponse>;
};

type LogBrewAngularRuntimeContext = {
  readonly injector: Injector;
  readonly client: LogBrewClient;
};

type LogBrewAngularCaptureContext = {
  readonly context: LogBrewAngularContext;
};

type LogBrewAngularErrorMetadata = {
  component?: string | undefined;
  info?: string | undefined;
  path?: string | undefined;
  route?: string | undefined;
};

type LogBrewClientFactory = (context: { readonly injector: Injector }) => LogBrewClient;
type LogBrewTransportFactory = (context: LogBrewAngularRuntimeContext) => Transport;
type LogBrewErrorDelegate = ErrorHandler | ((error: unknown) => void);

type LogBrewAngularViewEvent = {
  id: string;
  timestamp: string;
  attributes: LogAttributes;
};

type LogBrewAngularErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

type LogBrewAngularViewEventOptions = {
  now?: (() => string) | undefined;
  path?: string | undefined;
  route?: string | undefined;
  idFactory?: ((name: string, path: string) => string) | undefined;
  metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
};

type LogBrewAngularErrorEventOptions = {
  now?: (() => string) | undefined;
  idFactory?: ((error: unknown, context: LogBrewAngularErrorMetadata) => string) | undefined;
};

type LogBrewAngularOptions = CreateLogBrewAngularClientConfig & LogBrewAngularErrorMetadata & LogBrewAngularErrorEventOptions & {
  client?: LogBrewClient | LogBrewClientFactory | undefined;
  transport?: Transport | LogBrewTransportFactory | undefined;
  captureErrors?: boolean | undefined;
  delegateErrorHandler?: LogBrewErrorDelegate | undefined;
  errorEvent?: ((error: unknown, context: LogBrewAngularCaptureContext) => LogBrewAngularErrorEvent) | undefined;
  onFlush?: ((response: Readonly<TransportResponse>, context: LogBrewAngularCaptureContext) => void | Promise<void>) | undefined;
  onCaptureError?: ((error: unknown, context: LogBrewAngularCaptureContext) => void | Promise<void>) | undefined;
};

declare const LOG_BREW_ANGULAR_CONTEXT: InjectionToken<LogBrewAngularContext>;
declare function createLogBrewAngularClient(config?: CreateLogBrewAngularClientConfig): LogBrewClient;
declare function createAngularTraceparent(config?: AngularTraceparentConfig): string;
declare function createTraceparentFetch<TResponse = unknown>(
  config?: TraceparentFetchConfig<TResponse>
): TraceparentFetchLike<TResponse>;
declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: readonly TracePropagationTarget[]
): boolean;
declare function createLogBrewAngularContext(
  client: LogBrewClient,
  transport: Transport
): LogBrewAngularContext;
declare function provideLogBrew(options?: LogBrewAngularOptions): FactoryProvider[];
declare function injectLogBrew(): LogBrewAngularContext;
declare class LogBrewErrorHandler implements ErrorHandler {
  public constructor(context: LogBrewAngularContext, options?: LogBrewAngularOptions, delegate?: ErrorHandler | null);
  public handleError(error: unknown): void;
}
declare function createAngularViewEvent(
  name: string,
  options?: LogBrewAngularViewEventOptions
): LogBrewAngularViewEvent;
declare function createAngularErrorEvent(
  error: unknown,
  context?: LogBrewAngularErrorMetadata,
  options?: LogBrewAngularErrorEventOptions
): LogBrewAngularErrorEvent;
declare function captureAngularError(
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

export type {
  AngularTraceparentConfig,
  CreateLogBrewAngularClientConfig,
  LogBrewAngularCaptureContext,
  LogBrewAngularContext,
  LogBrewAngularErrorEvent,
  LogBrewAngularErrorEventOptions,
  LogBrewAngularErrorMetadata,
  LogBrewAngularOptions,
  LogBrewAngularRuntimeContext,
  LogBrewAngularViewEvent,
  LogBrewAngularViewEventOptions,
  LogBrewClientFactory,
  LogBrewErrorDelegate,
  LogBrewTransportFactory,
  TraceparentFetchConfig,
  TraceparentFetchLike,
  TraceparentRequestContext,
  TracePropagationTarget
};
export {
  LOG_BREW_ANGULAR_CONTEXT,
  LogBrewErrorHandler,
  captureAngularError,
  createAngularErrorEvent,
  createAngularTraceparent,
  createAngularViewEvent,
  createLogBrewAngularClient,
  createLogBrewAngularContext,
  createTraceparentFetch,
  injectLogBrew,
  provideLogBrew,
  shouldPropagateTraceparent
};
export default defaultExport;
