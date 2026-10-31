import type { ActionAttributes, IssueAttributes, LogBrewClient, SpanAttributes, Transport, TransportResponse } from "@logbrew/sdk";
import type {
  BeaconTransport,
  BeaconTransportConfig,
  BrowserTraceContext,
  BrowserTraceContextConfig,
  BrowserTraceContextInput,
  BrowserTraceparentConfig,
  CreateLogBrewBrowserClientConfig,
  FetchTransportConfig,
  PersistentBrowserTransport,
  PersistentBrowserTransportConfig,
  TracePropagationTarget,
  TraceparentFetchConfig
} from "./types-transport.js";
import type {
  BrowserActionInput,
  BrowserFetchInput,
  BrowserInteractionTimingInput,
  BrowserIssueSuppressedResult,
  BrowserNavigationTimingInput,
  BrowserNetworkInput,
  BrowserResourceTimingInput,
  BrowserWebVitalInput,
  BrowserXhrInput,
  LogBrewBrowserEvent
} from "./types-signals.js";
import type {
  BrowserFetchInstrumentation,
  BrowserFetchOptions,
  BrowserInteractionTimingInstrumentation,
  BrowserInteractionTimingOptions,
  BrowserInteractionToNextPaintOptions,
  BrowserNavigationInstrumentation,
  BrowserNavigationInstrumentationOptions,
  BrowserNavigationTimingInstrumentation,
  BrowserNavigationTimingOptions,
  BrowserResourceTimingInstrumentation,
  BrowserResourceTimingOptions,
  BrowserWebVitalsInstrumentation,
  BrowserWebVitalsOptions,
  BrowserXhrInstrumentation,
  BrowserXhrOptions
} from "./types-instrumentation.js";
import type {
  LogBrewBrowserContext,
  LogBrewBrowserOptions
} from "./types-options.js";

declare function createLogBrewBrowserClient(config?: CreateLogBrewBrowserClientConfig): LogBrewClient;

declare function createFetchTransport(config?: FetchTransportConfig): Transport;

declare function createBeaconTransport(config: BeaconTransportConfig): BeaconTransport;

declare function createPersistentBrowserTransport(config: PersistentBrowserTransportConfig): PersistentBrowserTransport;

declare function createBrowserTraceparent(config?: BrowserTraceparentConfig): string;

declare function createBrowserTraceContext(config?: BrowserTraceContextConfig): BrowserTraceContext;

declare function createTraceparentFetch(config?: TraceparentFetchConfig): typeof fetch;

declare function createLogBrewBrowserFetch(context: LogBrewBrowserContext, options?: BrowserFetchOptions): typeof fetch;

declare function shouldPropagateTraceparent(url: string, tracePropagationTargets?: TracePropagationTarget[]): boolean;

declare function installLogBrewBrowser(options?: LogBrewBrowserOptions): LogBrewBrowserContext;

declare function installLogBrewBrowserNavigationInstrumentation(context: LogBrewBrowserContext, options?: BrowserNavigationInstrumentationOptions): BrowserNavigationInstrumentation;

declare function installLogBrewBrowserResourceTimingInstrumentation(context: LogBrewBrowserContext, options?: BrowserResourceTimingOptions): BrowserResourceTimingInstrumentation;

declare function installLogBrewBrowserNavigationTimingInstrumentation(context: LogBrewBrowserContext, options?: BrowserNavigationTimingOptions): BrowserNavigationTimingInstrumentation;

declare function installLogBrewBrowserWebVitalsInstrumentation(context: LogBrewBrowserContext, options?: BrowserWebVitalsOptions): BrowserWebVitalsInstrumentation;

declare function installLogBrewBrowserFetchInstrumentation(context: LogBrewBrowserContext, options?: BrowserFetchOptions): BrowserFetchInstrumentation;

declare function installLogBrewBrowserInteractionTimingInstrumentation(context: LogBrewBrowserContext, options?: BrowserInteractionTimingOptions): BrowserInteractionTimingInstrumentation;

declare function installLogBrewBrowserXhrInstrumentation(context: LogBrewBrowserContext, options?: BrowserXhrOptions): BrowserXhrInstrumentation;

