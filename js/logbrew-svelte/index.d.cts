import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewSvelteClientConfig = {
  apiKey?: string;
  clientKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

export type SvelteTraceparentConfig = {
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

export type LogBrewSvelteContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewSvelteRuntimeContext = {
  client: LogBrewClient;
};

export type LogBrewSvelteCaptureContext = {
  context: LogBrewSvelteContext;
};

export type LogBrewClientFactory = () => LogBrewClient;
export type LogBrewTransportFactory = (context: LogBrewSvelteRuntimeContext) => Transport;

export type LogBrewSvelteViewEvent = {
  id: string;
  timestamp: string;
  attributes: LogAttributes;
};

export type LogBrewSvelteErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

export type LogBrewSvelteOptions = CreateLogBrewSvelteClientConfig & {
  client?: LogBrewClient | LogBrewClientFactory;
  transport?: Transport | LogBrewTransportFactory;
};

export type LogBrewSvelteErrorOptions = {
  component?: string;
  info?: string;
  now?: () => string;
  idFactory?: (error: unknown, context: { component: string; info: string }) => string;
};

export type LogBrewSvelteCaptureOptions = LogBrewSvelteErrorOptions & {
  errorEvent?: (error: unknown, context: LogBrewSvelteCaptureContext) => LogBrewSvelteErrorEvent;
  onFlush?: (response: TransportResponse, context: LogBrewSvelteCaptureContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewSvelteCaptureContext) => void | Promise<void>;
};

export declare const LOG_BREW_SVELTE_KEY: symbol;
export declare function createLogBrewSvelteClient(config?: CreateLogBrewSvelteClientConfig): LogBrewClient;
export declare function createSvelteTraceparent(config?: SvelteTraceparentConfig): string;
export declare function createTraceparentFetch<TResponse = unknown>(
  config?: TraceparentFetchConfig<TResponse>
): TraceparentFetchLike<TResponse>;
export declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: TracePropagationTarget[]
): boolean;
export declare function createLogBrewSvelteContext(options?: LogBrewSvelteOptions): LogBrewSvelteContext;
export declare function setLogBrewContext(
  options?: LogBrewSvelteOptions | LogBrewSvelteContext
): LogBrewSvelteContext;
export declare function useLogBrew(): LogBrewSvelteContext;
export declare const getLogBrewContext: typeof useLogBrew;
export declare function createSvelteViewEvent(
  name: string,
  options?: {
    now?: () => string;
    path?: string;
    idFactory?: (name: string, path: string) => string;
    metadata?: Record<string, string | number | boolean | null>;
  }
): LogBrewSvelteViewEvent;
export declare function createSvelteErrorEvent(
  error: unknown,
  options?: LogBrewSvelteErrorOptions
): LogBrewSvelteErrorEvent;
export declare function captureSvelteError(
  error: unknown,
  context: LogBrewSvelteContext,
  options?: LogBrewSvelteCaptureOptions
): Promise<TransportResponse>;

declare const defaultExport: {
  captureSvelteError: typeof captureSvelteError;
  createLogBrewSvelteClient: typeof createLogBrewSvelteClient;
  createLogBrewSvelteContext: typeof createLogBrewSvelteContext;
  createSvelteTraceparent: typeof createSvelteTraceparent;
  createSvelteErrorEvent: typeof createSvelteErrorEvent;
  createSvelteViewEvent: typeof createSvelteViewEvent;
  createTraceparentFetch: typeof createTraceparentFetch;
  getLogBrewContext: typeof getLogBrewContext;
  LOG_BREW_SVELTE_KEY: typeof LOG_BREW_SVELTE_KEY;
  setLogBrewContext: typeof setLogBrewContext;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
  useLogBrew: typeof useLogBrew;
};

export default defaultExport;
