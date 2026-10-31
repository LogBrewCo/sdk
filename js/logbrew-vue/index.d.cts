import type { App, ComponentPublicInstance, InjectionKey } from "vue";
import type {
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  TelemetryContext,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

type CreateLogBrewVueClientConfig = {
  apiKey?: string | undefined;
  clientKey?: string | undefined;
  context?: TelemetryContext | undefined;
  sdkName?: string | undefined;
  sdkVersion?: string | undefined;
  maxRetries?: number | undefined;
};

type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

type VueTraceparentConfig = {
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

type LogBrewVueContext = {
  readonly client: LogBrewClient;
  readonly logbrew: LogBrewClient;
  readonly transport: Transport;
  readonly previewJson: () => string;
  readonly flush: () => Promise<TransportResponse>;
  readonly shutdown: () => Promise<TransportResponse>;
};

type LogBrewVueRuntimeContext = {
  readonly app: App;
  readonly client: LogBrewClient;
};

type LogBrewVueErrorContext = {
  readonly context: LogBrewVueContext;
  readonly info: string;
  readonly instance: ComponentPublicInstance | null;
};

type LogBrewClientFactory = (context: { readonly app: App }) => LogBrewClient;
type LogBrewTransportFactory = (context: LogBrewVueRuntimeContext) => Transport;

type LogBrewViewEvent = {
  id: string;
  timestamp: string;
  attributes: LogAttributes;
};

type LogBrewVueErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

type LogBrewVueViewEventOptions = {
  now?: (() => string) | undefined;
  path?: string | undefined;
  idFactory?: ((name: string, path: string) => string) | undefined;
  metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
};

type LogBrewVueErrorEventOptions = {
  now?: (() => string) | undefined;
  idFactory?: ((error: unknown, instance: ComponentPublicInstance | null, info: string) => string) | undefined;
};

type LogBrewVueOptions = CreateLogBrewVueClientConfig & LogBrewVueErrorEventOptions & {
  client?: LogBrewClient | LogBrewClientFactory | undefined;
  transport?: Transport | LogBrewTransportFactory | undefined;
  captureErrors?: boolean | undefined;
  errorEvent?: ((error: unknown, context: LogBrewVueErrorContext) => LogBrewVueErrorEvent) | undefined;
  onFlush?: ((response: Readonly<TransportResponse>, context: LogBrewVueErrorContext) => void | Promise<void>) | undefined;
  onCaptureError?: ((error: unknown, context: LogBrewVueErrorContext) => void | Promise<void>) | undefined;
};

type LogBrewVuePlugin = {
  readonly install: (app: App) => void;
};

declare const LOG_BREW_VUE_KEY: InjectionKey<LogBrewVueContext>;
declare function createLogBrewVueClient(config?: CreateLogBrewVueClientConfig): LogBrewClient;
declare function createVueTraceparent(config?: VueTraceparentConfig): string;
declare function createTraceparentFetch<TResponse = unknown>(
  config?: TraceparentFetchConfig<TResponse>
): TraceparentFetchLike<TResponse>;
declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: readonly TracePropagationTarget[]
): boolean;
declare function createLogBrewVuePlugin(options?: LogBrewVueOptions): LogBrewVuePlugin;
declare function useLogBrew(): LogBrewVueContext;
declare function createVueViewEvent(name: string, options?: LogBrewVueViewEventOptions): LogBrewViewEvent;
declare function createVueErrorEvent(
  error: unknown,
  instance: ComponentPublicInstance | null,
  info: string,
  options?: LogBrewVueErrorEventOptions
): LogBrewVueErrorEvent;
declare function captureVueError(
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

export type {
  CreateLogBrewVueClientConfig,
  LogBrewClientFactory,
  LogBrewTransportFactory,
  LogBrewViewEvent,
  LogBrewVueContext,
  LogBrewVueErrorContext,
  LogBrewVueErrorEvent,
  LogBrewVueErrorEventOptions,
  LogBrewVueOptions,
  LogBrewVuePlugin,
  LogBrewVueRuntimeContext,
  LogBrewVueViewEventOptions,
  TraceparentFetchConfig,
  TraceparentFetchLike,
  TraceparentRequestContext,
  TracePropagationTarget,
  VueTraceparentConfig
};
export {
  LOG_BREW_VUE_KEY,
  captureVueError,
  createLogBrewVueClient,
  createLogBrewVuePlugin,
  createTraceparentFetch,
  createVueErrorEvent,
  createVueTraceparent,
  createVueViewEvent,
  shouldPropagateTraceparent,
  useLogBrew
};
export default defaultExport;
