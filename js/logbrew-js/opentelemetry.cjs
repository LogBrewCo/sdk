const { OpenTelemetryBridge, bridgeSettings, openTelemetryExportFailure } = require("./opentelemetry-bridge.cjs");
const {
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext
} = require("./opentelemetry-context.cjs");
const { spanAttributesFromOpenTelemetryReadableSpan } = require("./opentelemetry-span.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { isRecord } = require("./validation.cjs");

/**
 * @typedef {(result: unknown) => void} ExportReporter
 * @typedef {{
 *   onStart: () => void,
 *   onEnd: (span: unknown) => void,
 *   forceFlush: () => Promise<void>,
 *   shutdown: () => Promise<void>
 * }} SpanProcessorHandle
 * @typedef {{
 *   export: (spans: unknown, resultCallback: unknown) => void,
 *   forceFlush: () => Promise<void>,
 *   shutdown: () => Promise<void>
 * }} SpanExporterHandle
 */

/**
 * @param {unknown} resultCallback
 * @returns {ExportReporter}
 */
function exportReporter(resultCallback) {
  if (typeof resultCallback !== "function") {
    return () => undefined;
  }
  return (result) => {
    Reflect.apply(resultCallback, undefined, [result]);
  };
}

/**
 * @param {unknown} config
 * @param {string} kind
 * @returns {Readonly<Record<string, unknown>>}
 */
function requireBridgeConfig(config, kind) {
  if (!isRecord(config)) {
    throw new SdkError("validation_error", `OpenTelemetry span ${kind} config must be an object`);
  }
  return config;
}

/**
 * @param {unknown} config
 * @returns {SpanProcessorHandle}
 */
function createLogBrewOpenTelemetrySpanProcessor(config) {
  const settings = bridgeSettings(requireBridgeConfig(config, "processor"), "processor", "flushOnForceFlush");
  const bridge = new OpenTelemetryBridge(settings, true);
  return {
    onStart() {
      return undefined;
    },

    onEnd(span) {
      bridge.end(span);
    },

    async forceFlush() {
      await bridge.flushQueue(settings.flushEnabled);
    },
    async shutdown() {
      bridge.closed = true;
      await bridge.flushQueue(settings.flushEnabled);
    }
  };
}

/**
 * @param {unknown} config
 * @returns {SpanExporterHandle}
 */
function createLogBrewOpenTelemetrySpanExporter(config) {
  const settings = bridgeSettings(requireBridgeConfig(config, "exporter"), "exporter", "flushOnExport");
  const bridge = new OpenTelemetryBridge(settings, false);
  return {
    export(spans, resultCallback) {
      const report = exportReporter(resultCallback);
      const failure = bridge.enqueueExport(spans);
      if (failure === undefined) {
        void bridge.reportExport(report);
        return;
      }
      report(openTelemetryExportFailure(failure.error));
    },
    async forceFlush() {
      await bridge.flushQueue(true);
    },
    async shutdown() {
      bridge.closed = true;
      await bridge.flushQueue(true);
    }
  };
}

module.exports = {
  createLogBrewOpenTelemetrySpanExporter,
  createLogBrewOpenTelemetrySpanProcessor,
  logbrewTraceContextFromCurrentOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpan,
  logbrewTraceContextFromOpenTelemetrySpanContext,
  spanAttributesFromOpenTelemetryReadableSpan
};
