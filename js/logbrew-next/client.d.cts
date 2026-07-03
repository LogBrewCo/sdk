import type {
  DroppedEvent,
  EventFilter,
  LogBrewClient,
  Metadata,
  SpanAttributes
} from "@logbrew/sdk";

export type CreateLogBrewNextBrowserClientConfig = {
  apiKey?: string;
  clientKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
  eventFilter?: EventFilter;
  maxQueueSize?: number;
  onEventDropped?: (drop: DroppedEvent) => void;
};

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
  captureNextNavigation: typeof captureNextNavigation;
  createLogBrewNextBrowserClient: typeof createLogBrewNextBrowserClient;
  createNextNavigationSpanEvent: typeof createNextNavigationSpanEvent;
  createNextRouteTemplate: typeof createNextRouteTemplate;
  useLogBrewNextNavigation: typeof useLogBrewNextNavigation;
};

export default defaultExport;
