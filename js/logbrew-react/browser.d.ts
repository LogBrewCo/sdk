import type {
  BrowserInteractionTimingOptions,
  BrowserInteractionTimingInstrumentation,
  BrowserTraceContextInput,
  BrowserWebVitalsInstrumentation,
  BrowserWebVitalsOptions,
  LogBrewBrowserContext
} from "@logbrew/browser";
import type {
  LogBrewClient,
  Metadata,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type LogBrewReactBrowserInstrumentationName = "interactionTiming" | "webVitals";

export type LogBrewReactBrowserInstrumentationOptions = {
  browserWindow?: Window;
  enabled?: boolean;
  flushOnCapture?: boolean;
  includeDocumentTitle?: boolean;
  includeHash?: boolean;
  includeQueryString?: boolean;
  includeUserAgent?: boolean;
  interactionTiming?: boolean | BrowserInteractionTimingOptions;
  metadata?: Metadata;
  now?: () => string;
  onCaptureError?: (
    error: unknown,
    details?: { name?: LogBrewReactBrowserInstrumentationName | "capture" }
  ) => void | Promise<void>;
  onFlush?: (
    response: TransportResponse,
    context: LogBrewBrowserContext,
    details: { reason: "capture" }
  ) => void | Promise<void>;
  onInstrumentation?: (
    name: LogBrewReactBrowserInstrumentationName,
    instrumentation: BrowserInteractionTimingInstrumentation | BrowserWebVitalsInstrumentation
  ) => void;
  randomValues?: (length: number) => ArrayLike<number>;
  raiseCaptureErrors?: boolean;
  sampled?: boolean;
  sanitizeMetadata?: (metadata: Metadata, kind: string) => Metadata;
  traceContext?: BrowserTraceContextInput | (() => BrowserTraceContextInput);
  traceFlags?: string;
  transport?: Transport;
  webVitals?: boolean | BrowserWebVitalsOptions;
};

export declare function createLogBrewReactBrowserContext(
  client: LogBrewClient,
  options?: LogBrewReactBrowserInstrumentationOptions
): LogBrewBrowserContext;

export declare function useLogBrewBrowserInstrumentation(
  options?: LogBrewReactBrowserInstrumentationOptions
): void;

declare const defaultExport: {
  createLogBrewReactBrowserContext: typeof createLogBrewReactBrowserContext;
  useLogBrewBrowserInstrumentation: typeof useLogBrewBrowserInstrumentation;
};

export default defaultExport;
