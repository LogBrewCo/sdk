import type { ActionAttributes, IssueAttributes, LogBrewClient, Metadata, SpanAttributes, Transport, TransportResponse } from "@logbrew/sdk";
import type { BrowserActionInput, BrowserFetchInput, BrowserInteractionTimingInput, BrowserIssueSuppressionRule, BrowserIssueSuppressionSummary, BrowserMetadataKind, BrowserNetworkInput, BrowserWebVitalInput, BrowserXhrInput, LogBrewBrowserEvent } from "./types-signals.js";
import type { BrowserPersistedReplay, BrowserTraceContext, BrowserTraceContextInput, BrowserTraceContextSource, CreateLogBrewBrowserClientConfig, FetchTransportConfig, PersistentBrowserTransportConfig } from "./types-transport.js";

type BrowserEventIdContext = {
  action?: BrowserActionInput | undefined;
  browserWindow?: Window | undefined;
  entry?: BrowserInteractionTimingInput | undefined;
  error?: unknown;
  message?: string | undefined;
  metric?: BrowserWebVitalInput | undefined;
  request?: BrowserFetchInput | BrowserNetworkInput | BrowserXhrInput | undefined;
  path: string;
  source?: string | undefined;
};

/** Turns the stored anonymous visitor ID on or off after install, for example when consent changes. */
type BrowserAnonymousSubject = {
  /** Start adding the anonymous ID to events. Reads the stored ID or creates one on the next event. */
  enable: () => void;
  /** Stop adding the anonymous ID and remove it from storage. */
  disable: () => void;
  /** Remove the stored ID. If the ID is on, the next event gets a new ID. */
  reset: () => void;
};

type BrowserAnonymousSubjectOption = boolean | {
  /** Days the ID lasts from its creation, 1 to 395 (13 months). Defaults to 395. Later visits do not extend it. */
  maxAgeDays?: number | undefined;
};

type LogBrewBrowserContext = {
  /** Set by installLogBrewBrowser when it creates the client. */
  anonymousSubject?: BrowserAnonymousSubject | undefined;
  browserWindow?: Window | undefined;
  client: LogBrewClient;
  logbrew: LogBrewClient;
  traceContext?: BrowserTraceContext | undefined;
  transport: Transport;
  previewJson: () => string;
  flush: () => Promise<TransportResponse>;
  replayStoredBatches: () => Promise<BrowserPersistedReplay>;
  shutdown: () => Promise<TransportResponse>;
  uninstall: () => void;
};

type BrowserFlushReason = "capture" | "online" | "pagehide" | "visibility_hidden";

type BrowserFlushDetails = {
  reason: BrowserFlushReason;
};

