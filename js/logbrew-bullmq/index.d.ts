import type { BulkJobOptions, FlowJob, FlowOpts, FlowProducer, Job, JobsOptions } from "bullmq";
import type { LogBrewClient, SpanEventSummary, SpanLinkSummary } from "@logbrew/sdk";
import type { LogBrewTraceContext } from "@logbrew/node";

type LogBrewBullMqJobOptions = JobsOptions & {
  telemetry?: {
    metadata?: string;
    [key: string]: unknown;
  };
};

type LogBrewBullMqBulkJobOptions = BulkJobOptions & {
  telemetry?: {
    metadata?: string;
    [key: string]: unknown;
  };
};

type LogBrewBullMqQueueLike<Data = unknown, Result = unknown, Name extends string = string> = {
  readonly name: string;
  readonly add: (name: Name, data: Data, opts?: LogBrewBullMqJobOptions) => Promise<Job<Data, Result, Name>>;
};

type LogBrewBullMqBulkQueueLike<Data = unknown, Result = unknown, Name extends string = string> = {
  readonly name: string;
  readonly addBulk: (jobs: never) => Promise<Job<Data, Result, Name>[]>;
};

type LogBrewBullMqInstrumentableQueueLike<Data = unknown, Result = unknown, Name extends string = string> =
  LogBrewBullMqQueueLike<Data, Result, Name> &
  Partial<Pick<LogBrewBullMqBulkQueueLike<Data, Result, Name>, "addBulk">>;

type LogBrewBullMqFlowProducerLike = Pick<FlowProducer, "add">;

type LogBrewBullMqBulkJob<Data = unknown, Name extends string = string> = {
  name: Name;
  data: Data;
  opts?: LogBrewBullMqBulkJobOptions;
};

type LogBrewBullMqSpanOptions = {
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
    context: Readonly<{
      client: LogBrewClient;
      error?: unknown;
      trace: LogBrewTraceContext;
    }>
  ) => void | Promise<void>;
};

type LogBrewBullMqProcessor<Result = unknown, Data = unknown, Name extends string = string> = (
  job: Job<Data, Result, Name>,
  lock?: string,
  signal?: AbortSignal
) => Result | Promise<Result>;

type LogBrewBullMqProcessorMethod = (...args: readonly never[]) => unknown;

type LogBrewBullMqProcessorMethodTarget<MethodName extends string = "process"> =
  Record<MethodName, LogBrewBullMqProcessorMethod>;

type LogBrewBullMqInstrumentation = {
  readonly isInstalled: () => boolean;
  readonly uninstall: () => void;
};

declare function bullMqQueueAddWithLogBrewSpan<
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

declare function bullMqQueueAddBulkWithLogBrewSpan<
  Data = unknown,
  Result = unknown,
  Name extends string = string
>(
  queue: LogBrewBullMqBulkQueueLike<Data, Result, Name>,
  jobs: readonly LogBrewBullMqBulkJob<NoInfer<Data>, NoInfer<Name>>[],
  options: LogBrewBullMqSpanOptions
): Promise<Job<Data, Result, Name>[]>;

declare function bullMqFlowProducerAddWithLogBrewSpan(
  flowProducer: LogBrewBullMqFlowProducerLike,
  flow: FlowJob,
  flowOptions: FlowOpts | undefined,
  options: LogBrewBullMqSpanOptions
): ReturnType<FlowProducer["add"]>;

declare function withLogBrewBullMqProcessor<
  Result = unknown,
  Data = unknown,
  Name extends string = string
>(
  processor: LogBrewBullMqProcessor<Result, Data, Name>,
  options: LogBrewBullMqSpanOptions
): (job: Job<Data, Result, Name>, lock?: string, signal?: AbortSignal) => Promise<Awaited<Result>>;

declare function instrumentLogBrewBullMqProcessor<
  Target extends LogBrewBullMqProcessorMethodTarget
>(
  target: Target,
  options: LogBrewBullMqSpanOptions
): LogBrewBullMqInstrumentation;

declare function instrumentLogBrewBullMqProcessor<
  MethodName extends string,
  Target extends LogBrewBullMqProcessorMethodTarget<MethodName>
>(
  target: Target,
  methodName: MethodName,
  options: LogBrewBullMqSpanOptions
): LogBrewBullMqInstrumentation;

declare function instrumentLogBrewBullMqFlowProducer(
  flowProducer: LogBrewBullMqFlowProducerLike,
  options: LogBrewBullMqSpanOptions
): LogBrewBullMqInstrumentation;

declare function instrumentLogBrewBullMqQueue<
  Data = unknown,
  Result = unknown,
  Name extends string = string
>(
  queue: LogBrewBullMqInstrumentableQueueLike<Data, Result, Name>,
  options: LogBrewBullMqSpanOptions
): LogBrewBullMqInstrumentation;

declare function createLogBrewBullMqFlowJob(
  flow: FlowJob,
  traceparent?: string
): FlowJob;

declare function createLogBrewBullMqJobOptions(
  jobOptions?: LogBrewBullMqJobOptions,
  traceparent?: string
): LogBrewBullMqJobOptions;

declare function extractLogBrewBullMqTraceparent(job: {
  readonly opts?: LogBrewBullMqJobOptions;
}): string | undefined;

declare const defaultExport: {
  bullMqFlowProducerAddWithLogBrewSpan: typeof bullMqFlowProducerAddWithLogBrewSpan;
  bullMqQueueAddBulkWithLogBrewSpan: typeof bullMqQueueAddBulkWithLogBrewSpan;
  bullMqQueueAddWithLogBrewSpan: typeof bullMqQueueAddWithLogBrewSpan;
  createLogBrewBullMqFlowJob: typeof createLogBrewBullMqFlowJob;
  createLogBrewBullMqJobOptions: typeof createLogBrewBullMqJobOptions;
  extractLogBrewBullMqTraceparent: typeof extractLogBrewBullMqTraceparent;
  instrumentLogBrewBullMqFlowProducer: typeof instrumentLogBrewBullMqFlowProducer;
  instrumentLogBrewBullMqProcessor: typeof instrumentLogBrewBullMqProcessor;
  instrumentLogBrewBullMqQueue: typeof instrumentLogBrewBullMqQueue;
  withLogBrewBullMqProcessor: typeof withLogBrewBullMqProcessor;
};

export type {
  LogBrewBullMqBulkJob,
  LogBrewBullMqBulkJobOptions,
  LogBrewBullMqBulkQueueLike,
  LogBrewBullMqFlowProducerLike,
  LogBrewBullMqInstrumentableQueueLike,
  LogBrewBullMqInstrumentation,
  LogBrewBullMqJobOptions,
  LogBrewBullMqProcessor,
  LogBrewBullMqProcessorMethod,
  LogBrewBullMqProcessorMethodTarget,
  LogBrewBullMqQueueLike,
  LogBrewBullMqSpanOptions
};
export {
  bullMqFlowProducerAddWithLogBrewSpan,
  bullMqQueueAddBulkWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  createLogBrewBullMqFlowJob,
  createLogBrewBullMqJobOptions,
  extractLogBrewBullMqTraceparent,
  instrumentLogBrewBullMqFlowProducer,
  instrumentLogBrewBullMqProcessor,
  instrumentLogBrewBullMqQueue,
  withLogBrewBullMqProcessor
};
export default defaultExport;