declare function createLogBrewBrowserContext(client: LogBrewClient, transport: Transport, browserWindow?: Window, uninstall?: () => void, traceContext?: BrowserTraceContextInput): LogBrewBrowserContext;

declare function capturePageView(context: LogBrewBrowserContext, options?: LogBrewBrowserOptions): Promise<TransportResponse | undefined>;

declare function captureBrowserError(error: unknown, context: LogBrewBrowserContext, options?: LogBrewBrowserOptions): Promise<TransportResponse | BrowserIssueSuppressedResult | undefined>;

declare function captureUnhandledRejection(rejection: unknown, context: LogBrewBrowserContext, options?: LogBrewBrowserOptions): Promise<TransportResponse | BrowserIssueSuppressedResult | undefined>;

declare function captureBrowserAction(action: BrowserActionInput, context: LogBrewBrowserContext, options?: LogBrewBrowserOptions): Promise<TransportResponse | undefined>;

declare function captureBrowserNetwork(request: BrowserNetworkInput, context: LogBrewBrowserContext, options?: LogBrewBrowserOptions): Promise<TransportResponse | undefined>;

declare function captureBrowserResourceTiming(entry: BrowserResourceTimingInput, context: LogBrewBrowserContext, options?: BrowserResourceTimingOptions): Promise<TransportResponse | undefined>;

declare function captureBrowserNavigationTiming(entry: BrowserNavigationTimingInput, context: LogBrewBrowserContext, options?: BrowserNavigationTimingOptions): Promise<TransportResponse | undefined>;

declare function captureBrowserWebVital(metric: BrowserWebVitalInput, context: LogBrewBrowserContext, options?: BrowserWebVitalsOptions): Promise<TransportResponse | undefined>;

declare function captureBrowserInteractionTiming(entry: BrowserInteractionTimingInput, context: LogBrewBrowserContext, options?: BrowserInteractionTimingOptions): Promise<TransportResponse | undefined>;

declare function captureBrowserInteractionToNextPaint(entries: BrowserInteractionTimingInput[], context: LogBrewBrowserContext, options?: BrowserInteractionToNextPaintOptions): Promise<TransportResponse | undefined>;

declare function captureBrowserFetchSpan(request: BrowserFetchInput, context: LogBrewBrowserContext, options?: BrowserFetchOptions): Promise<TransportResponse | undefined>;

declare function captureBrowserXhrSpan(request: BrowserXhrInput, context: LogBrewBrowserContext, options?: BrowserXhrOptions): Promise<TransportResponse | undefined>;

declare function createPageViewEvent(browserWindow?: Window, options?: LogBrewBrowserOptions): LogBrewBrowserEvent<SpanAttributes>;

declare function createBrowserActionEvent(action: BrowserActionInput, browserWindow?: Window, options?: LogBrewBrowserOptions): LogBrewBrowserEvent<ActionAttributes>;

declare function createBrowserNetworkEvent(request: BrowserNetworkInput, browserWindow?: Window, options?: LogBrewBrowserOptions): LogBrewBrowserEvent<ActionAttributes>;

declare function createBrowserResourceTimingEvent(entry: BrowserResourceTimingInput, browserWindow?: Window, options?: BrowserResourceTimingOptions): LogBrewBrowserEvent<SpanAttributes>;

declare function createBrowserNavigationTimingEvent(entry: BrowserNavigationTimingInput, browserWindow?: Window, options?: BrowserNavigationTimingOptions): LogBrewBrowserEvent<SpanAttributes>;

declare function createBrowserWebVitalEvent(metric: BrowserWebVitalInput, browserWindow?: Window, options?: BrowserWebVitalsOptions): LogBrewBrowserEvent<SpanAttributes>;

declare function createBrowserInteractionTimingEvent(entry: BrowserInteractionTimingInput, browserWindow?: Window, options?: BrowserInteractionTimingOptions): LogBrewBrowserEvent<SpanAttributes>;

declare function createBrowserInteractionToNextPaintEvent(entries: BrowserInteractionTimingInput[], browserWindow?: Window, options?: BrowserInteractionToNextPaintOptions): LogBrewBrowserEvent<SpanAttributes>;

declare function createBrowserFetchSpanEvent(request: BrowserFetchInput, browserWindow?: Window, options?: BrowserFetchOptions): LogBrewBrowserEvent<SpanAttributes>;

