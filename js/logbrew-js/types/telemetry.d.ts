declare const TELEMETRY_CONTEXT_SCHEMA_VERSION = 1;

/** Metadata values that can be attached to public LogBrew event payloads. */
type MetadataValue = string | number | boolean | null;

/** Structured metadata map shared by public LogBrew event attribute types. */
type Metadata = Record<string, MetadataValue>;

/** Bounded service, runtime, or framework identity shared by telemetry signals. */
type TelemetryNamedVersion = {
  name: string;
  version?: string;
};

/** Privacy-bounded resource identity shared by telemetry signals. */
type TelemetryResource = {
  service?: TelemetryNamedVersion;
  deployment?: { environment?: string; release?: string };
  runtime?: TelemetryNamedVersion;
  framework?: TelemetryNamedVersion;
  operatingSystem?: TelemetryNamedVersion & { build?: string };
  device?: { family?: string; model?: string; architecture?: string };
  application?: { name?: string; version?: string; build?: string };
};

/** W3C-compatible correlation identity shared by non-span telemetry. */
type TelemetryTraceContext = {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  sampled?: boolean;
};

/** Opaque application session identity. */
type TelemetrySessionContext = {
  id: string;
  previousId?: string;
};

/** Explicit app-owned subject identity; do not send names, email addresses, or IP addresses. */
type TelemetrySubjectContext = {
  id: string;
  kind: "anonymous" | "user";
};

/** Versioned shared context available on every LogBrew event type. */
type TelemetryContext = {
  schemaVersion: typeof TELEMETRY_CONTEXT_SCHEMA_VERSION;
  resource?: TelemetryResource;
  trace?: TelemetryTraceContext;
  session?: TelemetrySessionContext;
  subject?: TelemetrySubjectContext;
  /** Up to 32 low-cardinality string dimensions with safe machine keys. */
  tags?: Record<string, string>;
};

/** Canonical user-facing severity categories accepted by LogBrew. */
type Severity = "info" | "warning" | "error" | "critical";

/** Runtime-level aliases accepted for compatibility and normalized before send. */
type SeverityAlias = "trace" | "debug" | "warn" | "fatal";

/** Public severity input accepted by issue and log attributes. */
type SeverityInput = Severity | SeverityAlias;

/** Public release event attributes. */
type ReleaseAttributes = {
  version: string;
  commit?: string;
  notes?: string;
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Public environment event attributes. */
type EnvironmentAttributes = {
  name: string;
  region?: string;
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Public log event attributes. */
type LogAttributes = {
  message: string;
  level: SeverityInput;
  logger?: string;
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Privacy-bounded milestone recorded inside a span. */
type SpanEventSummary = {
  name: string;
  timestamp?: string;
  metadata?: Metadata;
};

/** Privacy-bounded reference from this span to another trace/span. */
type SpanLinkSummary = {
  traceId: string;
  spanId: string;
  sampled?: boolean;
  metadata?: Metadata;
};

/** Public span event attributes. */
type SpanAttributes = {
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
type ActionAttributes = {
  name: string;
  status: "queued" | "running" | "success" | "failure";
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Public metric event attributes. Use low-cardinality metadata only. */
type MetricAttributes = {
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
};