type LogBrewBrowserOptions = CreateLogBrewBrowserClientConfig & FetchTransportConfig & {
  browserWindow?: Window | undefined;
  client?: LogBrewClient | undefined;
  /**
   * Keep a random anonymous visitor ID in localStorage and add it to every event as
   * `context.subject` with kind `anonymous`, so returning visitors can be counted. Defaults to false:
   * nothing is stored. A subject the app sets wins. Get consent where the law requires it.
   */
  anonymousSubject?: BrowserAnonymousSubjectOption | undefined;
  /**
   * Add a session ID to every event as `context.session.id`. Defaults to true. The ID lives in the tab's
   * `sessionStorage`, so it survives reloads in that tab. A session ends after 30 minutes without events or
   * 4 hours after it starts, and the next event starts a new one. Set false to send no session ID. A
   * `session` in `context` replaces it.
   */
  session?: boolean | undefined;
  /** App-owned transports remain available to explicit flush, but are not invoked by page-exit lifecycle signals. */
  transport?: Transport | undefined;
  /**
   * Record console calls, fetch and XHR requests, and route changes as issue breadcrumbs. Defaults to true.
   * The wrappers only observe: they never add headers or change requests.
   */
  breadcrumbs?: boolean | undefined;
  captureGlobalErrors?: boolean | undefined;
  captureUnhandledRejections?: boolean | undefined;
  capturePageViews?: boolean | undefined;
  /**
   * Tag every event with the landing URL's utm_source, utm_medium, and utm_campaign and the referring
   * site's host name, kept for the browser tab session. Defaults to true. App-supplied tags win.
   */
  captureAttribution?: boolean | undefined;
  flushOnCapture?: boolean | undefined;
  flushOnOnline?: boolean | undefined;
  /** Allow the built-in bounded keepalive transport to deliver on pagehide. Defaults to true. */
  flushOnPageHide?: boolean | undefined;
  /** Allow the built-in bounded keepalive transport to deliver when visibility becomes hidden. Defaults to true. */
  flushOnVisibilityHidden?: boolean | undefined;
  /** Map of sanitized browser frame paths or minified URLs to release-artifact Debug IDs. */
  debugIdMap?: Record<string, string> | undefined;
  /** Runtime label such as `browser`. */
  runtime?: string | undefined;
  /** Platform label such as `web`. */
  platform?: string | undefined;
  /** Optional stable app-owned grouping fingerprint for explicit error capture. Keep it safe and low-cardinality. */
  fingerprint?: string | undefined;
  /** Declarative local-only browser issue suppression rules. Matching issues are not queued or flushed. */
  errorSuppressionRules?: BrowserIssueSuppressionRule[] | undefined;
  /** Return false to suppress one sanitized browser issue before enqueueing. */
  shouldCaptureError?: undefined | ((
    event: LogBrewBrowserEvent<IssueAttributes>,
    summary: BrowserIssueSuppressionSummary
  ) => boolean);
  /** Called after an issue is suppressed. Summary fields are path/type/grouping-only and omit message/stack text. */
  onIssueSuppressed?: undefined | ((
    summary: BrowserIssueSuppressionSummary,
    context: LogBrewBrowserContext,
    details: BrowserFlushDetails
  ) => void | Promise<void>);
  /** Include raw error stack text only when the app has explicitly approved it. Defaults to false. */
  includeErrorStack?: boolean | undefined;
  includeDocumentTitle?: boolean | undefined;
  includeHash?: boolean | undefined;
  includeQueryString?: boolean | undefined;
  includeUserAgent?: boolean | undefined;
  metadata?: Metadata | undefined;
  now?: (() => string) | undefined;
  persistOffline?: boolean | Omit<PersistentBrowserTransportConfig, "transport"> | undefined;
  preventDefault?: boolean | undefined;
  randomValues?: ((length: number) => ArrayLike<number>) | undefined;
  raiseCaptureErrors?: boolean | undefined;
  replayPersistedOnInstall?: boolean | undefined;
  sampled?: boolean | undefined;
  sanitizeMetadata?: ((metadata: Metadata, kind: BrowserMetadataKind) => Metadata) | undefined;
  spanId?: string | undefined;
  traceContext?: BrowserTraceContextInput | undefined;
  traceFlags?: string | undefined;
  traceId?: string | undefined;
  pageViewEvent?: undefined | ((
    context: { browserWindow?: Window; client: LogBrewClient; traceContext?: BrowserTraceContext }
  ) => LogBrewBrowserEvent<SpanAttributes>);
  errorEvent?: undefined | ((
    error: unknown,
    context: { browserWindow?: Window; client: LogBrewClient; traceContext?: BrowserTraceContext }
  ) => LogBrewBrowserEvent<IssueAttributes>);
  rejectionEvent?: undefined | ((
    rejection: unknown,
    context: { browserWindow?: Window; client: LogBrewClient; traceContext?: BrowserTraceContext }
  ) => LogBrewBrowserEvent<IssueAttributes>);
  actionEvent?: undefined | ((
    action: BrowserActionInput,
    context: { browserWindow?: Window; client: LogBrewClient; traceContext?: BrowserTraceContext }
  ) => LogBrewBrowserEvent<ActionAttributes>);
  networkEvent?: undefined | ((
    request: BrowserNetworkInput,
    context: { browserWindow?: Window; client: LogBrewClient; traceContext?: BrowserTraceContext }
  ) => LogBrewBrowserEvent<ActionAttributes>);
  idFactory?: undefined | ((context: BrowserEventIdContext) => string);
  onFlush?: undefined | ((
    response: TransportResponse,
    context: LogBrewBrowserContext,
    details: BrowserFlushDetails
  ) => void | Promise<void>);
  onCaptureError?: undefined | ((
    error: unknown,
    context: LogBrewBrowserContext,
    details: BrowserFlushDetails
  ) => void | Promise<void>);
};

type BrowserInstrumentationOptions = Omit<LogBrewBrowserOptions, "traceContext"> & {
  /** A trace context, or a function called for each captured signal that returns one. */
  traceContext?: BrowserTraceContextSource | undefined;
};

export type {
  BrowserAnonymousSubject,
  BrowserAnonymousSubjectOption,
  BrowserEventIdContext,
  BrowserFlushDetails,
  BrowserFlushReason,
  BrowserInstrumentationOptions,
  LogBrewBrowserContext,
  LogBrewBrowserOptions
};