declare function createBrowserXhrSpanEvent(request: BrowserXhrInput, browserWindow?: Window, options?: BrowserXhrOptions): LogBrewBrowserEvent<SpanAttributes>;

declare function createBrowserErrorEvent(error: unknown, browserWindow?: Window, options?: LogBrewBrowserOptions): LogBrewBrowserEvent<IssueAttributes>;

declare function createUnhandledRejectionEvent(rejection: unknown, browserWindow?: Window, options?: LogBrewBrowserOptions): LogBrewBrowserEvent<IssueAttributes>;

declare const defaultExport: {
  captureBrowserAction: typeof captureBrowserAction;
  captureBrowserError: typeof captureBrowserError;
  captureBrowserFetchSpan: typeof captureBrowserFetchSpan;
  captureBrowserInteractionTiming: typeof captureBrowserInteractionTiming;
  captureBrowserInteractionToNextPaint: typeof captureBrowserInteractionToNextPaint;
  captureBrowserNetwork: typeof captureBrowserNetwork;
  captureBrowserNavigationTiming: typeof captureBrowserNavigationTiming;
  captureBrowserResourceTiming: typeof captureBrowserResourceTiming;
  captureBrowserWebVital: typeof captureBrowserWebVital;
  captureBrowserXhrSpan: typeof captureBrowserXhrSpan;
  capturePageView: typeof capturePageView;
  captureUnhandledRejection: typeof captureUnhandledRejection;
  createBrowserTraceContext: typeof createBrowserTraceContext;
  createBrowserTraceparent: typeof createBrowserTraceparent;
  createBrowserActionEvent: typeof createBrowserActionEvent;
  createBrowserErrorEvent: typeof createBrowserErrorEvent;
  createBrowserFetchSpanEvent: typeof createBrowserFetchSpanEvent;
  createBrowserInteractionTimingEvent: typeof createBrowserInteractionTimingEvent;
  createBrowserInteractionToNextPaintEvent: typeof createBrowserInteractionToNextPaintEvent;
  createBrowserNavigationTimingEvent: typeof createBrowserNavigationTimingEvent;
  createBrowserResourceTimingEvent: typeof createBrowserResourceTimingEvent;
  createBrowserWebVitalEvent: typeof createBrowserWebVitalEvent;
  createBrowserXhrSpanEvent: typeof createBrowserXhrSpanEvent;
  createFetchTransport: typeof createFetchTransport;
  createLogBrewBrowserFetch: typeof createLogBrewBrowserFetch;
  createLogBrewBrowserClient: typeof createLogBrewBrowserClient;
  createLogBrewBrowserContext: typeof createLogBrewBrowserContext;
  createBrowserNetworkEvent: typeof createBrowserNetworkEvent;
  createPageViewEvent: typeof createPageViewEvent;
  createPersistentBrowserTransport: typeof createPersistentBrowserTransport;
  createTraceparentFetch: typeof createTraceparentFetch;
  createUnhandledRejectionEvent: typeof createUnhandledRejectionEvent;
  installLogBrewBrowserFetchInstrumentation: typeof installLogBrewBrowserFetchInstrumentation;
  installLogBrewBrowserInteractionTimingInstrumentation: typeof installLogBrewBrowserInteractionTimingInstrumentation;
  installLogBrewBrowserNavigationInstrumentation: typeof installLogBrewBrowserNavigationInstrumentation;
  installLogBrewBrowserNavigationTimingInstrumentation: typeof installLogBrewBrowserNavigationTimingInstrumentation;
  installLogBrewBrowserResourceTimingInstrumentation: typeof installLogBrewBrowserResourceTimingInstrumentation;
  installLogBrewBrowserWebVitalsInstrumentation: typeof installLogBrewBrowserWebVitalsInstrumentation;
  installLogBrewBrowserXhrInstrumentation: typeof installLogBrewBrowserXhrInstrumentation;
  installLogBrewBrowser: typeof installLogBrewBrowser;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
};

