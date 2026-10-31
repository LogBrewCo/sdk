import type {
  LogBrewClient,
  Metadata,
  PinoLogRecord,
  SpanLinkSummary,
  Transport,
  TransportResponse
} from "@logbrew/sdk";
import type { LogBrewOperationSpanOptions } from "./data-types.js";
import type { LogBrewSpanMetadata } from "./span-types.js";
import type { LogBrewTraceContext } from "./index.js";

type LogBrewQueueTraceHeaders = {
  traceparent?: string;
};

type LogBrewQueueTraceCarrier = string | {
  traceparent?: unknown;
  traceParent?: unknown;
  get?: (name: string) => unknown;
};

type LogBrewQueueBatchMessage = LogBrewQueueTraceCarrier | {
  headers?: LogBrewQueueTraceCarrier;
  [key: string]: unknown;
};

type LogBrewQueueTraceCarriers = LogBrewQueueTraceCarrier | readonly (LogBrewQueueTraceCarrier | undefined)[];

type QueueOperationWithLogBrewSpanOptions<Result = unknown> = LogBrewOperationSpanOptions<Result> & {
  queueName?: string;
  taskName?: string;
  messageCount?: number;
  traceparent?: string;
};

type QueueBatchOperationWithLogBrewSpanOptions<Result = unknown> = QueueOperationWithLogBrewSpanOptions<Result> & {
  messages?: LogBrewQueueBatchMessage[];
  linkMetadata?: LogBrewSpanMetadata;
};

type LogBrewPinoCaptureContext = {
  readonly instance: unknown;
  readonly level?: number;
};

type LogBrewPinoInstrumentationConfig = {
  client: LogBrewClient;
  /** Optional explicit transport for flush(); createLogBrewNodeClient owns one by default. */
  transport?: Transport;
  logger?: string;
  metadata?: Metadata;
  /** Defaults to the active node:http trace; pass a framework trace provider when needed. */
  traceProvider?: () => LogBrewTraceContext | null | undefined;
  /** Error stacks remain excluded unless explicitly enabled. */
  includeErrorStack?: boolean;
  eventIdPrefix?: string;
  /** Fallback timestamp used only when the finalized Pino record has no valid timestamp. */
  timestamp?: () => string;
  /** Return false to skip one finalized record without changing Pino output. */
  shouldCapture?: (
    record: Readonly<PinoLogRecord>,
    context: LogBrewPinoCaptureContext
  ) => boolean;
  /** Advisory capture diagnostics; callback failures never interrupt application logging. */
  onError?: (error: unknown) => void | Promise<void>;
};

type LogBrewPinoInstrumentationHandle = {
  flush: () => Promise<TransportResponse | null>;
  uninstall: () => void;
};

/** Options for reporting process-level crashes. */
type LogBrewProcessErrorCaptureOptions = {
  /** Client that receives one unhandled issue per crash. */
  client: LogBrewClient;
  /** Transport used for the crash flush. Defaults to the client's own transport. */
  transport?: Transport;
  /** Longest wait for delivery before Node exits, from 0 to 30000. Defaults to 2000. */
  flushTimeoutMs?: number;
  /** Include raw stack text in issue metadata. Defaults to false. */
  includeErrorStack?: boolean;
  /** Receives capture or delivery failures. It never changes the exit path. */
  onCaptureError?: (error: unknown) => void;
};

type LogBrewProcessErrorCaptureHandle = {
  uninstall: () => void;
};

declare function createLogBrewQueueTraceHeaders(
  trace?: LogBrewTraceContext
): LogBrewQueueTraceHeaders;

declare function createLogBrewQueueTraceLinks(
  carriers?: LogBrewQueueTraceCarriers,
  metadata?: Readonly<LogBrewSpanMetadata>
): SpanLinkSummary[];

declare function queueOperationWithLogBrewSpan<Result>(
  operationName: string,
  options: QueueOperationWithLogBrewSpanOptions<Result>
): Promise<Awaited<Result>>;

declare function queueBatchOperationWithLogBrewSpan<Result>(
  operationName: string,
  options: QueueBatchOperationWithLogBrewSpanOptions<Result>
): Promise<Awaited<Result>>;

declare function installLogBrewPinoInstrumentation(
  options: LogBrewPinoInstrumentationConfig
): LogBrewPinoInstrumentationHandle;

/**
 * Report uncaught exceptions, unhandled promise rejections, and worker thread errors, then keep
 * Node's exit behavior: when no other handler exists, Node still exits with code 1 after a
 * bounded flush.
 */
declare function installLogBrewProcessErrorCapture(
  options: LogBrewProcessErrorCaptureOptions
): LogBrewProcessErrorCaptureHandle;

export type {
  LogBrewPinoCaptureContext,
  LogBrewPinoInstrumentationConfig,
  LogBrewPinoInstrumentationHandle,
  LogBrewProcessErrorCaptureHandle,
  LogBrewProcessErrorCaptureOptions,
  LogBrewQueueBatchMessage,
  LogBrewQueueTraceCarrier,
  LogBrewQueueTraceCarriers,
  LogBrewQueueTraceHeaders,
  QueueBatchOperationWithLogBrewSpanOptions,
  QueueOperationWithLogBrewSpanOptions
};
export {
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  installLogBrewPinoInstrumentation,
  installLogBrewProcessErrorCapture,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
};
