import type { ProductAnalyticsKind } from "./types/product.js";

/** Current version of the reserved product-analytics metadata vocabulary. */
export declare const PRODUCT_ANALYTICS_SCHEMA_VERSION = 1;

/** Product-analytics categories understood by this SDK version. */
export declare const PRODUCT_ANALYTICS_KINDS: readonly ProductAnalyticsKind[];

export { LogBrewClient } from "./types/client.js";
export type {
  DeliveryHealthSnapshot,
  DroppedEvent,
  Event,
  EventFilter,
  EventStore,
  IssueAdmission,
  StoredEvent,
  Transport,
  TransportResponse
} from "./types/delivery.js";
export type {
  BrowserBreadcrumbOptions,
  IssueAttributes,
  IssueBreadcrumb,
  IssueBreadcrumbDataValue,
  IssueBreadcrumbInput,
  IssueBreadcrumbLevel,
  IssueBreadcrumbLevelInput,
  IssueDiagnosticEvidence,
  IssueException,
  IssueExceptionChain,
  IssueExceptionChainEntry,
  IssueExceptionMechanism,
  IssueExceptionMessageState,
  IssueExceptionRelationship,
  IssueExceptionStackFramesState,
  IssueImpactEvidence,
  IssueLikelyFixArea,
  IssueStackFrame,
  JavaScriptErrorIssueOptions,
  NativeStackArchitecture,
  NativeStackFrame
} from "./types/issues.js";
export { createIssueAttributesFromError, installBrowserBreadcrumbs } from "./types/issues.js";
export type {
  ConsoleCaptureConfig,
  ConsoleCaptureHandle,
  ConsoleLike,
  ConsoleMethodName,
  PinoDestinationConfig,
  PinoDestinationHandle,
  PinoLogRecord,
  WinstonLogInfo,
  WinstonTransportConfig,
  WinstonTransportHandle
} from "./types/logging.js";
export {
  createLogBrewPinoDestination,
  createLogBrewWinstonTransport,
  installLogBrewConsoleCapture,
  logAttributesFromConsoleArgs,
  logAttributesFromPinoRecord,
  logAttributesFromWinstonInfo,
  logbrewLevelFromConsoleMethod
} from "./types/logging.js";
export type {
  CurrentOpenTelemetryTraceContextOptions,
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
  OpenTelemetryTraceContextOptions
} from "./types/opentelemetry.js";
export {
  createLogBrewOpenTelemetrySpanExporter,
  createLogBrewOpenTelemetrySpanProcessor,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  spanAttributesFromOpenTelemetryReadableSpan
} from "./types/opentelemetry.js";
export type {
  NetworkMilestoneInput,
  ProductActionInput,
  ProductAnalyticsKind,
  SupportDiagnosticsValue,
  SupportTicketCategory,
  SupportTicketDraft,
  SupportTicketDraftInput,
  SupportTicketSource,
  TimelineAttributesOptions
} from "./types/product.js";
export {
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createSupportTicketDraft
} from "./types/product.js";
export { RecordingTransport } from "./types/recording-transport.js";
export { SdkError } from "./types/sdk-error.js";
export type {
  ActionAttributes,
  EnvironmentAttributes,
  LogAttributes,
  Metadata,
  MetadataValue,
  MetricAttributes,
  ReleaseAttributes,
  Severity,
  SeverityAlias,
  SeverityInput,
  SpanAttributes,
  SpanEventSummary,
  SpanLinkSummary,
  TelemetryContext,
  TelemetryNamedVersion,
  TelemetryResource,
  TelemetrySessionContext,
  TelemetrySubjectContext,
  TelemetryTraceContext
} from "./types/telemetry.js";
export type {
  BaggageEntry,
  LogCorrelationTraceContext,
  TraceContextInput,
  TraceparentContext,
  TraceparentInput,
  TraceparentSpanInput,
  TracestateEntry
} from "./types/trace-context.js";
export {
  createBaggage,
  createTraceContextHeaders,
  createTraceparent,
  createTraceparentHeaders,
  createTracestate,
  parseBaggage,
  parseTraceparent,
  parseTracestate,
  spanAttributesFromTraceparent
} from "./types/trace-context.js";
export { TransportError } from "./types/transport-error.js";