export type { BrowserFetchInstrumentation, BrowserFetchOptions, BrowserInteractionTimingInstrumentation, BrowserInteractionTimingObserver, BrowserInteractionTimingObserverConstructor, BrowserInteractionTimingObserverEntryType, BrowserInteractionTimingOptions, BrowserInteractionToNextPaintOptions, BrowserNavigationInstrumentation, BrowserNavigationInstrumentationOptions, BrowserNavigationTimingInstrumentation, BrowserNavigationTimingOptions, BrowserResourceTimingInstrumentation, BrowserResourceTimingObserver, BrowserResourceTimingObserverConstructor, BrowserResourceTimingOptions, BrowserWebVitalCallback, BrowserWebVitalsInstrumentation, BrowserWebVitalsModule, BrowserWebVitalsOptions, BrowserXhrInstrumentation, BrowserXhrOptions } from "./types-instrumentation.js";
export type { BrowserFlushDetails, BrowserFlushReason, BrowserInstrumentationOptions, LogBrewBrowserContext, LogBrewBrowserOptions } from "./types-options.js";
export type { BrowserActionInput, BrowserFetchInput, BrowserFetchPathTemplate, BrowserFetchTemplateContext, BrowserInteractionTimingInput, BrowserInteractionTimingPathTemplate, BrowserInteractionTimingTemplateContext, BrowserIssueSuppressedResult, BrowserIssueSuppressionMatcher, BrowserIssueSuppressionRule, BrowserIssueSuppressionSummary, BrowserMetadataKind, BrowserNavigationPathTemplate, BrowserNavigationTimingInput, BrowserNavigationTimingTemplateContext, BrowserNetworkInput, BrowserResourcePathTemplate, BrowserResourceTimingInput, BrowserResourceTimingTemplateContext, BrowserWebVitalInput, BrowserWebVitalPathTemplate, BrowserWebVitalTemplateContext, BrowserXhrInput, BrowserXhrPathTemplate, BrowserXhrTemplateContext, LogBrewBrowserEvent } from "./types-signals.js";
export type { BeaconTransport, BeaconTransportConfig, BeaconTransportResponse, BrowserPersistedReplay, BrowserPersistedReplayOptions, BrowserPersistenceLockManager, BrowserPersistentStorage, BrowserPersistError, BrowserTraceContext, BrowserTraceContextConfig, BrowserTraceContextInput, BrowserTraceContextSource, BrowserTraceparentConfig, CreateLogBrewBrowserClientConfig, FetchTransportConfig, PersistentBrowserTransport, PersistentBrowserTransportConfig, TraceparentFetchConfig, TracePropagationTarget } from "./types-transport.js";
export {
  captureBrowserAction,
  captureBrowserError,
  captureBrowserFetchSpan,
  captureBrowserInteractionTiming,
  captureBrowserInteractionToNextPaint,
  captureBrowserNavigationTiming,
  captureBrowserNetwork,
  captureBrowserResourceTiming,
  captureBrowserWebVital,
  captureBrowserXhrSpan,
  capturePageView,
  captureUnhandledRejection,
  createBeaconTransport,
  createBrowserActionEvent,
  createBrowserErrorEvent,
  createBrowserFetchSpanEvent,
  createBrowserInteractionTimingEvent,
  createBrowserInteractionToNextPaintEvent,
  createBrowserNavigationTimingEvent,
  createBrowserNetworkEvent,
  createBrowserResourceTimingEvent,
  createBrowserTraceContext,
  createBrowserTraceparent,
  createBrowserWebVitalEvent,
  createBrowserXhrSpanEvent,
  createFetchTransport,
  createLogBrewBrowserClient,
  createLogBrewBrowserContext,
  createLogBrewBrowserFetch,
  createPageViewEvent,
  createPersistentBrowserTransport,
  createTraceparentFetch,
  createUnhandledRejectionEvent,
  installLogBrewBrowser,
  installLogBrewBrowserFetchInstrumentation,
  installLogBrewBrowserInteractionTimingInstrumentation,
  installLogBrewBrowserNavigationInstrumentation,
  installLogBrewBrowserNavigationTimingInstrumentation,
  installLogBrewBrowserResourceTimingInstrumentation,
  installLogBrewBrowserWebVitalsInstrumentation,
  installLogBrewBrowserXhrInstrumentation,
  shouldPropagateTraceparent
};
export default defaultExport;
