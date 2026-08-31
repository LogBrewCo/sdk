/** Metadata values that can be attached to public LogBrew event payloads. */
export type MetadataValue = string | number | boolean | null;
/** Structured metadata map shared by public LogBrew event attribute types. */
export type Metadata = Record<string, MetadataValue>;
/** Bounded service, runtime, or framework identity shared by telemetry signals. */
export type TelemetryNamedVersion = {
  name: string;
  version?: string;
};
/** Privacy-bounded resource identity shared by telemetry signals. */
export type TelemetryResource = {
  service?: TelemetryNamedVersion;
  deployment?: { environment?: string; release?: string };
  runtime?: TelemetryNamedVersion;
  framework?: TelemetryNamedVersion;
  operatingSystem?: TelemetryNamedVersion & { build?: string };
  device?: { family?: string; model?: string; architecture?: string };
  application?: { name?: string; version?: string; build?: string };
};
/** W3C-compatible correlation identity shared by non-span telemetry. */
export type TelemetryTraceContext = {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  sampled?: boolean;
};
/** Opaque application session identity. */
export type TelemetrySessionContext = {
  id: string;
  previousId?: string;
};
/** Explicit app-owned subject identity; do not send names, email addresses, or IP addresses. */
export type TelemetrySubjectContext = {
  id: string;
  kind: "anonymous" | "user";
};
/** Versioned shared context available on every LogBrew event type. */
export type TelemetryContext = {
  schemaVersion: 1;
  resource?: TelemetryResource;
  trace?: TelemetryTraceContext;
  session?: TelemetrySessionContext;
  subject?: TelemetrySubjectContext;
  /** Up to 32 low-cardinality string dimensions with safe machine keys. */
  tags?: Record<string, string>;
};
/** Canonical user-facing severity categories accepted by LogBrew. */
export type Severity = "info" | "warning" | "error" | "critical";
/** Runtime-level aliases accepted for compatibility and normalized before send. */
export type SeverityAlias = "trace" | "debug" | "warn" | "fatal";
/** Public severity input accepted by issue and log attributes. */
export type SeverityInput = Severity | SeverityAlias;

/** Parsed W3C trace context from a traceparent value. */
export type TraceparentContext = {
  version: string;
  traceId: string;
  parentSpanId: string;
  traceFlags: string;
  sampled: boolean;
};

/** Minimal active trace shape accepted by logger adapters for correlation metadata. */
export type LogCorrelationTraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled?: boolean;
};

/** Inputs for creating a W3C traceparent value from known trace/span ids. */
export type TraceparentInput = {
  traceId: string;
  spanId: string;
  traceFlags?: string;
};

/** Privacy-bounded W3C tracestate entry for explicit propagation. */
export type TracestateEntry = {
  key: string;
  value: string;
};

/** W3C baggage entry for explicit propagation. */
export type BaggageEntry = {
  key: string;
  value: string;
  properties?: string[];
};

/** Inputs for creating an explicit W3C trace context header carrier. */
export type TraceContextInput = TraceparentInput & {
  tracestate?: string | TracestateEntry[];
  baggage?: string | BaggageEntry[];
};

/** Minimal OpenTelemetry SpanContext-like shape copied by dependency-free bridge helpers. */
export type OpenTelemetrySpanContextLike = {
  traceId?: unknown;
  spanId?: unknown;
  traceFlags?: unknown;
  isValid?: boolean;
};

/** Minimal OpenTelemetry Span-like shape accepted by dependency-free bridge helpers. */
export type OpenTelemetrySpanLike = {
  spanContext?: () => OpenTelemetrySpanContextLike | null | undefined;
  getSpanContext?: () => OpenTelemetrySpanContextLike | null | undefined;
};

/** Minimal OpenTelemetry API-like shape used for the current active span helper. */
export type OpenTelemetryApiLike = {
  trace?: {
    getActiveSpan?: () => OpenTelemetrySpanLike | null | undefined;
  };
};

/** OpenTelemetry high-resolution time tuple accepted by dependency-free ReadableSpan helpers. */
export type OpenTelemetryHrTimeLike = readonly [number, number];

/** Minimal OpenTelemetry event-like shape summarized from ended spans. */
export type OpenTelemetryTimedEventLike = {
  name?: unknown;
  time?: OpenTelemetryHrTimeLike | number | Date;
  timestamp?: OpenTelemetryHrTimeLike | number | Date;
  attributes?: Record<string, unknown>;
};

/** Minimal OpenTelemetry link-like shape summarized from ended spans. */
export type OpenTelemetrySpanLinkLike = {
  context?: OpenTelemetrySpanContextLike | null | undefined;
  spanContext?: OpenTelemetrySpanContextLike | null | undefined;
  attributes?: Record<string, unknown>;
};

