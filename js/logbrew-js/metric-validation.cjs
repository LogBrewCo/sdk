const { withMetadata } = require("./event-metadata.cjs");
const { SdkError } = require("./sdk-error.cjs");
const { hasUnicodeControlCharacter, optionalEntry, requireAllowedValue, requireFiniteNumber, requireNonEmpty } = require("./validation.cjs");

/**
 * @import { EventAttributes } from "./event-validation.cjs"
 * @typedef {"counter" | "gauge" | "histogram"} MetricKind
 */

const MAX_METRIC_DESCRIPTION_LENGTH = 1024;
const MIN_METRIC_VALUE = 0;
const FIRST_CODE_POINT = 0;
const FIRST_SURROGATE = 0xD8_00;
const LAST_SURROGATE = 0xDF_FF;
const LINE_SEPARATOR = 0x20_28;
const PARAGRAPH_SEPARATOR = 0x20_29;
/** @type {ReadonlySet<MetricKind>} */
const METRIC_KINDS = new Set(["counter", "gauge", "histogram"]);
/** @type {ReadonlySet<MetricKind>} */
const NON_NEGATIVE_METRIC_KINDS = new Set(["counter", "histogram"]);
/** @type {ReadonlySet<string>} */
const CUMULATIVE_TEMPORALITIES = new Set(["delta", "cumulative"]);
/** @type {ReadonlyMap<MetricKind, ReadonlySet<string>>} */
const METRIC_TEMPORALITIES_BY_KIND = new Map([
  ["counter", CUMULATIVE_TEMPORALITIES],
  ["gauge", new Set(["instant"])],
  ["histogram", CUMULATIVE_TEMPORALITIES]
]);

/**
 * @param {string} character
 * @returns {boolean}
 */
function isSeparatorOrSurrogate(character) {
  const code = character.codePointAt(FIRST_CODE_POINT);
  return code !== undefined && (
    (code >= FIRST_SURROGATE && code <= LAST_SURROGATE)
    || code === LINE_SEPARATOR
    || code === PARAGRAPH_SEPARATOR
  );
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function metricDescriptionOrUndefined(value) {
  if (value === undefined) {
    return undefined;
  }
  const characters = typeof value === "string" ? [...value] : [];
  if (
    typeof value !== "string"
    || value.trim() === ""
    || characters.length > MAX_METRIC_DESCRIPTION_LENGTH
    || hasUnicodeControlCharacter(value)
    || characters.some((character) => isSeparatorOrSurrogate(character))
  ) {
    throw new SdkError(
      "validation_error",
      `metric description must be a non-blank string of at most ${MAX_METRIC_DESCRIPTION_LENGTH} non-control characters`
    );
  }
  return value.trim();
}

/**
 * @param {Readonly<Record<string, unknown>>} attributes
 * @returns {EventAttributes}
 */
function validateMetric(attributes) {
  const name = requireNonEmpty("metric name", attributes["name"]);
  const kind = requireAllowedValue("metric kind", attributes["kind"], METRIC_KINDS);
  const value = requireFiniteNumber("metric value", attributes["value"]);
  const unit = requireNonEmpty("metric unit", attributes["unit"]);
  const allowedTemporalities = METRIC_TEMPORALITIES_BY_KIND.get(kind) ?? CUMULATIVE_TEMPORALITIES;
  const temporality = requireAllowedValue(`metric temporality for ${kind}`, attributes["temporality"], allowedTemporalities);
  if (NON_NEGATIVE_METRIC_KINDS.has(kind) && value < MIN_METRIC_VALUE) {
    throw new SdkError("validation_error", `metric ${kind} value must be non-negative`);
  }
  const description = metricDescriptionOrUndefined(attributes["description"]);
  return withMetadata({
    name,
    ...optionalEntry("description", description),
    kind,

    value,

    unit,

    temporality
  }, attributes["metadata"], attributes["context"]);
}

module.exports = { validateMetric };
