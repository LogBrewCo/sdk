const { isList, isRecord, optionalProperty } = require("./validation.cjs");

/**
 * @import { Metadata } from "./index.cjs"
 */

const MAX_EXCEPTION_TYPES = 8;
const NO_EXCEPTIONS = 0;
const EXCEPTION_TYPE_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$:.]{0,127}$/u;

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function safeOpenTelemetryExceptionType(value) {
  return typeof value === "string" && EXCEPTION_TYPE_PATTERN.test(value) ? value : undefined;
}

class OpenTelemetryExceptionSummary {
  count = NO_EXCEPTIONS;
  escapedCount = NO_EXCEPTIONS;
  /** @type {string[]} */
  types = [];

  /**
   * @param {Readonly<Record<string, unknown>>} event
   * @returns {void}
   */
  add(event) {
    this.count += 1;
    if (optionalProperty(event["attributes"], "exception.escaped") === true) {
      this.escapedCount += 1;
    }
    const type = safeOpenTelemetryExceptionType(optionalProperty(event["attributes"], "exception.type"));
    if (type !== undefined && !this.types.includes(type) && this.types.length < MAX_EXCEPTION_TYPES) {
      this.types.push(type);
    }
  }

  /**
   * @returns {Metadata}
   */
  metadata() {
    return {
      "otel.exception_event_count": this.count,
      ...(this.escapedCount > NO_EXCEPTIONS ? { "otel.exception_escaped_count": this.escapedCount } : {}),
      ...(this.types.length > NO_EXCEPTIONS ? { "otel.exception_types": this.types.join(",") } : {})
    };
  }
}

/**
 * @param {unknown} events
 * @returns {OpenTelemetryExceptionSummary | undefined}
 */
function openTelemetryExceptionEventSummary(events) {
  if (!isList(events) || events.length === NO_EXCEPTIONS) {
    return undefined;
  }
  const summary = new OpenTelemetryExceptionSummary();
  for (const event of events) {
    if (isRecord(event) && event["name"] === "exception") {
      summary.add(event);
    }
  }
  return summary.count > NO_EXCEPTIONS ? summary : undefined;
}

module.exports = { openTelemetryExceptionEventSummary, safeOpenTelemetryExceptionType };