/** Minimal OpenTelemetry ReadableSpan-like shape accepted by dependency-free bridge helpers. */
export type OpenTelemetryReadableSpanLike = {
  name?: unknown;
  kind?: unknown;
  spanContext?: () => OpenTelemetrySpanContextLike | null | undefined;
  parentSpanContext?: OpenTelemetrySpanContextLike | null | undefined;
  parentSpanId?: unknown;
  startTime?: OpenTelemetryHrTimeLike | number | Date;
  endTime?: OpenTelemetryHrTimeLike | number | Date;
  duration?: OpenTelemetryHrTimeLike;
  status?: { code?: unknown };
  attributes?: Record<string, unknown>;
  events?: OpenTelemetryTimedEventLike[];
  links?: OpenTelemetrySpanLinkLike[];
  resource?: { attributes?: Record<string, unknown> };
  instrumentationScope?: { name?: unknown; version?: unknown };
  droppedAttributesCount?: unknown;
  droppedEventsCount?: unknown;
  droppedLinksCount?: unknown;
};

/** Options for creating a LogBrew child trace from OpenTelemetry context. */
export type OpenTelemetryTraceContextOptions = {
  spanId?: string;
  spanIdFactory?: () => string;
};

/** Options for reading OpenTelemetry's current active span without requiring an OTel dependency. */
export type CurrentOpenTelemetryTraceContextOptions = OpenTelemetryTraceContextOptions & {
  openTelemetryApi?: OpenTelemetryApiLike;
};

/** Options for privacy-bounded OpenTelemetry ReadableSpan conversion. */
export type OpenTelemetryReadableSpanOptions = {
  /** Additional safe span attribute keys to copy; sensitive keys remain blocked. */
  attributeKeys?: string[];
  /** Capture unsampled spans. Defaults to false to follow common OTel processor behavior. */
  captureUnsampled?: boolean;
  /** Additional safe span event attribute keys to copy; sensitive keys remain blocked. */
  eventAttributeKeys?: string[];
  /** Include privacy-bounded span event summaries. Defaults to true. */
  includeSpanEvents?: boolean;
  /** Include privacy-bounded span link summaries. Defaults to true. */
  includeSpanLinks?: boolean;
  /** Additional safe span link attribute keys to copy; sensitive keys remain blocked. */
  linkAttributeKeys?: string[];
  /** Primitive app metadata merged into every converted span. */
  metadata?: Metadata;
  /** Additional safe resource attribute keys to copy; sensitive keys remain blocked. */
  resourceAttributeKeys?: string[];
};

/** Configuration for an opt-in OpenTelemetry SpanProcessor-compatible LogBrew bridge. */
export type OpenTelemetrySpanProcessorConfig = OpenTelemetryReadableSpanOptions & {
  client: LogBrewClient;
  transport?: Transport;
  flushOnForceFlush?: boolean;
  /** Emit one privacy-bounded synthetic trace summary span per trace on forceFlush/shutdown. Defaults to false. */
  includeTraceSummary?: boolean;
  timestamp?: () => string;
  eventIdPrefix?: string;
  spanFilter?: (span: unknown) => boolean | void;
  onError?: (error: unknown) => void;
};

/** Configuration for an opt-in OpenTelemetry SpanExporter-compatible LogBrew bridge. */
export type OpenTelemetrySpanExporterConfig = OpenTelemetryReadableSpanOptions & {
  client: LogBrewClient;
  transport?: Transport;
  /** Flush with the provided transport during export. Defaults to true when a transport is supplied. */
  flushOnExport?: boolean;
  /** Emit one privacy-bounded synthetic trace summary span per exported batch. Defaults to false. */
  includeTraceSummary?: boolean;
  timestamp?: () => string;
  eventIdPrefix?: string;
  spanFilter?: (span: unknown) => boolean | void;
  onError?: (error: unknown) => void;
};

/** Minimal OpenTelemetry export result shape; success is code 0, failure is code 1. */
export type OpenTelemetryExportResult = {
  code: number;
  error?: Error;
};

