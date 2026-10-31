import type { Metadata, SpanAttributes, SpanEventSummary, SpanLinkSummary } from "./telemetry.js";

/** Parsed W3C trace context from a traceparent value. */
type TraceparentContext = {
  version: string;
  traceId: string;
  parentSpanId: string;
  traceFlags: string;
  sampled: boolean;
};

/** Minimal active trace shape accepted by logger adapters for correlation metadata. */
type LogCorrelationTraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled?: boolean;
};

/** Inputs for creating a W3C traceparent value from known trace/span ids. */
type TraceparentInput = {
  traceId: string;
  spanId: string;
  traceFlags?: string;
};

/** Privacy-bounded W3C tracestate entry for explicit propagation. */
type TracestateEntry = {
  key: string;
  value: string;
};

/** W3C baggage entry for explicit propagation. */
type BaggageEntry = {
  key: string;
  value: string;
  properties?: string[];
};

/** Inputs for creating an explicit W3C trace context header carrier. */
type TraceContextInput = TraceparentInput & {
  tracestate?: string | TracestateEntry[];
  baggage?: string | BaggageEntry[];
};

/** Span fields supplied when deriving LogBrew span attributes from traceparent. */
type TraceparentSpanInput = {
  name: string;
  spanId: string;
  status: "ok" | "error";
  durationMs?: number;
  links?: SpanLinkSummary[];
  metadata?: Metadata;
  events?: SpanEventSummary[];
};

/** Parse a W3C traceparent value into normalized trace/span context. */
declare function parseTraceparent(traceparent: string): TraceparentContext;

/** Create a W3C traceparent value from explicit trace/span ids. */
declare function createTraceparent(input: TraceparentInput): string;

/** Create an explicit outbound header carrier containing only traceparent. */
declare function createTraceparentHeaders(input: TraceparentInput): { traceparent: string };

/** Parse a W3C tracestate header into normalized entries. */
declare function parseTracestate(tracestate: string): TracestateEntry[];

/** Create a normalized W3C tracestate header from explicit entries. */
declare function createTracestate(entries: TracestateEntry[]): string;

/** Parse a W3C baggage header into decoded entries. */
declare function parseBaggage(baggage: string): BaggageEntry[];

/** Create a W3C baggage header from explicit entries. */
declare function createBaggage(entries: BaggageEntry[]): string;

/** Create an explicit outbound carrier for traceparent plus optional tracestate and baggage. */
declare function createTraceContextHeaders(input: TraceContextInput): {
  traceparent: string;
  tracestate?: string;
  baggage?: string;
};

/** Build LogBrew span attributes that continue an incoming W3C traceparent value. */
declare function spanAttributesFromTraceparent(
  traceparent: string,
  attributes: TraceparentSpanInput
): SpanAttributes;

export type {
  BaggageEntry,
  LogCorrelationTraceContext,
  TraceContextInput,
  TraceparentContext,
  TraceparentInput,
  TraceparentSpanInput,
  TracestateEntry
};
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
};
