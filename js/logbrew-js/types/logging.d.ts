import type { LogAttributes, Metadata } from "./telemetry.js";
import type { Transport, TransportResponse } from "./delivery.js";
import type { LogBrewClient } from "./client.js";
import type { LogCorrelationTraceContext } from "./trace-context.js";

/** Console method names supported by the opt-in console capture helper. */
type ConsoleMethodName = "debug" | "info" | "log" | "warn" | "error";

/** Minimal console-like target accepted by the opt-in console capture helper. */
type ConsoleLike = Partial<Record<ConsoleMethodName, (...args: unknown[]) => void>>;

/** Configuration for opt-in console capture. */
type ConsoleCaptureConfig = {
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
type ConsoleCaptureHandle = {
  flush(): Promise<TransportResponse | null>;
  uninstall(): void;
};

/** Pino JSON log record shape accepted by the optional Pino destination helper. */
type PinoLogRecord = Record<string, unknown> & {
  level?: string | number;
  time?: string | number;
  timestamp?: string | number;
  msg?: unknown;
  message?: unknown;
  err?: unknown;
  error?: unknown;
};

/** Configuration for the dependency-free Pino destination adapter. */
type PinoDestinationConfig = {
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
type PinoDestinationHandle = {
  write(chunk: unknown): boolean;
  flush(): Promise<TransportResponse | null>;
  end(): Promise<TransportResponse | null>;
};

/** Winston info object shape accepted by the optional Winston transport helper. */
type WinstonLogInfo = Record<string, unknown> & {
  level?: string;
  message?: unknown;
  timestamp?: string | number | Date;
  time?: string | number | Date;
  err?: unknown;
  error?: unknown;
  stack?: unknown;
};

/** Configuration for the dependency-free Winston transport adapter. */
type WinstonTransportConfig = {
  client: LogBrewClient;
  /** Record each Winston message as an issue breadcrumb (category `log.winston`). Defaults to true. */
  breadcrumbs?: boolean;
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
type WinstonTransportHandle = {
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

/** Install explicit console capture while preserving the target console's normal output behavior. */
declare function installLogBrewConsoleCapture(config: ConsoleCaptureConfig): ConsoleCaptureHandle;

/** Convert console arguments into safe LogBrew log attributes without installing capture. */
declare function logAttributesFromConsoleArgs(
  method: ConsoleMethodName,
  args: readonly unknown[],
  options?: {
    logger?: string;
    metadata?: Metadata;
    includeErrorStack?: boolean;
  }
): LogAttributes;

/** Map a console method name to the corresponding LogBrew log level. */
declare function logbrewLevelFromConsoleMethod(method: ConsoleMethodName): LogAttributes["level"];

/** Create a dependency-free Pino destination that turns JSON log lines into queued LogBrew log events. */
declare function createLogBrewPinoDestination(config: PinoDestinationConfig): PinoDestinationHandle;

/** Convert a parsed Pino JSON log record into safe LogBrew log attributes without installing a destination. */
declare function logAttributesFromPinoRecord(
  record: PinoLogRecord,
  options?: {
    logger?: string;
    metadata?: Metadata;
    trace?: LogCorrelationTraceContext | null;
    includeErrorStack?: boolean;
  }
): LogAttributes;

/** Create a dependency-free Winston object-mode transport that queues LogBrew log events. */
declare function createLogBrewWinstonTransport(config: WinstonTransportConfig): WinstonTransportHandle;

/** Convert a Winston info object into safe LogBrew log attributes without installing a transport. */
declare function logAttributesFromWinstonInfo(
  info: WinstonLogInfo,
  options?: {
    logger?: string;
    metadata?: Metadata;
    trace?: LogCorrelationTraceContext | null;
    includeErrorStack?: boolean;
  }
): LogAttributes;

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
};
export {
  createLogBrewPinoDestination,
  createLogBrewWinstonTransport,
  installLogBrewConsoleCapture,
  logAttributesFromConsoleArgs,
  logAttributesFromPinoRecord,
  logAttributesFromWinstonInfo,
  logbrewLevelFromConsoleMethod
};
