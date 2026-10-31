import type { Metadata, SpanAttributes } from "./telemetry.js";
import type { LogBrewClient } from "./client.js";
import type { LogCorrelationTraceContext } from "./trace-context.js";
import type { Transport } from "./delivery.js";

/** Minimal OpenTelemetry SpanContext-like shape copied by dependency-free bridge helpers. */
type OpenTelemetrySpanContextLike = {
  traceId?: unknown;
  spanId?: unknown;
  traceFlags?: unknown;
  isValid?: boolean;
};

/** Minimal OpenTelemetry Span-like shape accepted by dependency-free bridge helpers. */
type OpenTelemetrySpanLike = {
  spanContext?: () => OpenTelemetrySpanContextLike | null | undefined;
  getSpanContext?: () => OpenTelemetrySpanContextLike | null | undefined;
};

/** Minimal OpenTelemetry API-like shape used for the current active span helper. */
type OpenTelemetryApiLike = {
  trace?: {
    getActiveSpan?: () => OpenTelemetrySpanLike | null | undefined;
  };
};

/** OpenTelemetry high-resolution time tuple accepted by dependency-free ReadableSpan helpers. */
type OpenTelemetryHrTimeLike = readonly [number, number];

/** Minimal OpenTelemetry event-like shape summarized from ended spans. */
type OpenTelemetryTimedEventLike = {
  name?: unknown;
  time?: OpenTelemetryHrTimeLike | number | Date;
  timestamp?: OpenTelemetryHrTimeLike | number | Date;
  attributes?: Record<string, unknown>;
};

/** Minimal OpenTelemetry link-like shape summarized from ended spans. */
type OpenTelemetrySpanLinkLike = {
  context?: OpenTelemetrySpanContextLike | null | undefined;
  spanContext?: OpenTelemetrySpanContextLike | null | undefined;
  attributes?: Record<string, unknown>;
};

/** Minimal OpenTelemetry ReadableSpan-like shape accepted by dependency-free bridge helpers. */
type OpenTelemetryReadableSpanLike = {
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
type OpenTelemetryTraceContextOptions = {
  spanId?: string;
  spanIdFactory?: () => string;
};

/** Options for reading OpenTelemetry's current active span without requiring an OTel dependency. */
type CurrentOpenTelemetryTraceContextOptions = OpenTelemetryTraceContextOptions & {
  openTelemetryApi?: OpenTelemetryApiLike;
};

/** Options for privacy-bounded OpenTelemetry ReadableSpan conversion. */
type OpenTelemetryReadableSpanOptions = {
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
type OpenTelemetrySpanProcessorConfig = OpenTelemetryReadableSpanOptions & {
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
type OpenTelemetrySpanExporterConfig = OpenTelemetryReadableSpanOptions & {
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
type OpenTelemetryExportResult = {
  code: number;
  error?: Error;
};

/** SpanExporter-compatible handle for app-owned OpenTelemetry processors. */
type OpenTelemetrySpanExporterHandle = {
  export(
    spans: readonly unknown[],
    resultCallback: (result: OpenTelemetryExportResult) => void
  ): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

/** SpanProcessor-compatible handle for app-owned OpenTelemetry setup. */
type OpenTelemetrySpanProcessorHandle = {
  onStart(span: unknown, parentContext: unknown): void;
  onEnd(span: unknown): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

/** Create a LogBrew child trace from a live OpenTelemetry SpanContext-like object. */
declare function logbrewTraceContextFromOpenTelemetrySpanContext(
  spanContext: OpenTelemetrySpanContextLike | null | undefined,
  options?: OpenTelemetryTraceContextOptions
): LogCorrelationTraceContext | null;

/** Create a LogBrew child trace from a live OpenTelemetry Span-like object. */
declare function logbrewTraceContextFromOpenTelemetrySpan(
  span: OpenTelemetrySpanLike | null | undefined,
  options?: OpenTelemetryTraceContextOptions
): LogCorrelationTraceContext | null;

/** Create a LogBrew child trace from OpenTelemetry's current active span, when available. */
declare function logbrewTraceContextFromCurrentOpenTelemetrySpan(
  options?: CurrentOpenTelemetryTraceContextOptions
): LogCorrelationTraceContext | null;

/** Convert an ended OpenTelemetry ReadableSpan-like object into safe LogBrew span attributes. */
declare function spanAttributesFromOpenTelemetryReadableSpan(
  span: OpenTelemetryReadableSpanLike | null | undefined,
  options?: OpenTelemetryReadableSpanOptions
): SpanAttributes | null;

/** Create an opt-in SpanProcessor-compatible bridge for app-owned OpenTelemetry providers. */
declare function createLogBrewOpenTelemetrySpanProcessor(
  config: OpenTelemetrySpanProcessorConfig
): OpenTelemetrySpanProcessorHandle;

/** Create an opt-in SpanExporter-compatible bridge for app-owned OpenTelemetry processors. */
declare function createLogBrewOpenTelemetrySpanExporter(
  config: OpenTelemetrySpanExporterConfig
): OpenTelemetrySpanExporterHandle;

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
};
export {
  createLogBrewOpenTelemetrySpanExporter,
  createLogBrewOpenTelemetrySpanProcessor,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  spanAttributesFromOpenTelemetryReadableSpan
};
