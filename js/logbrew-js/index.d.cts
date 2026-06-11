/** Metadata values that can be attached to public LogBrew event payloads. */
export type MetadataValue = string | number | boolean | null;
/** Structured metadata map shared by public LogBrew event attribute types. */
export type Metadata = Record<string, MetadataValue>;
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

/** Inputs for creating a W3C traceparent value from known trace/span ids. */
export type TraceparentInput = {
  traceId: string;
  spanId: string;
  traceFlags?: string;
};

/** Span fields supplied when deriving LogBrew span attributes from traceparent. */
export type TraceparentSpanInput = {
  name: string;
  spanId: string;
  status: "ok" | "error";
  durationMs?: number;
  metadata?: Metadata;
};

/** Public release event attributes. */
export type ReleaseAttributes = {
  version: string;
  commit?: string;
  notes?: string;
  metadata?: Metadata;
};

/** Public environment event attributes. */
export type EnvironmentAttributes = {
  name: string;
  region?: string;
  metadata?: Metadata;
};

/** Public issue event attributes. */
export type IssueAttributes = {
  title: string;
  level: SeverityInput;
  message?: string;
  metadata?: Metadata;
};

/** Public log event attributes. */
export type LogAttributes = {
  message: string;
  level: SeverityInput;
  logger?: string;
  metadata?: Metadata;
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

/** Public span event attributes. */
export type SpanAttributes = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status: "ok" | "error";
  durationMs?: number;
  metadata?: Metadata;
};

/** Public action event attributes. */
export type ActionAttributes = {
  name: string;
  status: "queued" | "running" | "success" | "failure";
  metadata?: Metadata;
};

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

/** Public metric event attributes. Use low-cardinality metadata only. */
export type MetricAttributes = {
  name: string;
  kind: "counter" | "histogram";
  value: number;
  unit: string;
  temporality: "delta" | "cumulative";
  metadata?: Metadata;
} | {
  name: string;
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

/** Stable transport response returned from flush and shutdown operations. */
export type TransportResponse = {
  /** Final HTTP-like status returned by the transport. */
  statusCode: number;
  /** Number of transport attempts used for the flush. */
  attempts: number;
};

/** Minimal transport interface accepted by flush and shutdown operations. */
export type Transport = {
  send(apiKey: string, body: string): TransportResponse | Promise<TransportResponse>;
};

/** Stable public SDK error with parseable code and message fields. */
export declare class SdkError extends Error {
  code: string;
  constructor(code: string, message: string);
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
  constructor(scriptedResponses?: Array<{ statusCode: number } | Error>);
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
    maxRetries?: number;
  }): LogBrewClient;
  /** Return the queued event count currently buffered in memory. */
  pendingEvents(): number;
  /** Return the queued event batch as stable, pretty-printed JSON. */
  previewJson(): string;
  release(id: string, timestamp: string, attributes: ReleaseAttributes): void;
  environment(id: string, timestamp: string, attributes: EnvironmentAttributes): void;
  issue(id: string, timestamp: string, attributes: IssueAttributes): void;
  log(id: string, timestamp: string, attributes: LogAttributes): void;
  span(id: string, timestamp: string, attributes: SpanAttributes): void;
  action(id: string, timestamp: string, attributes: ActionAttributes): void;
  metric(id: string, timestamp: string, attributes: MetricAttributes): void;
  /** Flush queued events through a transport while preserving retry semantics. */
  flush(transport: Transport): Promise<TransportResponse>;
  /** Flush queued events, then mark the client closed so later writes fail. */
  shutdown(transport: Transport): Promise<TransportResponse>;
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
    includeErrorStack?: boolean;
  }
): LogAttributes;
