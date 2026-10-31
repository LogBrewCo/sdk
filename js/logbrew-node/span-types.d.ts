import type { LogBrewClient, SpanEventSummary, SpanLinkSummary } from "@logbrew/sdk";
import type { LogBrewTraceContext } from "./index.js";

type LogBrewSpanMetadata = Record<string, string | number | boolean | null>;

type LogBrewSpanCaptureErrorHandler<Context> = (
  error: unknown,
  context: Context
) => void | Promise<void>;

type LogBrewSpanCaptureErrorContext = {
  readonly client: LogBrewClient;
  readonly error?: unknown;
  readonly trace: LogBrewTraceContext;
};

type LogBrewFetchTimings = {
  connectMs?: number;
  decodedBodySize?: number;
  encodedBodySize?: number;
  nameLookupMs?: number;
  redirectMs?: number;
  requestBodyBytes?: number;
  requestMs?: number;
  responseBodyBytes?: number;
  responseMs?: number;
  tlsMs?: number;
  waitMs?: number;
};

type LogBrewFetchTimingContext = {
  readonly durationMs: number;
  readonly error?: unknown;
  readonly method: string;
  readonly path: string;
  readonly response?: Response;
  readonly trace: LogBrewTraceContext;
};

type LogBrewFetchTimingSource =
  | LogBrewFetchTimings
  | ((context: LogBrewFetchTimingContext) => LogBrewFetchTimings | null | undefined);

type FetchWithLogBrewSpanOptions = {
  client: LogBrewClient;
  fetchImpl?: typeof fetch;
  trace?: LogBrewTraceContext;
  id?: string;
  routeTemplate?: string;
  events?: SpanEventSummary[];
  links?: SpanLinkSummary[];
  metadata?: LogBrewSpanMetadata;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  timings?: LogBrewFetchTimingSource;
  traceIdFactory?: () => string;
  onCaptureError?: LogBrewSpanCaptureErrorHandler<LogBrewSpanCaptureErrorContext & {
    readonly response?: Response;
  }>;
};

type LogBrewFetchInstrumentationContext = {
  readonly input: string | URL | Request;
  readonly init?: RequestInit;
  readonly method: string;
  readonly path: string;
  readonly url: string;
};

type LogBrewFetchInstrumentationTarget =
  | string
  | RegExp
  | ((context: LogBrewFetchInstrumentationContext) => boolean);

type LogBrewInstrumentationHandle = {
  isInstalled: () => boolean;
  uninstall: () => void;
};

type LogBrewFetchInstrumentationHandle = LogBrewInstrumentationHandle;

type LogBrewAxiosRequestConfig = {
  baseURL?: string;
  data?: unknown;
  headers?: unknown;
  method?: string;
  url?: string;
  [key: string]: unknown;
};

type LogBrewAxiosInstanceLike = {
  request: (config: never) => unknown;
  delete?: (url: string, config?: never) => unknown;
  get?: (url: string, config?: never) => unknown;
  head?: (url: string, config?: never) => unknown;
  options?: (url: string, config?: never) => unknown;
  patch?: (url: string, data?: unknown, config?: never) => unknown;
  post?: (url: string, data?: unknown, config?: never) => unknown;
  put?: (url: string, data?: unknown, config?: never) => unknown;
};

type LogBrewAxiosInstrumentableInstance = LogBrewAxiosInstanceLike & {
  interceptors: {
    request: {
      use: (onFulfilled: (config: unknown) => never) => number;
      eject: (id: number) => void;
    };
    response: {
      use: (
        onFulfilled: (response: unknown) => never,
        onRejected: (error: unknown) => unknown
      ) => number;
      eject: (id: number) => void;
    };
  };
};

type LogBrewAxiosInstrumentationContext = {
  readonly config: Readonly<LogBrewAxiosRequestConfig>;
  readonly method: string;
  readonly path: string;
  readonly routeTemplate?: string;
  readonly url: string;
};

type LogBrewAxiosInstrumentationTarget =
  | string
  | RegExp
  | ((context: LogBrewAxiosInstrumentationContext) => boolean);

type LogBrewAxiosInstrumentation = LogBrewInstrumentationHandle;

type LogBrewAxiosSpanOptions = {
  client: LogBrewClient;
  trace?: LogBrewTraceContext;
  id?: string;
  routeTemplate?: string;
  events?: SpanEventSummary[];
  links?: SpanLinkSummary[];
  metadata?: LogBrewSpanMetadata;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: LogBrewSpanCaptureErrorHandler<LogBrewSpanCaptureErrorContext & {
    readonly response?: unknown;
  }>;
};

type LogBrewAxiosInstrumentationOptions = LogBrewAxiosSpanOptions & {
  captureTargets?: LogBrewAxiosInstrumentationTarget | LogBrewAxiosInstrumentationTarget[];
  routeTemplateFactory?: (context: LogBrewAxiosInstrumentationContext) => string;
  tracePropagationTargets?: LogBrewAxiosInstrumentationTarget | LogBrewAxiosInstrumentationTarget[];
};

type LogBrewFetchInstrumentationOptions = Omit<
  FetchWithLogBrewSpanOptions,
  "fetchImpl" | "routeTemplate"
> & {
  globalObject?: {
    fetch?: typeof fetch;
  };
  captureTargets?: LogBrewFetchInstrumentationTarget | LogBrewFetchInstrumentationTarget[];
  routeTemplate?: string;
  routeTemplateFactory?: (context: LogBrewFetchInstrumentationContext) => string;
  tracePropagationTargets?: LogBrewFetchInstrumentationTarget | LogBrewFetchInstrumentationTarget[];
};

declare function fetchWithLogBrewSpan(
  input: string | URL | Request,
  init: RequestInit | undefined,
  options: FetchWithLogBrewSpanOptions
): Promise<Response>;

declare function axiosRequestWithLogBrewSpan<Instance extends LogBrewAxiosInstanceLike>(
  axiosInstance: Instance,
  config: Parameters<Instance["request"]>["0"],
  options: LogBrewAxiosSpanOptions
): Promise<Awaited<ReturnType<Instance["request"]>>>;

declare function instrumentLogBrewAxiosInstance(
  axiosInstance: LogBrewAxiosInstrumentableInstance,
  options: LogBrewAxiosInstrumentationOptions
): LogBrewAxiosInstrumentation;

declare function installLogBrewFetchInstrumentation(
  options: LogBrewFetchInstrumentationOptions
): LogBrewFetchInstrumentationHandle;

export type {
  FetchWithLogBrewSpanOptions,
  LogBrewAxiosInstanceLike,
  LogBrewAxiosInstrumentableInstance,
  LogBrewAxiosInstrumentation,
  LogBrewAxiosInstrumentationContext,
  LogBrewAxiosInstrumentationOptions,
  LogBrewAxiosInstrumentationTarget,
  LogBrewAxiosRequestConfig,
  LogBrewAxiosSpanOptions,
  LogBrewFetchInstrumentationContext,
  LogBrewFetchInstrumentationHandle,
  LogBrewFetchInstrumentationOptions,
  LogBrewFetchInstrumentationTarget,
  LogBrewFetchTimingContext,
  LogBrewFetchTimingSource,
  LogBrewFetchTimings,
  LogBrewInstrumentationHandle,
  LogBrewSpanCaptureErrorContext,
  LogBrewSpanCaptureErrorHandler,
  LogBrewSpanMetadata,
};
export {
  axiosRequestWithLogBrewSpan,
  fetchWithLogBrewSpan,
  installLogBrewFetchInstrumentation,
  instrumentLogBrewAxiosInstance
};
