const { callableOrUndefined, errorHandler, settledFlush } = require("./capture-support.cjs");
const { LogBrewClient } = require("./client.cjs");
const { NULL_VALUE } = require("./null-value.cjs");
const { resolveOpenTelemetryReadableSpanOptions } = require("./opentelemetry-keys.cjs");
const { readableSpanAttributes } = require("./opentelemetry-span.cjs");
const { OpenTelemetryTraceSummary } = require("./opentelemetry-summary.cjs");
const { timestampFromOpenTelemetryReadableSpan } = require("./opentelemetry-time.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isList, isRecord, isTruthy, requireNonEmpty } = require("./validation.cjs");

/**
 * @import { SpanAttributes } from "./index.cjs"
 * @import { DeepReadonly } from "./validation.cjs"
 * @typedef {InstanceType<typeof OpenTelemetryTraceSummary>} TraceSummary
 * @import { ErrorHandler } from "./capture-support.cjs"
 * @import { ResolvedSpanOptions } from "./opentelemetry-keys.cjs"
 * @typedef {Readonly<{
 *   span: (id: string, timestamp: unknown, attributes: unknown) => unknown,
 *   flush: (transport: unknown) => unknown,
 *   pendingEvents: () => number
 * }>} SpanClient
 * @typedef {Readonly<{
 *   client: SpanClient,
 *   eventIdPrefix: string,
 *   flushEnabled: boolean,
 *   includeTraceSummary: boolean,
 *   onError: ErrorHandler,
 *   resolvedOptions: ResolvedSpanOptions,
 *   spanFilter: ((span: unknown) => unknown) | undefined,
 *   timestamp: (() => unknown) | undefined,
 *   transport: unknown
 * }>} BridgeSettings
 */

const NO_PENDING_EVENTS = 0;
const NO_TRACE_SUMMARIES = 0;
const NO_SPANS = 0;
const OTEL_EXPORT_RESULT_SUCCESS = 0;
const OTEL_EXPORT_RESULT_FAILED = 1;

/**
 * @param {unknown} error
 * @returns {{ code: number, error?: Error }}
 */
function openTelemetryExportFailure(error) {
  return {
    code: OTEL_EXPORT_RESULT_FAILED,
    ...(error instanceof Error ? { error } : {})
  };
}

/**
 * @param {unknown} filter
 * @returns {((span: unknown) => unknown) | undefined}
 */
function spanFilterOrUndefined(filter) {
  if (typeof filter !== "function") {
    return undefined;
  }
  return (span) => {
    /** @type {unknown} */
    const keep = Reflect.apply(filter, undefined, [span]);
    return keep;
  };
}

/**
 * @param {Readonly<Record<string, unknown>>} config
 * @param {string} kind
 * @returns {SpanClient}
 */
function bridgeClient(config, kind) {
  const { client } = config;
  if (!(client instanceof LogBrewClient)) {
    throw new SdkError("validation_error", `OpenTelemetry span ${kind} client must be a LogBrewClient`);
  }
  return client;
}

/**
 * @param {Readonly<Record<string, unknown>>} config
 * @param {string} kind
 * @param {string} flushKey
 * @returns {BridgeSettings}
 */
function bridgeSettings(config, kind, flushKey) {
  const client = bridgeClient(config, kind);
  const eventIdPrefix = requireNonEmpty("OpenTelemetry eventIdPrefix", config["eventIdPrefix"] ?? "otel");
  const { transport } = config;
  const timestamp = callableOrUndefined(config["timestamp"]);
  const onError = errorHandler(config["onError"]);
  const spanFilter = spanFilterOrUndefined(config["spanFilter"]);
  const flushEnabled = config[flushKey] !== false;
  const includeTraceSummary = config["includeTraceSummary"] === true;
  const resolvedOptions = resolveOpenTelemetryReadableSpanOptions(config);
  return { client, eventIdPrefix, flushEnabled, includeTraceSummary, onError, resolvedOptions, spanFilter, timestamp, transport };
}

class OpenTelemetryBridge {
  captured = NO_SPANS;
  closed = false;
  flushInFlight = false;
  /** @type {Promise<unknown>} */
  pendingFlush = Promise.resolve(NULL_VALUE);
  currentFlush = this.pendingFlush;
  requestedFlush = this.pendingFlush;
  /** @type {Promise<unknown> | undefined} */
  queuedFlush = undefined;
  traceSummaryCount = NO_TRACE_SUMMARIES;
  /** @type {Map<string, TraceSummary>} */
  traceSummaries = new Map();

  /**
   * @param {BridgeSettings} settings
   * @param {boolean} swallowErrors
   */
  constructor(settings, swallowErrors) {
    this.settings = settings;
    this.swallowErrors = swallowErrors;
  }

  /**
   * @param {unknown} span
   * @returns {void}
   */
  enqueue(span) {
    const { settings } = this;
    if (settings.spanFilter?.(span) === false || !isRecord(span)) {
      return;
    }
    const attributes = readableSpanAttributes(span, settings.resolvedOptions);
    if (attributes === undefined) {
      return;
    }
    this.recordTraceSummary(attributes, span);
    this.captured += 1;
    settings.client.span(
      `${settings.eventIdPrefix}_${this.captured}`,
      timestampFromOpenTelemetryReadableSpan(span, settings.timestamp),
      attributes
    );
  }

  /**
   * @param {unknown} span
   * @returns {void}
   */
  end(span) {
    if (this.closed) {
      return;
    }
    try {
      this.enqueue(span);
    } catch (error) {
      this.settings.onError(error);
    }
  }

  /**
   * @param {DeepReadonly<SpanAttributes>} attributes
   * @param {Readonly<Record<string, unknown>>} span
   * @returns {void}
   */
  recordTraceSummary(attributes, span) {
    if (!this.settings.includeTraceSummary) {
      return;
    }
    let summary = this.traceSummaries.get(attributes.traceId);
    if (summary === undefined) {
      summary = new OpenTelemetryTraceSummary(attributes.traceId);
      this.traceSummaries.set(attributes.traceId, summary);
    }
    summary.record(attributes, span);
  }

  /**
   * @returns {void}
   */
  enqueueTraceSummaries() {
    if (this.traceSummaries.size === NO_TRACE_SUMMARIES) {
      return;
    }
    const { settings } = this;
    const summaries = [...this.traceSummaries.values()];
    this.traceSummaries.clear();
    for (const summary of summaries) {
      try {
        this.traceSummaryCount += 1;
        settings.client.span(
          `${settings.eventIdPrefix}_trace_${this.traceSummaryCount}`,
          summary.timestamp(settings.timestamp),
          summary.attributes()
        );
      } catch (error) {
        settings.onError(error);
      }
    }
  }

  /**
   * @param {boolean} flushEnabled
   * @returns {Promise<void>}
   */
  async flushQueue(flushEnabled) {
    const { settings } = this;
    if (settings.includeTraceSummary) {
      this.enqueueTraceSummaries();
    }
    if (!isTruthy(settings.transport) || !flushEnabled || settings.client.pendingEvents() === NO_PENDING_EVENTS) {
      await this.pendingFlush;
      return;
    }
    this.requestFlush();
    await this.requestedFlush;
  }

  /**
   * @returns {void}
   */
  requestFlush() {
    if (this.flushInFlight) {
      this.queuedFlush ??= this.flushAfter(this.currentFlush);
      this.requestedFlush = this.queuedFlush;
      return;
    }
    this.startFlush();
  }

  /**
   * @returns {void}
   */
  startFlush() {
    const { settings } = this;
    this.flushInFlight = true;
    const rawFlush = Promise.resolve(settings.client.flush(settings.transport));
    this.currentFlush = rawFlush;
    this.pendingFlush = this.swallowErrors ? settledFlush(rawFlush, settings.onError) : rawFlush;
    this.requestedFlush = this.pendingFlush;
    void this.settle(rawFlush);
  }

  /**
   * @param {unknown} rawFlush
   * @returns {Promise<void>}
   */
  async settle(rawFlush) {
    try {
      await rawFlush;
    } catch {
      this.finishFlush();
      return;
    }
    this.finishFlush();
  }

  /**
   * @returns {void}
   */
  finishFlush() {
    this.flushInFlight = false;
    this.queuedFlush = undefined;
  }

  /**
   * @param {unknown} inFlight
   * @returns {Promise<unknown>}
   */
  async flushAfter(inFlight) {
    try {
      await inFlight;
    } catch (error) {
      if (this.swallowErrors) {
        return NULL_VALUE;
      }
      throw error;
    }
    this.requestFlush();
    const result = await this.requestedFlush;
    return result;
  }

  /**
   * @param {unknown} spans
   * @returns {{ error: unknown } | undefined}
   */
  enqueueExport(spans) {
    if (this.closed) {
      return { error: new SdkError("shutdown_error", "OpenTelemetry span exporter is already shut down") };
    }
    if (!isList(spans)) {
      const error = new SdkError("validation_error", "OpenTelemetry span exporter spans must be an array");
      this.settings.onError(error);
      return { error };
    }
    return this.enqueueAll(spans);
  }

  /**
   * @param {readonly unknown[]} spans
   * @returns {{ error: unknown } | undefined}
   */
  enqueueAll(spans) {
    try {
      for (const span of spans) {
        this.enqueue(span);
      }
    } catch (error) {
      this.settings.onError(error);
      return { error };
    }
    return undefined;
  }

  /**
   * @param {(result: unknown) => void} report
   * @returns {Promise<void>}
   */
  async reportExport(report) {
    try {
      await this.flushQueue(this.settings.flushEnabled);
    } catch (error) {
      this.settings.onError(error);
      report(openTelemetryExportFailure(error));
      return;
    }
    report({ code: OTEL_EXPORT_RESULT_SUCCESS });
  }
}

module.exports = { OpenTelemetryBridge, bridgeSettings, openTelemetryExportFailure };
