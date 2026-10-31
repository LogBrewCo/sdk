const { compactMetadata, isMetadataValue } = require("./log-context.cjs");
const { defaultSpanIdFactory } = require("./opentelemetry-context.cjs");
const { safeOpenTelemetryExceptionType } = require("./opentelemetry-exceptions.cjs");
const { TRACE_SUMMARY_METADATA_KEYS } = require("./opentelemetry-keys.cjs");
const {
  endMsFromOpenTelemetryReadableSpan,
  fallbackTimestampValue,
  openTelemetryTimeMs,
  timestampFromOpenTelemetryTime
} = require("./opentelemetry-time.cjs");
const { isTruthy } = require("./validation.cjs");

/**
 * @import { Metadata, MetadataValue, SpanAttributes } from "./index.cjs"
 * @import { DeepReadonly } from "./validation.cjs"
 * @typedef {DeepReadonly<SpanAttributes>} ReadonlySpanAttributes
 */

const NONE = 0;

/**
 * @param {Readonly<Metadata> | undefined} metadata
 * @param {string} key
 * @returns {number}
 */
function positiveSafeInteger(metadata, key) {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > NONE ? value : NONE;
}

class OpenTelemetryTraceSummary {
  spanCount = NONE;
  errorSpanCount = NONE;
  /** @type {Metadata} */
  metadata = {};
  rootSeen = false;
  /** @type {number | undefined} */
  firstStartMs = undefined;
  /** @type {number | undefined} */
  lastEndMs = undefined;
  /** @type {string | undefined} */
  rootSpanId = undefined;
  /** @type {string | undefined} */
  rootName = undefined;
  /** @type {MetadataValue | undefined} */
  rootKind = undefined;
  /** @type {number | undefined} */
  rootStartMs = undefined;
  /** @type {number | undefined} */
  rootDurationMs = undefined;
  exceptionEventCount = NONE;
  exceptionEscapedCount = NONE;
  /** @type {Set<string>} */
  exceptionTypes = new Set();

  /**
   * @param {string} traceId
   */
  constructor(traceId) {
    this.traceId = traceId;
  }

  /**
   * @param {ReadonlySpanAttributes} attributes
   * @param {Readonly<Record<string, unknown>>} span
   * @returns {void}
   */
  record(attributes, span) {
    this.spanCount += 1;
    if (attributes.status === "error") {
      this.errorSpanCount += 1;
    }
    this.recordExceptions(attributes.metadata);
    const startMs = openTelemetryTimeMs(span["startTime"]);
    this.recordWindow(startMs, endMsFromOpenTelemetryReadableSpan(span, startMs, attributes.durationMs));
    this.copyMetadata(attributes.metadata, false);
    const isRootSpan = attributes.parentSpanId === undefined;
    if (isRootSpan || this.rootSpanId === undefined) {
      this.recordRoot(attributes, isRootSpan, startMs);
    }
  }

  /**
   * @param {number | undefined} startMs
   * @param {number | undefined} endMs
   * @returns {void}
   */
  recordWindow(startMs, endMs) {
    if (startMs !== undefined && (this.firstStartMs === undefined || startMs < this.firstStartMs)) {
      this.firstStartMs = startMs;
    }
    if (endMs !== undefined && (this.lastEndMs === undefined || endMs > this.lastEndMs)) {
      this.lastEndMs = endMs;
    }
  }

  /**
   * @param {ReadonlySpanAttributes} attributes
   * @param {boolean} isRootSpan
   * @param {number | undefined} startMs
   * @returns {void}
   */
  recordRoot(attributes, isRootSpan, startMs) {
    this.rootSpanId = attributes.spanId;
    this.rootName = attributes.name;
    this.rootKind = attributes.metadata?.["otel.kind"];
    this.rootSeen = isRootSpan;
    if (startMs !== undefined) {
      this.rootStartMs = startMs;
    }
    if (attributes.durationMs !== undefined) {
      this.rootDurationMs = attributes.durationMs;
    }
    this.copyMetadata(attributes.metadata, true);
  }

  /**
   * @param {Readonly<Metadata> | undefined} metadata
   * @returns {void}
   */
  recordExceptions(metadata) {
    this.exceptionEventCount += positiveSafeInteger(metadata, "otel.exception_event_count");
    this.exceptionEscapedCount += positiveSafeInteger(metadata, "otel.exception_escaped_count");
    const types = metadata?.["otel.exception_types"];
    if (typeof types === "string" && types.trim() !== "") {
      for (const type of types.split(",")) {
        const safeType = safeOpenTelemetryExceptionType(type);
        if (safeType !== undefined) {
          this.exceptionTypes.add(safeType);
        }
      }
    }
  }

  /**
   * @param {Readonly<Metadata> | undefined} metadata
   * @param {boolean} overwrite
   * @returns {void}
   */
  copyMetadata(metadata, overwrite) {
    if (metadata === undefined) {
      return;
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (
        TRACE_SUMMARY_METADATA_KEYS.has(key)
        && (overwrite || this.metadata[key] === undefined)
        && isMetadataValue(value)
      ) {
        this.metadata[key] = value;
      }
    }
  }

  /**
   * @returns {number | undefined}
   */
  durationMs() {
    if (this.firstStartMs !== undefined && this.lastEndMs !== undefined && this.lastEndMs >= this.firstStartMs) {
      return this.lastEndMs - this.firstStartMs;
    }
    return this.rootDurationMs;
  }

  /**
   * @param {(() => unknown) | undefined} fallbackTimestamp
   * @returns {unknown}
   */
  timestamp(fallbackTimestamp) {
    return timestampFromOpenTelemetryTime(this.rootStartMs)
      ?? timestampFromOpenTelemetryTime(this.firstStartMs)
      ?? fallbackTimestampValue(fallbackTimestamp);
  }

  /**
   * @returns {Metadata}
   */
  summaryMetadata() {
    return compactMetadata({
      source: "opentelemetry.trace_summary",
      ...this.metadata,
      "otel.trace.span_count": this.spanCount,
      ...(this.errorSpanCount > NONE ? { "otel.trace.error_span_count": this.errorSpanCount } : {}),
      ...(this.exceptionEventCount > NONE ? { "otel.trace.exception_event_count": this.exceptionEventCount } : {}),
      ...(this.exceptionEscapedCount > NONE ? { "otel.trace.exception_escaped_count": this.exceptionEscapedCount } : {}),
      ...(this.exceptionTypes.size > NONE ? { "otel.trace.exception_types": [...this.exceptionTypes].join(",") } : {}),
      ...(isTruthy(this.rootSpanId) ? { "otel.trace.root_span_id": this.rootSpanId } : {}),
      ...(isTruthy(this.rootName) ? { "otel.trace.root_name": this.rootName } : {}),
      ...(isTruthy(this.rootKind) ? { "otel.trace.root_kind": this.rootKind } : {}),
      "otel.trace.summary_kind": this.rootSeen ? "rooted" : "flush_batch"
    });
  }

  /**
   * @returns {SpanAttributes}
   */
  attributes() {
    const metadata = this.summaryMetadata();
    const durationMs = this.durationMs();
    return {
      name: isTruthy(this.rootName) ? `opentelemetry.trace:${String(this.rootName)}` : "opentelemetry.trace",

      traceId: this.traceId,

      spanId: defaultSpanIdFactory(),
      status: this.errorSpanCount > NONE ? "error" : "ok",
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(Object.keys(metadata).length > NONE ? { metadata } : {})
    };
  }
}

module.exports = { OpenTelemetryTraceSummary };
