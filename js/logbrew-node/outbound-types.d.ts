import type { ClientRequest, IncomingMessage } from "node:http";
import type { LogBrewClient, SpanEventSummary, SpanLinkSummary } from "@logbrew/sdk";
import type {
  LogBrewInstrumentationHandle,
  LogBrewSpanCaptureErrorContext,
  LogBrewSpanCaptureErrorHandler,
  LogBrewSpanMetadata
} from "./span-types.js";
import type { LogBrewTraceContext } from "./index.js";

type LogBrewHttpClientModule = {
  request: (...args: readonly never[]) => ClientRequest;
  get: (...args: readonly never[]) => ClientRequest;
};

type LogBrewHttpClientInstrumentationModules = {
  http?: LogBrewHttpClientModule;
  https?: LogBrewHttpClientModule;
};

type LogBrewHttpClientInstrumentationContext = {
  readonly method: string;
  readonly module: string;
  readonly path: string;
  readonly protocol: string;
  readonly url: string;
};

type LogBrewHttpClientInstrumentationTarget =
  | string
  | RegExp
  | ((context: LogBrewHttpClientInstrumentationContext) => boolean);

type LogBrewHttpClientInstrumentation = LogBrewInstrumentationHandle;

type LogBrewHttpClientInstrumentationOptions = {
  client: LogBrewClient;
  modules: LogBrewHttpClientInstrumentationModules;
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
  captureTargets?: LogBrewHttpClientInstrumentationTarget | LogBrewHttpClientInstrumentationTarget[];
  routeTemplateFactory?: (context: LogBrewHttpClientInstrumentationContext) => string;
  tracePropagationTargets?: LogBrewHttpClientInstrumentationTarget | LogBrewHttpClientInstrumentationTarget[];
  onCaptureError?: LogBrewSpanCaptureErrorHandler<LogBrewSpanCaptureErrorContext & {
    readonly response?: IncomingMessage;
  }>;
};

type LogBrewUndiciInstrumentationContext = {
  readonly method: string;
  readonly path: string;
  readonly url: string;
};

type LogBrewUndiciInstrumentationTarget =
  | string
  | RegExp
  | ((context: LogBrewUndiciInstrumentationContext) => boolean);

type LogBrewUndiciInstrumentationHandle = LogBrewInstrumentationHandle;

type LogBrewUndiciInstrumentationOptions = {
  client: LogBrewClient;
  trace?: LogBrewTraceContext;
  metadata?: LogBrewSpanMetadata;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  captureTargets?: LogBrewUndiciInstrumentationTarget | LogBrewUndiciInstrumentationTarget[];
  routeTemplate?: string;
  routeTemplateFactory?: (context: LogBrewUndiciInstrumentationContext) => string;
  tracePropagationTargets?: LogBrewUndiciInstrumentationTarget | LogBrewUndiciInstrumentationTarget[];
  onCaptureError?: LogBrewSpanCaptureErrorHandler<LogBrewSpanCaptureErrorContext>;
};

declare function installLogBrewHttpClientInstrumentation(
  options: LogBrewHttpClientInstrumentationOptions
): LogBrewHttpClientInstrumentation;

declare function installLogBrewUndiciInstrumentation(
  options: LogBrewUndiciInstrumentationOptions
): LogBrewUndiciInstrumentationHandle;

export type {
  LogBrewHttpClientInstrumentation,
  LogBrewHttpClientInstrumentationContext,
  LogBrewHttpClientInstrumentationModules,
  LogBrewHttpClientInstrumentationOptions,
  LogBrewHttpClientInstrumentationTarget,
  LogBrewHttpClientModule,
  LogBrewUndiciInstrumentationContext,
  LogBrewUndiciInstrumentationHandle,
  LogBrewUndiciInstrumentationOptions,
  LogBrewUndiciInstrumentationTarget
};
export { installLogBrewHttpClientInstrumentation, installLogBrewUndiciInstrumentation };
