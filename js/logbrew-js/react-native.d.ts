import type {
  LogBrewClient,
  PRODUCT_ANALYTICS_KINDS,
  PRODUCT_ANALYTICS_SCHEMA_VERSION,
  RecordingTransport,
  SdkError,
  TransportError,
  createBaggage,
  createIssueAttributesFromError,
  createLogBrewOpenTelemetrySpanExporter,
  createLogBrewOpenTelemetrySpanProcessor,
  createLogBrewPinoDestination,
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createSupportTicketDraft,
  createTraceContextHeaders,
  createTraceparent,
  createTraceparentHeaders,
  createTracestate,
  installBrowserBreadcrumbs,
  installLogBrewConsoleCapture,
  logAttributesFromConsoleArgs,
  logAttributesFromPinoRecord,
  logbrewLevelFromConsoleMethod,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  parseBaggage,
  parseTraceparent,
  parseTracestate,
  spanAttributesFromOpenTelemetryReadableSpan,
  spanAttributesFromTraceparent
} from "./index.js";

declare const sdk: {
  PRODUCT_ANALYTICS_KINDS: typeof PRODUCT_ANALYTICS_KINDS;
  PRODUCT_ANALYTICS_SCHEMA_VERSION: typeof PRODUCT_ANALYTICS_SCHEMA_VERSION;
  createBaggage: typeof createBaggage;
  createIssueAttributesFromError: typeof createIssueAttributesFromError;
  createLogBrewOpenTelemetrySpanExporter: typeof createLogBrewOpenTelemetrySpanExporter;
  createLogBrewOpenTelemetrySpanProcessor: typeof createLogBrewOpenTelemetrySpanProcessor;
  createLogBrewPinoDestination: typeof createLogBrewPinoDestination;
  createNetworkMilestoneAttributes: typeof createNetworkMilestoneAttributes;
  createProductActionAttributes: typeof createProductActionAttributes;
  createSupportTicketDraft: typeof createSupportTicketDraft;
  createTraceContextHeaders: typeof createTraceContextHeaders;
  createTraceparent: typeof createTraceparent;
  createTraceparentHeaders: typeof createTraceparentHeaders;
  createTracestate: typeof createTracestate;
  installBrowserBreadcrumbs: typeof installBrowserBreadcrumbs;
  installLogBrewConsoleCapture: typeof installLogBrewConsoleCapture;
  LogBrewClient: typeof LogBrewClient;
  logAttributesFromConsoleArgs: typeof logAttributesFromConsoleArgs;
  logAttributesFromPinoRecord: typeof logAttributesFromPinoRecord;
  logbrewLevelFromConsoleMethod: typeof logbrewLevelFromConsoleMethod;
  logbrewTraceContextFromCurrentOpenTelemetrySpan: typeof logbrewTraceContextFromCurrentOpenTelemetrySpan;
  logbrewTraceContextFromOpenTelemetrySpan: typeof logbrewTraceContextFromOpenTelemetrySpan;
  logbrewTraceContextFromOpenTelemetrySpanContext: typeof logbrewTraceContextFromOpenTelemetrySpanContext;
  parseBaggage: typeof parseBaggage;
  parseTraceparent: typeof parseTraceparent;
  parseTracestate: typeof parseTracestate;
  RecordingTransport: typeof RecordingTransport;
  SdkError: typeof SdkError;
  spanAttributesFromOpenTelemetryReadableSpan: typeof spanAttributesFromOpenTelemetryReadableSpan;
  spanAttributesFromTraceparent: typeof spanAttributesFromTraceparent;
  TransportError: typeof TransportError;
};

export type {
  ActionAttributes,
  BaggageEntry,
  ConsoleCaptureConfig,
  ConsoleCaptureHandle,
  ConsoleLike,
  ConsoleMethodName,
  CurrentOpenTelemetryTraceContextOptions,
  DeliveryHealthSnapshot,
  DroppedEvent,
  EnvironmentAttributes,
  Event,
  EventFilter,
  EventStore,
  IssueAdmission,
  IssueAttributes,
  IssueStackFrame,
  JavaScriptErrorIssueOptions,
  LogAttributes,
  LogCorrelationTraceContext,
  Metadata,
  MetadataValue,
  MetricAttributes,
  NetworkMilestoneInput,
  OpenTelemetryApiLike,
  OpenTelemetryExportResult,
  OpenTelemetryHrTimeLike,
  OpenTelemetryReadableSpanLike,
  OpenTelemetryReadableSpanOptions,
  OpenTelemetrySpanContextLike,
  OpenTelemetrySpanExporterConfig,
  OpenTelemetrySpanExporterHandle,
  OpenTelemetrySpanLike,
  OpenTelemetrySpanLinkLike,
  OpenTelemetrySpanProcessorConfig,
  OpenTelemetrySpanProcessorHandle,
  OpenTelemetryTimedEventLike,
  OpenTelemetryTraceContextOptions,
  PinoDestinationConfig,
  PinoDestinationHandle,
  PinoLogRecord,
  ProductAnalyticsKind,
  ProductActionInput,
  ReleaseAttributes,
  Severity,
  SeverityAlias,
  SeverityInput,
  SpanAttributes,
  SpanEventSummary,
  SpanLinkSummary,
  StoredEvent,
  SupportDiagnosticsValue,
  SupportTicketCategory,
  SupportTicketDraft,
  SupportTicketDraftInput,
  SupportTicketSource,
  TimelineAttributesOptions,
  TraceContextInput,
  TraceparentContext,
  TraceparentInput,
  TraceparentSpanInput,
  TracestateEntry,
  Transport,
  TransportResponse
} from "./index.js";

export {
  PRODUCT_ANALYTICS_KINDS,
  PRODUCT_ANALYTICS_SCHEMA_VERSION,
  createBaggage,
  createIssueAttributesFromError,
  createLogBrewOpenTelemetrySpanExporter,
  createLogBrewOpenTelemetrySpanProcessor,
  createLogBrewPinoDestination,
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createSupportTicketDraft,
  createTraceContextHeaders,
  createTraceparent,
  createTraceparentHeaders,
  createTracestate,
  installBrowserBreadcrumbs,
  installLogBrewConsoleCapture,
  LogBrewClient,
  logAttributesFromConsoleArgs,
  logAttributesFromPinoRecord,
  logbrewLevelFromConsoleMethod,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  parseBaggage,
  parseTraceparent,
  parseTracestate,
  RecordingTransport,
  SdkError,
  spanAttributesFromOpenTelemetryReadableSpan,
  spanAttributesFromTraceparent,
  TransportError
} from "./index.js";

export default sdk;
