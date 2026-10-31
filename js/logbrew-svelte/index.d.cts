import type {
  TracePropagationTarget as BrowserTracePropagationTarget,
  BrowserTraceparentConfig,
  TraceparentFetchConfig as BrowserTraceparentFetchConfig,
  FetchTransportConfig,
  createBrowserTraceparent,
  createTraceparentFetch,
  shouldPropagateTraceparent
} from "@logbrew/browser";
import type {
  IssueAttributes,
  IssueBreadcrumb,
  JavaScriptErrorIssueOptions,
  LogAttributes,
  LogBrewClient,
  TelemetryContext,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

type CreateLogBrewSvelteClientConfig = {
  apiKey?: string | undefined;
  clientKey?: string | undefined;
  serverApiKey?: string | undefined;
  context?: TelemetryContext | undefined;
  sdkName?: string | undefined;
  sdkVersion?: string | undefined;
  maxRetries?: number | undefined;
};

type TracePropagationTarget = BrowserTracePropagationTarget;
type SvelteTraceparentConfig = BrowserTraceparentConfig;
type TraceparentFetchLike = typeof fetch;
type TraceparentFetchConfig = BrowserTraceparentFetchConfig;

type LogBrewSvelteContext = {
  client: LogBrewClient;
  logbrew: LogBrewClient;
  transport: Transport;
  previewJson: () => string;
  flush: () => Promise<TransportResponse>;
  shutdown: () => Promise<TransportResponse>;
};

type LogBrewSvelteRuntimeContext = {
  readonly client: LogBrewClient;
};

type LogBrewSvelteCaptureContext = {
  readonly context: LogBrewSvelteContext;
};

type LogBrewClientFactory = () => LogBrewClient;
type LogBrewTransportFactory = (context: LogBrewSvelteRuntimeContext) => Transport;

type LogBrewSvelteViewEvent = {
  id: string;
  timestamp: string;
  attributes: LogAttributes;
};

type LogBrewSvelteErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

type LogBrewSvelteOptions = CreateLogBrewSvelteClientConfig & FetchTransportConfig & {
  client?: LogBrewClient | LogBrewClientFactory | undefined;
  transport?: Transport | LogBrewTransportFactory | undefined;
};

type LogBrewSvelteViewEventOptions = {
  readonly now?: (() => string) | undefined;
  readonly path?: string | undefined;
  readonly idFactory?: ((name: string, path: string) => string) | undefined;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
};

/** The component and info an error event's idFactory receives. */
type LogBrewSvelteErrorIdContext = {
  readonly component: string;
  readonly info: string;
};

type LogBrewSvelteErrorOptions = JavaScriptErrorIssueOptions & {
  component?: string | undefined;
  info?: string | undefined;
  now?: (() => string) | undefined;
  idFactory?: ((error: unknown, context: LogBrewSvelteErrorIdContext) => string) | undefined;
};

type LogBrewSvelteCaptureOptions = LogBrewSvelteErrorOptions & {
  breadcrumbs?: IssueBreadcrumb[] | undefined;
  errorEvent?: ((error: unknown, context: LogBrewSvelteCaptureContext) => LogBrewSvelteErrorEvent) | undefined;
  onFlush?: ((response: Readonly<TransportResponse>, context: LogBrewSvelteCaptureContext) => void | Promise<void>) | undefined;
  onCaptureError?: ((error: unknown, context: LogBrewSvelteCaptureContext) => void | Promise<void>) | undefined;
};

/** The request headers a SvelteKit hook reads: Headers or any object with the same get. */
type SvelteKitHeaders = {
  readonly get?: ((name: string) => string | null) | undefined;
};

type SvelteKitEvent = {
  readonly request?: {
    readonly headers?: SvelteKitHeaders | undefined;
    readonly method?: string | undefined;
  } | undefined;
  readonly route?: { readonly id?: string | null | undefined } | undefined;
};

type SvelteKitHandleErrorInput<TEvent extends SvelteKitEvent = SvelteKitEvent> = {
  readonly error: unknown;
  readonly event: TEvent;
  readonly message?: string | undefined;
  readonly status?: number | undefined;
};

type LogBrewSvelteKitHooksOptions<TResult = unknown> = Omit<LogBrewSvelteCaptureOptions, "breadcrumbs" | "errorEvent"> & {
  captureRequests?: boolean | undefined;
  flushOnCapture?: boolean | undefined;
  mapError?: ((input: SvelteKitHandleErrorInput) => TResult | Promise<TResult>) | undefined;
  nowMs?: (() => number) | undefined;
  raiseCaptureErrors?: boolean | undefined;
  randomValues?: ((length: number) => ArrayLike<number>) | undefined;
  traceFlags?: string | undefined;
};

/** The input SvelteKit passes to a handle hook. */
type SvelteKitHandleInput<TEvent extends SvelteKitEvent, TResponse> = {
  readonly event: TEvent;
  readonly resolve: (event: TEvent) => TResponse | Promise<TResponse>;
};

type LogBrewSvelteKitHooks<TResult = unknown> = {
  handle: <TEvent extends SvelteKitEvent, TResponse>(
    input: SvelteKitHandleInput<TEvent, TResponse>
  ) => Promise<TResponse>;
  handleError: <TEvent extends SvelteKitEvent>(
    input: SvelteKitHandleErrorInput<TEvent>
  ) => Promise<TResult | undefined>;
};

declare const LOG_BREW_SVELTE_KEY: symbol;
declare function createLogBrewSvelteClient(config?: CreateLogBrewSvelteClientConfig): LogBrewClient;
declare const createSvelteTraceparent: typeof createBrowserTraceparent;
declare function createLogBrewSvelteContext(options?: LogBrewSvelteOptions): LogBrewSvelteContext;
declare function createLogBrewSvelteKitHooks<TResult = unknown>(
  context: LogBrewSvelteContext,
  options?: LogBrewSvelteKitHooksOptions<TResult>
): LogBrewSvelteKitHooks<TResult>;
declare function setLogBrewContext(
  options?: LogBrewSvelteOptions | LogBrewSvelteContext
): LogBrewSvelteContext;
declare function useLogBrew(): LogBrewSvelteContext;
declare const getLogBrewContext: typeof useLogBrew;
declare function createSvelteViewEvent(
  name: string,
  options?: LogBrewSvelteViewEventOptions
): LogBrewSvelteViewEvent;
declare function createSvelteErrorEvent(
  error: unknown,
  options?: LogBrewSvelteErrorOptions
): LogBrewSvelteErrorEvent;
declare function captureSvelteError(
  error: unknown,
  context: LogBrewSvelteContext,
  options?: LogBrewSvelteCaptureOptions
): Promise<TransportResponse>;

declare const defaultExport: {
  captureSvelteError: typeof captureSvelteError;
  createLogBrewSvelteClient: typeof createLogBrewSvelteClient;
  createLogBrewSvelteContext: typeof createLogBrewSvelteContext;
  createLogBrewSvelteKitHooks: typeof createLogBrewSvelteKitHooks;
  createSvelteErrorEvent: typeof createSvelteErrorEvent;
  createSvelteTraceparent: typeof createSvelteTraceparent;
  createSvelteViewEvent: typeof createSvelteViewEvent;
  createTraceparentFetch: typeof createTraceparentFetch;
  getLogBrewContext: typeof getLogBrewContext;
  LOG_BREW_SVELTE_KEY: typeof LOG_BREW_SVELTE_KEY;
  setLogBrewContext: typeof setLogBrewContext;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
  useLogBrew: typeof useLogBrew;
};

export type {
  CreateLogBrewSvelteClientConfig,
  LogBrewClientFactory,
  LogBrewSvelteCaptureContext,
  LogBrewSvelteCaptureOptions,
  LogBrewSvelteContext,
  LogBrewSvelteErrorEvent,
  LogBrewSvelteErrorIdContext,
  LogBrewSvelteErrorOptions,
  LogBrewSvelteKitHooks,
  LogBrewSvelteKitHooksOptions,
  LogBrewSvelteOptions,
  LogBrewSvelteRuntimeContext,
  LogBrewSvelteViewEvent,
  LogBrewSvelteViewEventOptions,
  LogBrewTransportFactory,
  SvelteKitEvent,
  SvelteKitHandleErrorInput,
  SvelteKitHandleInput,
  SvelteKitHeaders,
  SvelteTraceparentConfig,
  TraceparentFetchConfig,
  TraceparentFetchLike,
  TracePropagationTarget
};
export { createTraceparentFetch, shouldPropagateTraceparent } from "@logbrew/browser";
export {
  LOG_BREW_SVELTE_KEY,
  captureSvelteError,
  createLogBrewSvelteClient,
  createLogBrewSvelteContext,
  createLogBrewSvelteKitHooks,
  createSvelteErrorEvent,
  createSvelteTraceparent,
  createSvelteViewEvent,
  getLogBrewContext,
  setLogBrewContext,
  useLogBrew
};
export default defaultExport;
