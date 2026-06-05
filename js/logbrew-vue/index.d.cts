import type { App, ComponentPublicInstance, InjectionKey } from "vue";
import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewVueClientConfig = {
  apiKey?: string;
  clientKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

export type VueTraceparentConfig = {
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

export type LogBrewVueContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  transport: Transport;
  previewJson(): string;
  flush(): Promise<TransportResponse>;
  shutdown(): Promise<TransportResponse>;
};

export type LogBrewVueRuntimeContext = {
  app: App;
  client: LogBrewClient;
};

export type LogBrewVueErrorContext = {
  context: LogBrewVueContext;
  info: string;
  instance: ComponentPublicInstance | null;
};

export type LogBrewClientFactory = (context: { app: App }) => LogBrewClient;
export type LogBrewTransportFactory = (context: LogBrewVueRuntimeContext) => Transport;

export type LogBrewViewEvent = {
  id: string;
  timestamp: string;
  attributes: LogAttributes;
};

export type LogBrewVueErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

export type LogBrewVueOptions = CreateLogBrewVueClientConfig & {
  client?: LogBrewClient | LogBrewClientFactory;
  transport?: Transport | LogBrewTransportFactory;
  captureErrors?: boolean;
  now?: () => string;
  errorEvent?: (error: unknown, context: LogBrewVueErrorContext) => LogBrewVueErrorEvent;
  onFlush?: (response: TransportResponse, context: LogBrewVueErrorContext) => void | Promise<void>;
  onCaptureError?: (error: unknown, context: LogBrewVueErrorContext) => void | Promise<void>;
};

export declare const LOG_BREW_VUE_KEY: InjectionKey<LogBrewVueContext>;
export declare function createLogBrewVueClient(config?: CreateLogBrewVueClientConfig): LogBrewClient;
export declare function createVueTraceparent(config?: VueTraceparentConfig): string;
export declare function createTraceparentFetch<TResponse = unknown>(
  config?: TraceparentFetchConfig<TResponse>
): TraceparentFetchLike<TResponse>;
export declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: TracePropagationTarget[]
): boolean;
export declare function createLogBrewVuePlugin(options?: LogBrewVueOptions): {
  install(app: App): void;
};
export declare function useLogBrew(): LogBrewVueContext;
export declare function createVueViewEvent(
  name: string,
  options?: {
    now?: () => string;
    path?: string;
    idFactory?: (name: string, path: string) => string;
    metadata?: Record<string, string | number | boolean | null>;
  }
): LogBrewViewEvent;
export declare function createVueErrorEvent(
  error: unknown,
  instance: ComponentPublicInstance | null,
  info: string,
  options?: {
    now?: () => string;
    idFactory?: (error: unknown, instance: ComponentPublicInstance | null, info: string) => string;
  }
): LogBrewVueErrorEvent;
export declare function captureVueError(
  error: unknown,
  instance: ComponentPublicInstance | null,
  info: string,
  context: LogBrewVueContext,
  options?: LogBrewVueOptions
): Promise<TransportResponse>;

declare module "@vue/runtime-core" {
  interface ComponentCustomProperties {
    $logbrew: LogBrewVueContext;
  }
}

declare const defaultExport: {
  captureVueError: typeof captureVueError;
  createLogBrewVueClient: typeof createLogBrewVueClient;
  createLogBrewVuePlugin: typeof createLogBrewVuePlugin;
  createTraceparentFetch: typeof createTraceparentFetch;
  createVueErrorEvent: typeof createVueErrorEvent;
  createVueTraceparent: typeof createVueTraceparent;
  createVueViewEvent: typeof createVueViewEvent;
  LOG_BREW_VUE_KEY: typeof LOG_BREW_VUE_KEY;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
  useLogBrew: typeof useLogBrew;
};

export default defaultExport;
