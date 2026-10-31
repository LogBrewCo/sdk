const { SdkError } = require("./sdk-error.cjs");
const { validateTelemetryContext } = require("./telemetry-context.cjs");
const { isRecord, optionalEntry } = require("./validation.cjs");

/**
 * @import { TelemetryContext } from "./index.cjs"
 */

/**
 * @param {unknown} metadata
 * @returns {Record<string, unknown> | undefined}
 */
function cloneMetadata(metadata) {
  if (metadata === undefined) {
    return undefined;
  }
  if (!isRecord(metadata)) {
    throw new SdkError("validation_error", "metadata must be an object");
  }
  return { ...metadata };
}

/**
 * @template {object} Attributes
 * @param {Attributes} attributes
 * @param {unknown} metadata
 * @param {unknown} context
 * @returns {Attributes & { metadata?: Record<string, unknown>, context?: TelemetryContext }}
 */
function withMetadata(attributes, metadata, context) {
  const safeMetadata = cloneMetadata(metadata);
  const safeContext = validateTelemetryContext(context);
  return {
    ...attributes,
    ...optionalEntry("metadata", safeMetadata),
    ...optionalEntry("context", safeContext)
  };
}

module.exports = { withMetadata };
