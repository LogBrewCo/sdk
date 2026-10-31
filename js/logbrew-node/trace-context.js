import traceContextCore from "./trace-context.cjs";

export const {
  createLogBrewQueueBatchSpanOptions,
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  normalizeSpanId,
  normalizeTraceId,
  resolveOperationTrace
} = traceContextCore;