/** SpanExporter-compatible handle for app-owned OpenTelemetry processors. */
export type OpenTelemetrySpanExporterHandle = {
  export(
    spans: readonly (OpenTelemetryReadableSpanLike | unknown)[],
    resultCallback: (result: OpenTelemetryExportResult) => void
  ): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

/** SpanProcessor-compatible handle for app-owned OpenTelemetry setup. */
export type OpenTelemetrySpanProcessorHandle = {
  onStart(span: unknown, parentContext: unknown): void;
  onEnd(span: OpenTelemetryReadableSpanLike | unknown): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

/** Span fields supplied when deriving LogBrew span attributes from traceparent. */
export type TraceparentSpanInput = {
  name: string;
  spanId: string;
  status: "ok" | "error";
  durationMs?: number;
  links?: SpanLinkSummary[];
  metadata?: Metadata;
  events?: SpanEventSummary[];
};

/** Public release event attributes. */
export type ReleaseAttributes = {
  version: string;
  commit?: string;
  notes?: string;
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Public environment event attributes. */
export type EnvironmentAttributes = {
  name: string;
  region?: string;
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Privacy-bounded generated JavaScript frame attached to an issue. */
export type IssueStackFrame = {
  /** Query-free generated filename or URL with local absolute prefixes removed. */
  filename: string;
  /** One-based generated source line. */
  line: number;
  /** One-based generated source column. */
  column: number;
  /** Optional bounded function or method identity. */
  function?: string;
  /** Optional bounded module, package, or namespace identity. */
  module?: string;
  /** Whether application code classified this frame as app-owned. */
  inApp?: boolean;
  /** Optional release-artifact Debug ID matched to this generated file. */
  debugId?: string;
};

/** Runtime path that captured an exception and whether it escaped that path. */
export type IssueExceptionMechanism = {
  /** Stable low-cardinality capture mechanism, such as `react.error_boundary`. */
  type: string;
  /** False when the exception escaped the capture boundary. */
  handled: boolean;
};

/** Structured exception identity attached to an issue. */
export type IssueException = {
  /** Bounded runtime exception class or error type. */
  type: string;
  /** Capture mechanism when the SDK can determine it. */
  mechanism?: IssueExceptionMechanism;
};

export type IssueExceptionRelationship =
  | "reported"
  | "cause"
  | "context"
  | "aggregate_member"
  | "suppressed";
export type IssueExceptionMessageState = "captured" | "truncated" | "redacted" | "not_captured";
export type IssueExceptionStackFramesState = "captured" | "truncated" | "not_captured";

/** One parent-first runtime exception with its own message and structured stack state. */
export type IssueExceptionChainEntry = {
  /** Contiguous zero-based node identity. */
  id: number;
  /** Earlier parent node. Omitted only for the reported root exception. */
  parentId?: number;
  relationship: IssueExceptionRelationship;
  type: string;
  /** Bounded message only when messageState is captured or truncated. */
  message?: string;
  messageState: IssueExceptionMessageState;
  module?: string;
  mechanism?: IssueExceptionMechanism;
  /** This exact exception's bounded structured frames. */
  stackFrames?: IssueStackFrame[];
  stackFramesState: IssueExceptionStackFramesState;
};

/** At most eight parent-first runtime exceptions. */
export type IssueExceptionChain = {
  entries: IssueExceptionChainEntry[];
  /** True when a cycle or node cap omitted additional exceptions. */
  truncated: boolean;
};

export type IssueBreadcrumbLevel = "debug" | "info" | "warning" | "error" | "critical";
export type IssueBreadcrumbLevelInput = IssueBreadcrumbLevel | "trace" | "log" | "warn" | "fatal";
export type IssueBreadcrumbDataValue = string | number | boolean | null;

/** One privacy-bounded step that happened before an issue. */
export type IssueBreadcrumb = {
  /** RFC 3339 timestamp with an explicit timezone. */
  timestamp: string;
  /** Optional stable breadcrumb kind, such as `navigation` or `http`. */
  type?: string;
  /** Required low-cardinality source category. */
  category: string;
  level?: IssueBreadcrumbLevel;
  /** Optional bounded display-safe description. */
  message?: string;
  /** At most eight flat primitive fields. Never include authentication material or raw request data. */
  data?: Record<string, IssueBreadcrumbDataValue>;
};

/** Input accepted by `addBreadcrumb`; the client supplies the current timestamp when omitted. */
export type IssueBreadcrumbInput = Omit<IssueBreadcrumb, "timestamp" | "level"> & {
  timestamp?: string;
  level?: IssueBreadcrumbLevelInput;
};

/** App-reported code location that narrows the smallest likely fix area. */
export type IssueLikelyFixArea = {
  component?: string;
  module?: string;
  function?: string;
  /** Safe repository-relative source path. */
  file?: string;
  line?: number;
  column?: number;
  inApp?: boolean;
};

/** App-reported user impact without user identities or raw request data. */
export type IssueImpactEvidence = {
  affectedUserSegment?: string;
  failedAction?: string;
  userVisibleOutcome?: string;
};

/** Explicit diagnostic evidence for cause, fix area, impact, and capture limitations. */
export type IssueDiagnosticEvidence = {
  /** App-owned hypothesis. LogBrew presents it as reported, never proven. */
  likelyRootCause?: string;
  likelyFixArea?: IssueLikelyFixArea;
  impact?: IssueImpactEvidence;
  /** Unique bounded field names whose values were captured. */
  capturedFields?: string[];
  missingFields?: string[];
  redactedFields?: string[];
  truncatedFields?: string[];
};

export type NativeStackArchitecture = "arm" | "arm64" | "arm64e" | "x86" | "x86_64";

export type NativeStackFrame = {
  imageUuid: string;
  architecture: NativeStackArchitecture;
  instructionOffset: string;
};

/** Public issue event attributes. */
export type IssueAttributes = {
  title: string;
  level: SeverityInput;
  message?: string;
  exception?: IssueException;
  /** Parent-first runtime exception evidence; the first node agrees with legacy exception/stackFrames. */
  exceptionChain?: IssueExceptionChain;
  /** Ordered privacy-bounded generated frames, capped at 32. */
  stackFrames?: IssueStackFrame[];
  /** Ordered native image-relative frames for exact release symbolication, capped at 32. */
  nativeStackFrames?: NativeStackFrame[];
  /** Oldest-to-newest issue history, capped at the most recent 64 entries. */
  breadcrumbs?: IssueBreadcrumb[];
  /** True when older or invalid history was omitted before capture. */
  breadcrumbsTruncated?: boolean;
  /** App-reported diagnostic evidence, validated and labeled separately from observed facts. */
  evidence?: IssueDiagnosticEvidence;
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Options for creating privacy-bounded issue attributes from a JavaScript error. */
export type JavaScriptErrorIssueOptions = {
  title?: string;
  level?: SeverityInput;
  message?: string;
  metadata?: Metadata;
  /** Stable low-cardinality capture mechanism. Defaults to `javascript.error`. */
  mechanism?: string;
  /** Whether the error was handled by the capture boundary. Defaults to true. */
  handled?: boolean;
  /** Metadata source label. Defaults to `javascript.error`. */
  source?: string;
  /** Active trace copied into primitive correlation metadata. */
  trace?: LogCorrelationTraceContext | null;
  /** Release name associated with the runtime error. */
  release?: string;
  /** Environment associated with the runtime error. */
  environment?: string;
  /** Service associated with the runtime error. */
  service?: string;
  /** Runtime label such as `browser`, `node`, or `react-native`. */
  runtime?: string;
  /** Platform label such as `web`, `ios`, or `android`. */
  platform?: string;
  /** Map of sanitized frame filenames or minified URLs to release-artifact Debug IDs. */
  debugIdMap?: Record<string, string>;
  /** Optional stable app-owned grouping fingerprint. Keep it safe and low-cardinality. */
  fingerprint?: string;
  /** App-reported cause, fix-area, impact, and explicit evidence-state receipt. */
  evidence?: IssueDiagnosticEvidence;
  /** Include raw stack text only when the app has explicitly approved it. Defaults to false. */
  includeErrorStack?: boolean;
};

/** Public log event attributes. */
export type LogAttributes = {
  message: string;
  level: SeverityInput;
  logger?: string;
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Console method names supported by the opt-in console capture helper. */
export type ConsoleMethodName = "debug" | "info" | "log" | "warn" | "error";

/** Minimal console-like target accepted by the opt-in console capture helper. */
export type ConsoleLike = Partial<Record<ConsoleMethodName, (...args: unknown[]) => void>>;

/** Configuration for opt-in console capture. */
export type ConsoleCaptureConfig = {
  client: LogBrewClient;
  console?: ConsoleLike;
  levels?: ConsoleMethodName[];
  logger?: string;
  metadata?: Metadata;
  transport?: Transport;
  flushOnCapture?: boolean;
  includeErrorStack?: boolean;
  timestamp?: () => string;
  eventIdPrefix?: string;
  onError?: (error: unknown) => void;
};

/** Handle returned by opt-in console capture installation. */
export type ConsoleCaptureHandle = {
  flush(): Promise<TransportResponse | null>;
  uninstall(): void;
};

/** Pino JSON log record shape accepted by the optional Pino destination helper. */
export type PinoLogRecord = Record<string, unknown> & {
  level?: string | number;
  time?: string | number;
  timestamp?: string | number;
  msg?: unknown;
  message?: unknown;
  err?: unknown;
  error?: unknown;
};

/** Configuration for the dependency-free Pino destination adapter. */
export type PinoDestinationConfig = {
  client: LogBrewClient;
  logger?: string;
  metadata?: Metadata;
  traceProvider?: () => LogCorrelationTraceContext | null | undefined;
  transport?: Transport;
  flushOnWrite?: boolean;
  includeErrorStack?: boolean;
  timestamp?: () => string;
  eventIdPrefix?: string;
  onError?: (error: unknown) => void;
};

/** Stream-like destination returned for use as Pino's output destination. */
export type PinoDestinationHandle = {
  write(chunk: unknown): boolean;
  flush(): Promise<TransportResponse | null>;
  end(): Promise<TransportResponse | null>;
};

/** Winston info object shape accepted by the optional Winston transport helper. */
export type WinstonLogInfo = Record<string, unknown> & {
  level?: string;
  message?: unknown;
  timestamp?: string | number | Date;
  time?: string | number | Date;
  err?: unknown;
  error?: unknown;
  stack?: unknown;
};

/** Configuration for the dependency-free Winston transport adapter. */
export type WinstonTransportConfig = {
  client: LogBrewClient;
  logger?: string;
  metadata?: Metadata;
  traceProvider?: () => LogCorrelationTraceContext | null | undefined;
  transport?: Transport;
  flushOnWrite?: boolean;
  includeErrorStack?: boolean;
  timestamp?: () => string;
  eventIdPrefix?: string;
  level?: string;
  name?: string;
  silent?: boolean;
  handleExceptions?: boolean;
  handleRejections?: boolean;
  onError?: (error: unknown) => void;
};

/** Object-mode transport returned for use in a Winston logger's transports array. */
export type WinstonTransportHandle = {
  level?: string;
  name?: string;
  silent?: boolean;
  handleExceptions?: boolean;
  handleRejections?: boolean;
  log(info: WinstonLogInfo, callback?: () => void): void;
  write(info: WinstonLogInfo): boolean;
  flush(): Promise<TransportResponse | null>;
  end(callback?: () => void): unknown;
};

/** Privacy-bounded milestone recorded inside a span. */
export type SpanEventSummary = {
  name: string;
  timestamp?: string;
  metadata?: Metadata;
};

/** Privacy-bounded reference from this span to another trace/span. */
export type SpanLinkSummary = {
  traceId: string;
  spanId: string;
  sampled?: boolean;
  metadata?: Metadata;
};

/** Public span event attributes. */
export type SpanAttributes = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status: "ok" | "error";
  durationMs?: number;
  events?: SpanEventSummary[];
  links?: SpanLinkSummary[];
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Public action event attributes. */
export type ActionAttributes = {
  name: string;
  status: "queued" | "running" | "success" | "failure";
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Stable product-analytics event categories carried in reserved action metadata. */
export type ProductAnalyticsKind = "page_view" | "screen_view" | "interaction";

/** Current version of the reserved product-analytics metadata vocabulary. */
export declare const PRODUCT_ANALYTICS_SCHEMA_VERSION: 1;

/** Product-analytics categories understood by this SDK version. */
export declare const PRODUCT_ANALYTICS_KINDS: readonly ProductAnalyticsKind[];

/** App-owned product step input for agent-readable action timelines. */
export type ProductActionInput = string | {
  name: string;
  status?: ActionAttributes["status"];
  sessionId?: string;
  traceId?: string;
  routeTemplate?: string;
  screen?: string;
  funnel?: string;
  step?: string;
  metadata?: Metadata;
};

/** App-owned API milestone input for agent-readable network timelines. */
export type NetworkMilestoneInput = string | {
  name?: string;
  routeTemplate: string;
  method?: string;
  status?: ActionAttributes["status"];
  statusCode?: number;
  durationMs?: number;
  sessionId?: string;
  traceId?: string;
  metadata?: Metadata;
};

/** Shared timeline helper options for primitive app metadata. */
export type TimelineAttributesOptions = {
  metadata?: Metadata;
};

/** Planned backend support-ticket sources accepted by explicit draft helpers. */
export type SupportTicketSource = "cli" | "sdk" | "website" | "docs" | "mobile";

/** Planned backend support-ticket categories accepted by explicit draft helpers. */
export type SupportTicketCategory =
  | "sdk_install_failure"
  | "ingest_failure"
  | "auth_failure"
  | "project_setup"
  | "dashboard_issue"
  | "docs_confusion"
  | "cli_issue"
  | "mobile_issue"
  | "billing_question"
  | "other";

/** JSON-like diagnostics input sanitized before a support-ticket draft is returned. */
export type SupportDiagnosticsValue =
  | string
  | number
  | boolean
  | null
  | SupportDiagnosticsValue[]
  | { [key: string]: SupportDiagnosticsValue };

/** Explicit local-only support-ticket draft input. This does not open a ticket. */
export type SupportTicketDraftInput = {
  source: SupportTicketSource;
  category: SupportTicketCategory;
  title: string;
  description: string;
  projectId?: string;
  environment?: string;
  runtime?: string;
  framework?: string;
  sdkPackage?: string;
  sdkVersion?: string;
  release?: string;
  traceId?: string;
  eventId?: string;
  diagnostics?: Record<string, unknown>;
};

/** Planned backend create payload produced locally for explicit user or agent action. */
export type SupportTicketDraft = {
  source: SupportTicketSource;
  category: SupportTicketCategory;
  title: string;
  description: string;
  project_id?: string;
  environment?: string;
  runtime?: string;
  framework?: string;
  sdk_package?: string;
  sdk_version?: string;
  release?: string;
  trace_id?: string;
  event_id?: string;
  diagnostics?: Record<string, SupportDiagnosticsValue>;
};

/** Public metric event attributes. Use low-cardinality metadata only. */
export type MetricAttributes = {
  name: string;
  /** Optional stable, single-line meaning; 1 to 1,024 Unicode characters. */
  description?: string;
  kind: "counter" | "histogram";
  value: number;
  unit: string;
  temporality: "delta" | "cumulative";
  metadata?: Metadata;
  context?: TelemetryContext;
} | {
  name: string;
  /** Optional stable, single-line meaning; 1 to 1,024 Unicode characters. */
  description?: string;
  kind: "gauge";
  value: number;
  unit: string;
  temporality: "instant";
  metadata?: Metadata;
};

/** Public event union used in preview and transport payloads. */
export type Event =
  | { type: "release"; id: string; timestamp: string; attributes: ReleaseAttributes }
  | { type: "environment"; id: string; timestamp: string; attributes: EnvironmentAttributes }
  | { type: "issue"; id: string; timestamp: string; attributes: IssueAttributes }
  | { type: "log"; id: string; timestamp: string; attributes: LogAttributes }
  | { type: "span"; id: string; timestamp: string; attributes: SpanAttributes }
  | { type: "action"; id: string; timestamp: string; attributes: ActionAttributes }
  | { type: "metric"; id: string; timestamp: string; attributes: MetricAttributes };

/** Drop-only event filter called after validation and before an event is queued. */
export type EventFilter = (event: Event) => boolean | void;

/** Canonical compact event record exchanged with an app-owned synchronous persistence adapter. */
export type StoredEvent = {
  event: Event;
  serializedEvent: string;
  eventBytes: number;
};

/** Explicit synchronous persistence seam used to recover and acknowledge queued events safely. */
export type EventStore = {
  load(): StoredEvent[];
  append(record: StoredEvent): void;
  acknowledge(count: number): void;
  purge(): void;
  close(): void;
};

/** Queue drop notification emitted when a bounded in-memory queue is full. */
export type DroppedEvent = {
  reason: "event_too_large" | "queue_bytes_overflow" | "queue_overflow";
  eventType: Event["type"];
  eventId: string;
  droppedEvents: number;
};

/** Stable transport response returned from flush and shutdown operations. */
export type TransportResponse = {
  /** Final HTTP-like status returned by the transport. */
  statusCode: number;
  /** Number of transport attempts used for the flush. */
  attempts: number;
  /** Number of distinct batches acknowledged; client flush/shutdown responses always include it. */
  batches?: number;
  /** Optional retry delay from a rate-limit response, in milliseconds. */
  retryAfterMs?: number;
};

/** Minimal transport interface accepted by flush and shutdown operations. */
export type Transport = {
  send(apiKey: string, body: string): TransportResponse | Promise<TransportResponse>;
};

/** Content-free bounded delivery state with no event or sensitive transport fields. */
export type DeliveryHealthSnapshot = Readonly<{
  /** Stable schema discriminator for JSON consumers. */
  schemaVersion: 1;
  automaticDelivery: boolean;
  lifecycle: "active" | "shutting_down" | "closed";
  deliveryState: "idle" | "queued" | "scheduled" | "in_flight" | "retrying" | "paused" | "accepted" | "failed" | "dropped";
  storage: "memory" | "persistent";
  queueEvents: number;
  queueBytes: number;
  /** Events and compact bytes loaded from persistence when this client started. */
  hydratedEvents: number;
  hydratedBytes: number;
  droppedEvents: number;
  droppedByReason: Readonly<{
    event_too_large: number;
    queue_bytes_overflow: number;
    queue_overflow: number;
  }>;
  lastDropReason: "none" | "event_too_large" | "queue_bytes_overflow" | "queue_overflow";
  scheduled: boolean;
  inFlight: boolean;
  coalesced: boolean;
  pendingOperations: number;
  lastOutcome: "idle" | "empty" | "accepted" | "failed";
  lastStatusClass: "none" | "success" | "client_error" | "server_error" | "network_error" | "transport_error" | "invalid_response" | "other_status";
  pausedReason: "none" | "authentication" | "rate_limit" | "non_retryable";
  consecutiveFailures: number;
  /** Bounded transient retry delay; zero when no automatic retry is scheduled. */
  retryDelayMs: number;
  flushes: number;
  failures: number;
  attempts: number;
  batches: number;
  /** Events durably acknowledged since this client was created. */
  acceptedEvents: number;
  /** Bounded monotonic-within-client Unix milliseconds; zero until the transition occurs. */
  lastAttemptAtUnixMs: number;
  lastAcceptedAtUnixMs: number;
  lastDroppedAtUnixMs: number;
}>;

/** Stable public SDK error with parseable code and message fields. */
export declare class SdkError extends Error {
  code: string;
  retryAfterMs?: number;
  retryable?: boolean;
  constructor(code: string, message: string, details?: { retryAfterMs?: number; retryable?: boolean });
}

/** Transport error that can optionally be marked retryable by the caller. */
export declare class TransportError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable?: boolean);
  /** Create a retryable network failure that preserves queued events. */
  static network(message: string): TransportError;
}

/** Scripted transport for previewing, accepting, or failing queued event flushes. */
export declare class RecordingTransport {
  constructor(scriptedResponses?: Array<{ statusCode: number; retryAfterMs?: number } | Error>);
  /** Every request body sent through this transport instance. */
  sentBodies: string[];
  /** Create a transport that accepts queued flushes with a 202 response. */
  static alwaysAccept(): RecordingTransport;
  /** Return the most recent request body sent through this transport. */
  lastBody(): string | null;
  send(apiKey: string, body: string): Promise<TransportResponse>;
}

/** Buffered public client for validating, previewing, and flushing LogBrew events. */
export declare class LogBrewClient {
  /** Create a client from public SDK identity, retry, and API key settings. */
  static create(config: {
    apiKey: string;
    sdkName: string;
    sdkVersion: string;
    /** Versioned context merged into every captured event; event context can override dynamic fields. */
    context?: TelemetryContext;
    /** Retry attempts after the first send. Must be a non-negative integer; defaults to 2. */
    maxRetries?: number;
    eventFilter?: EventFilter;
    /** Maximum queued compact event bytes. Defaults to 4 MiB. */
    maxQueueBytes?: number;
    maxQueueSize?: number;
    /** Maximum events per request body. Defaults to 100. */
    maxBatchEvents?: number;
    /** Maximum UTF-8 request body bytes. Defaults to 256 KiB. */
    maxBatchBytes?: number;
    onEventDropped?: (drop: DroppedEvent) => void;
    /** Optional app-scoped persistence adapter. Methods must complete synchronously. */
    eventStore?: EventStore;
    /** Client-owned transport used by automatic delivery and by flush/shutdown when no argument is supplied. */
    transport?: Transport;
    /** Enable interval and queue-threshold delivery. Defaults to true when transport is supplied. */
    automaticDelivery?: boolean;
    /** One-shot delivery interval in milliseconds. Defaults to 5000 and must not exceed 60000. */
    deliveryIntervalMs?: number;
    /** Queue count that triggers delivery without waiting for the interval. Defaults to min(50, maxQueueSize). */
    deliveryQueueThreshold?: number;
  }): LogBrewClient;
  /** Return the queued event count currently buffered in memory. */
  pendingEvents(): number;
  /** Return compact serialized event bytes currently buffered in memory. */
  pendingBytes(): number;
  /** Return the number of events dropped because the bounded in-memory queue was full. */
  droppedEvents(): number;
  /** Return a frozen, content-free snapshot of queue and delivery lifecycle health. */
  deliveryHealth(): DeliveryHealthSnapshot;
  /** Return the queued event batch as stable, pretty-printed JSON. */
  previewJson(): string;
  /** Purge queued events from memory and persistence while no delivery operation is active. */
  purgePendingEvents(): number;
  /** Add one explicit privacy-bounded breadcrumb to the client's 64-entry issue history. */
  addBreadcrumb(breadcrumb: IssueBreadcrumbInput, timestamp?: string): void;
  /** Clear the current issue breadcrumb history and return the number removed. */
  clearBreadcrumbs(): number;
  release(id: string, timestamp: string, attributes: ReleaseAttributes): void;
  environment(id: string, timestamp: string, attributes: EnvironmentAttributes): void;
  issue(id: string, timestamp: string, attributes: IssueAttributes): void;
  log(id: string, timestamp: string, attributes: LogAttributes): void;
  span(id: string, timestamp: string, attributes: SpanAttributes): void;
  action(id: string, timestamp: string, attributes: ActionAttributes): void;
  metric(id: string, timestamp: string, attributes: MetricAttributes): void;
  /** Flush one queue snapshot in bounded batches while preserving concurrent captures and retry bodies. */
  flush(transport?: Transport): Promise<TransportResponse>;
  /** Reject new capture, flush queued events, then close; a failed flush reopens the intact remainder. */
  shutdown(transport?: Transport): Promise<TransportResponse>;
}

/** Install explicit console capture while preserving the target console's normal output behavior. */
export declare function installLogBrewConsoleCapture(config: ConsoleCaptureConfig): ConsoleCaptureHandle;

/** Create safe action attributes for an app-owned product step without automatic UI capture. */
export declare function createProductActionAttributes(
  action: ProductActionInput,
  options?: TimelineAttributesOptions
): ActionAttributes;

/** Create safe action attributes for an app-owned network milestone without HTTP client patching. */
export declare function createNetworkMilestoneAttributes(
  request: NetworkMilestoneInput,
  options?: TimelineAttributesOptions
): ActionAttributes;

/** Build a local-only, token-free support-ticket create payload draft without calling backend routes. */
export declare function createSupportTicketDraft(input: SupportTicketDraftInput): SupportTicketDraft;

/**
 * Convert a JavaScript Error-like value into safe issue attributes with optional source-map Debug ID metadata.
 * Parent-first cause and AggregateError evidence is bounded to the public exception-chain contract.
 */
export declare function createIssueAttributesFromError(
  error: unknown,
  options?: JavaScriptErrorIssueOptions
): IssueAttributes;

/** Convert console arguments into safe LogBrew log attributes without installing capture. */
export declare function logAttributesFromConsoleArgs(
  method: ConsoleMethodName,
  args: readonly unknown[],
  options?: {
    logger?: string;
    metadata?: Metadata;
    includeErrorStack?: boolean;
  }
): LogAttributes;

/** Map a console method name to the corresponding LogBrew log level. */
export declare function logbrewLevelFromConsoleMethod(method: ConsoleMethodName): LogAttributes["level"];

/** Parse a W3C traceparent value into normalized trace/span context. */
export declare function parseTraceparent(traceparent: string): TraceparentContext;

/** Create a W3C traceparent value from explicit trace/span ids. */
export declare function createTraceparent(input: TraceparentInput): string;

/** Create an explicit outbound header carrier containing only traceparent. */
export declare function createTraceparentHeaders(input: TraceparentInput): { traceparent: string };

/** Parse a W3C tracestate header into normalized entries. */
export declare function parseTracestate(tracestate: string): TracestateEntry[];

/** Create a normalized W3C tracestate header from explicit entries. */
export declare function createTracestate(entries: TracestateEntry[]): string;

/** Parse a W3C baggage header into decoded entries. */
export declare function parseBaggage(baggage: string): BaggageEntry[];

/** Create a W3C baggage header from explicit entries. */
export declare function createBaggage(entries: BaggageEntry[]): string;

/** Create an explicit outbound carrier for traceparent plus optional tracestate and baggage. */
export declare function createTraceContextHeaders(input: TraceContextInput): {
  traceparent: string;
  tracestate?: string;
  baggage?: string;
};

/** Create a LogBrew child trace from a live OpenTelemetry SpanContext-like object. */
export declare function logbrewTraceContextFromOpenTelemetrySpanContext(
  spanContext: OpenTelemetrySpanContextLike | null | undefined,
  options?: OpenTelemetryTraceContextOptions
): LogCorrelationTraceContext | null;

/** Create a LogBrew child trace from a live OpenTelemetry Span-like object. */
export declare function logbrewTraceContextFromOpenTelemetrySpan(
  span: OpenTelemetrySpanLike | null | undefined,
  options?: OpenTelemetryTraceContextOptions
): LogCorrelationTraceContext | null;

/** Create a LogBrew child trace from OpenTelemetry's current active span, when available. */
export declare function logbrewTraceContextFromCurrentOpenTelemetrySpan(
  options?: CurrentOpenTelemetryTraceContextOptions
): LogCorrelationTraceContext | null;

/** Convert an ended OpenTelemetry ReadableSpan-like object into safe LogBrew span attributes. */
export declare function spanAttributesFromOpenTelemetryReadableSpan(
  span: OpenTelemetryReadableSpanLike | null | undefined,
  options?: OpenTelemetryReadableSpanOptions
): SpanAttributes | null;

/** Create an opt-in SpanProcessor-compatible bridge for app-owned OpenTelemetry providers. */
export declare function createLogBrewOpenTelemetrySpanProcessor(
  config: OpenTelemetrySpanProcessorConfig
): OpenTelemetrySpanProcessorHandle;

/** Create an opt-in SpanExporter-compatible bridge for app-owned OpenTelemetry processors. */
export declare function createLogBrewOpenTelemetrySpanExporter(
  config: OpenTelemetrySpanExporterConfig
): OpenTelemetrySpanExporterHandle;

/** Build LogBrew span attributes that continue an incoming W3C traceparent value. */
export declare function spanAttributesFromTraceparent(
  traceparent: string,
  attributes: TraceparentSpanInput
): SpanAttributes;

/** Create a dependency-free Pino destination that turns JSON log lines into queued LogBrew log events. */
export declare function createLogBrewPinoDestination(config: PinoDestinationConfig): PinoDestinationHandle;

/** Convert a parsed Pino JSON log record into safe LogBrew log attributes without installing a destination. */
export declare function logAttributesFromPinoRecord(
  record: PinoLogRecord,
  options?: {
    logger?: string;
    metadata?: Metadata;
    trace?: LogCorrelationTraceContext | null;
    includeErrorStack?: boolean;
  }
): LogAttributes;

/** Create a dependency-free Winston object-mode transport that queues LogBrew log events. */
export declare function createLogBrewWinstonTransport(config: WinstonTransportConfig): WinstonTransportHandle;

/** Convert a Winston info object into safe LogBrew log attributes without installing a transport. */
export declare function logAttributesFromWinstonInfo(
  info: WinstonLogInfo,
  options?: {
    logger?: string;
    metadata?: Metadata;
    trace?: LogCorrelationTraceContext | null;
    includeErrorStack?: boolean;
  }
): LogAttributes;
