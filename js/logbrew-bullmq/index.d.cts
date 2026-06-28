import type { BulkJobOptions, Job, JobsOptions, Queue } from "bullmq";
import type { LogBrewClient, SpanEventSummary, SpanLinkSummary } from "@logbrew/sdk";
import type { LogBrewTraceContext } from "@logbrew/node";

export type LogBrewBullMqJobOptions = JobsOptions & {
  telemetry?: {
    metadata?: string;
    [key: string]: unknown;
  };
};

export type LogBrewBullMqBulkJobOptions = BulkJobOptions & {
  telemetry?: {
    metadata?: string;
    [key: string]: unknown;
  };
};

export type LogBrewBullMqQueueLike<Data = unknown, Result = unknown, Name extends string = string> =
  Pick<Queue<Data, Result, Name>, "add" | "name">;

export type LogBrewBullMqInstrumentableQueueLike<Data = unknown, Result = unknown, Name extends string = string> =
  Pick<Queue<Data, Result, Name>, "add" | "name"> &
  Partial<Pick<Queue<Data, Result, Name>, "addBulk">>;

export type LogBrewBullMqBulkQueueLike<Data = unknown, Result = unknown, Name extends string = string> =
  Pick<Queue<Data, Result, Name>, "addBulk" | "name">;

export type LogBrewBullMqBulkJob<Data = unknown, Name extends string = string> = {
  name: Name;
  data: Data;
  opts?: LogBrewBullMqBulkJobOptions;
};

export type LogBrewBullMqSpanOptions = {
  client: LogBrewClient;
  queueName?: string;
  traceparent?: string;
  trace?: LogBrewTraceContext;
  id?: string;
  events?: SpanEventSummary[];
  links?: SpanLinkSummary[];
  metadata?: Record<string, string | number | boolean | null>;
  now?: () => string;
  nowMs?: () => number;
  spanIdFactory?: () => string;
  traceIdFactory?: () => string;
  onCaptureError?: (
    error: unknown,
    context: {
      client: LogBrewClient;
      error?: unknown;
      trace: LogBrewTraceContext;
    }
  ) => void | Promise<void>;
};

export type LogBrewBullMqProcessor<Result = unknown, Data = unknown, Name extends string = string> = (
  job: Job<Data, Result, Name>,
  lock?: string,
  signal?: AbortSignal
) => Result | Promise<Result>;

export type LogBrewBullMqProcessorMethod = (...args: never[]) => unknown;

export type LogBrewBullMqProcessorMethodTarget<MethodName extends string = "process"> =
  Record<MethodName, LogBrewBullMqProcessorMethod>;

export type LogBrewBullMqInstrumentation = {
  isInstalled(): boolean;
  uninstall(): void;
};

export declare function bullMqQueueAddWithLogBrewSpan<
  Data = unknown,
  Result = unknown,
  Name extends string = string
>(
  queue: LogBrewBullMqQueueLike<Data, Result, Name>,
  name: Name,
  data: Data,
  jobOptions: LogBrewBullMqJobOptions | undefined,
  options: LogBrewBullMqSpanOptions
): Promise<Job<Data, Result, Name>>;

export declare function bullMqQueueAddBulkWithLogBrewSpan<
  Data = unknown,
  Result = unknown,
  Name extends string = string
>(
  queue: LogBrewBullMqBulkQueueLike<Data, Result, Name>,
  jobs: Array<LogBrewBullMqBulkJob<Data, Name>>,
  options: LogBrewBullMqSpanOptions
): Promise<Array<Job<Data, Result, Name>>>;

export declare function withLogBrewBullMqProcessor<
  Result = unknown,
  Data = unknown,
  Name extends string = string
>(
  processor: LogBrewBullMqProcessor<Result, Data, Name>,
  options: LogBrewBullMqSpanOptions
): LogBrewBullMqProcessor<Awaited<Result>, Data, Name>;

export declare function instrumentLogBrewBullMqProcessor<
  Target extends LogBrewBullMqProcessorMethodTarget<"process">
>(
  target: Target,
  options: LogBrewBullMqSpanOptions
): LogBrewBullMqInstrumentation;

export declare function instrumentLogBrewBullMqProcessor<
  MethodName extends string,
  Target extends LogBrewBullMqProcessorMethodTarget<MethodName>
>(
  target: Target,
  methodName: MethodName,
  options: LogBrewBullMqSpanOptions
): LogBrewBullMqInstrumentation;

export declare function instrumentLogBrewBullMqQueue<
  Data = unknown,
  Result = unknown,
  Name extends string = string
>(
  queue: LogBrewBullMqInstrumentableQueueLike<Data, Result, Name>,
  options: LogBrewBullMqSpanOptions
): LogBrewBullMqInstrumentation;

export declare function createLogBrewBullMqJobOptions(
  jobOptions?: LogBrewBullMqJobOptions,
  traceparent?: string
): LogBrewBullMqJobOptions;

export declare function extractLogBrewBullMqTraceparent(job: {
  opts?: LogBrewBullMqJobOptions;
}): string | undefined;

declare const defaultExport: {
  bullMqQueueAddBulkWithLogBrewSpan: typeof bullMqQueueAddBulkWithLogBrewSpan;
  bullMqQueueAddWithLogBrewSpan: typeof bullMqQueueAddWithLogBrewSpan;
  createLogBrewBullMqJobOptions: typeof createLogBrewBullMqJobOptions;
  extractLogBrewBullMqTraceparent: typeof extractLogBrewBullMqTraceparent;
  instrumentLogBrewBullMqProcessor: typeof instrumentLogBrewBullMqProcessor;
  instrumentLogBrewBullMqQueue: typeof instrumentLogBrewBullMqQueue;
  withLogBrewBullMqProcessor: typeof withLogBrewBullMqProcessor;
};

export default defaultExport;
