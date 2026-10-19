import type {
  DroppedEvent,
  EventFilter,
  LogBrewClient,
  Metadata,
  SpanAttributes,
  TelemetryContext,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewNextBrowserClientConfig = {
  apiKey?: string;
  clientKey?: string;
  context?: TelemetryContext;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
  eventFilter?: EventFilter;
  maxQueueSize?: number;
  onEventDropped?: (drop: DroppedEvent) => void;
  /** Delivery interval after the first queued event. Defaults to 5000 ms to save battery. */
  deliveryIntervalMs?: number;
  /** Ingest endpoint for the built-in fetch transport. */
  endpoint?: string;
  /** Custom transport, or null to keep the client manual. Defaults to a fetch transport that sends automatically. */
  transport?: Transport | null;
};

export type NextClientErrorOptions = {
  /** The `digest` Next.js passes to error boundaries; also read from `error.digest`. */
  digest?: string;
  /** Stable route template such as `/projects/[projectId]`, never a concrete path. */
  routeTemplate?: string;
  /** Deliver right away. Defaults to true. */
  flush?: boolean;
};

/** Report an error from `app/error.tsx` or `app/global-error.tsx` as an unhandled issue. */
export declare function captureNextClientError(
  client: LogBrewClient,
  error: unknown,
  options?: NextClientErrorOptions
): Promise<TransportResponse | undefined>;

/** Report uncaught browser errors and unhandled rejections, and flush queued events on pagehide. */
export declare function installLogBrewNextClientErrorCapture(options: {
  client: LogBrewClient;
  browserWindow?: Window;
  /** Console, fetch, XHR, and route-change breadcrumbs on each issue. Defaults to true. */
  breadcrumbs?: boolean;
}): { uninstall(): void };

export type NextRoutePattern = string;

export type NextRouteTemplateInput = {
  pathname?: string;
  routePatterns?: NextRoutePattern[];
  routeTemplate?: string;
};

export type NextNavigationSpanIdFactoryContext = {
  navigationIndex?: number;
  navigationType?: string;
  routeTemplate?: string;
};

export type NextNavigationSpanInput = NextRouteTemplateInput & {
  durationMs?: number;
  id?: string;
  idFactory?: (context: NextNavigationSpanIdFactoryContext) => string;
  metadata?: Metadata;
  navigationIndex?: number;
  navigationType?: string;
  now?: () => string;
  parentSpanId?: string;
  spanId?: string;
  spanIdFactory?: () => string;
  status?: SpanAttributes["status"];
  timestamp?: string;
  traceId?: string;
  traceparent?: string;
};

export type CaptureNextNavigationInput = NextNavigationSpanInput;

export type NextNavigationSpanEvent = {
  id: string;
  timestamp: string;
  type: "span";
  attributes: SpanAttributes;
};

export type UseLogBrewNextNavigationOptions = CaptureNextNavigationInput & {
  client: LogBrewClient;
  onCaptureError?: (error: unknown) => void;
  onNavigation?: (event: NextNavigationSpanEvent) => void;
};

export declare function createLogBrewNextBrowserClient(
  config: CreateLogBrewNextBrowserClientConfig
): LogBrewClient;

export declare function createNextRouteTemplate(
  input?: NextRouteTemplateInput
): string | undefined;

export declare function createNextNavigationSpanEvent(
  input?: NextNavigationSpanInput
): NextNavigationSpanEvent | undefined;

export declare function captureNextNavigation(
  client: LogBrewClient,
  input?: CaptureNextNavigationInput
): NextNavigationSpanEvent | undefined;

export declare function useLogBrewNextNavigation(
  options: UseLogBrewNextNavigationOptions
): void;

declare const defaultExport: {
  captureNextClientError: typeof captureNextClientError;
  captureNextNavigation: typeof captureNextNavigation;
  installLogBrewNextClientErrorCapture: typeof installLogBrewNextClientErrorCapture;
  createLogBrewNextBrowserClient: typeof createLogBrewNextBrowserClient;
  createNextNavigationSpanEvent: typeof createNextNavigationSpanEvent;
  createNextRouteTemplate: typeof createNextRouteTemplate;
  useLogBrewNextNavigation: typeof useLogBrewNextNavigation;
};

export default defaultExport;
