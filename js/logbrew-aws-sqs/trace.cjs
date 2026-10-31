"use strict";

const { isObject, normalizeTraceparent, readBytesAsUtf8, readField, utf8ByteLength } = require("./internal.cjs");
const { createLogBrewQueueTraceLinks } = require("@logbrew/node");

/**
 * @import { SpanLinkSummary } from "@logbrew/sdk"
 * @import { LogBrewSqsTraceExtractionOptions } from "./index.cjs"
 */

/**
 * @typedef {{
 *   readonly extractEventBridgeEnvelopeTraceparent: boolean,
 *   readonly extractSnsEnvelopeTraceparent: boolean,
 *   readonly maxEnvelopeBytes: number
 * }} TraceExtraction
 * @typedef {Readonly<Record<string, string | number | boolean | null>>} LinkMetadata
 * @typedef {{
 *   readonly extractEventBridgeEnvelopeTraceparent?: boolean | undefined,
 *   readonly extractSnsEnvelopeTraceparent?: boolean | undefined,
 *   readonly maxEnvelopeBytes?: number | undefined
 * }} TraceExtractionInput
 */

const TRACEPARENT_ATTRIBUTE = "traceparent";
const DEFAULT_MAX_ENVELOPE_BYTES = 262_144;
const MAX_ENVELOPE_BYTES = 1_048_576;
const MIN_BYTES = 0;

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeEnvelopeByteLimit(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= MIN_BYTES) {
    return DEFAULT_MAX_ENVELOPE_BYTES;
  }
  return Math.min(Math.floor(value), MAX_ENVELOPE_BYTES);
}

/**
 * @param {TraceExtractionInput | undefined} options
 * @returns {TraceExtraction}
 */
function normalizeSqsTraceExtractionOptions(options) {
  return {
    extractEventBridgeEnvelopeTraceparent: options?.extractEventBridgeEnvelopeTraceparent === true,
    extractSnsEnvelopeTraceparent: options?.extractSnsEnvelopeTraceparent === true,
    maxEnvelopeBytes: normalizeEnvelopeByteLimit(options?.maxEnvelopeBytes)
  };
}

/**
 * @param {unknown} value
 * @param {number} maxEnvelopeBytes
 * @returns {Readonly<Record<string, unknown>> | undefined}
 */
function parseJsonEnvelope(value, maxEnvelopeBytes) {
  if (typeof value !== "string" || value.trim() === "" || utf8ByteLength(value) > maxEnvelopeBytes) {
    return undefined;
  }
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readOneSqsAttributeValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!isObject(value)) {
    return undefined;
  }
  const { BinaryValue: binaryValue, StringValue: stringValue, Value: plainValue } = value;
  if (typeof stringValue === "string") {
    return stringValue;
  }
  if (typeof plainValue === "string") {
    return plainValue;
  }
  return readBytesAsUtf8(binaryValue);
}

/**
 * @param {unknown} attributes
 * @param {string} name
 * @returns {string | undefined}
 */
function readSqsAttributeValue(attributes, name) {
  if (!isObject(attributes)) {
    return undefined;
  }
  const exact = attributes[name];
  if (exact !== undefined) {
    return readOneSqsAttributeValue(exact);
  }
  const lowerName = name.toLowerCase();
  const matchedKey = Object.keys(attributes).find((key) => key.toLowerCase() === lowerName);
  return matchedKey === undefined || matchedKey === "" ? undefined : readOneSqsAttributeValue(attributes[matchedKey]);
}

/**
 * @param {unknown} messageOrAttributes
 * @returns {unknown}
 */
function readSqsAttributes(messageOrAttributes) {
  if (!isObject(messageOrAttributes)) {
    return undefined;
  }
  const { MessageAttributes: messageAttributes } = messageOrAttributes;
  return isObject(messageAttributes) ? messageAttributes : messageOrAttributes;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSnsEnvelope(value) {
  return readField(value, "Type") === "Notification";
}

/**
 * @param {unknown} messageOrEnvelope
 * @param {number} maxEnvelopeBytes
 * @returns {unknown}
 */
function readSqsEnvelope(messageOrEnvelope, maxEnvelopeBytes) {
  if (typeof messageOrEnvelope === "string") {
    return parseJsonEnvelope(messageOrEnvelope, maxEnvelopeBytes);
  }
  if (!isObject(messageOrEnvelope)) {
    return undefined;
  }
  const { Body: body } = messageOrEnvelope;
  if (typeof body === "string") {
    return parseJsonEnvelope(body, maxEnvelopeBytes);
  }
  return messageOrEnvelope;
}

/**
 * @param {unknown} envelope
 * @returns {string | undefined}
 */
function readSnsEnvelopeTraceparent(envelope) {
  if (!isSnsEnvelope(envelope)) {
    return undefined;
  }
  return normalizeTraceparent(readSqsAttributeValue(readField(envelope, "MessageAttributes"), TRACEPARENT_ATTRIBUTE));
}

/**
 * @param {unknown} envelope
 * @returns {string | undefined}
 */
function readEventBridgeDetailTraceparent(envelope) {
  const detail = readField(envelope, "detail");
  if (typeof readField(envelope, "detail-type") !== "string" || !isObject(detail)) {
    return undefined;
  }
  return normalizeTraceparent(detail["traceparent"] ?? detail["traceParent"]);
}

/**
 * @param {unknown} envelope
 * @param {TraceExtraction} options
 * @returns {string | undefined}
 */
function readEventBridgeEnvelopeTraceparent(envelope, options) {
  const direct = readEventBridgeDetailTraceparent(envelope);
  if (direct !== undefined) {
    return direct;
  }
  const message = readField(envelope, "Message");
  if (!isSnsEnvelope(envelope) || typeof message !== "string") {
    return undefined;
  }
  return readEventBridgeDetailTraceparent(parseJsonEnvelope(message, options.maxEnvelopeBytes));
}

/**
 * @param {unknown} messageOrEnvelope
 * @param {TraceExtraction} options
 * @returns {string | undefined}
 */
function extractEnvelopeTraceparent(messageOrEnvelope, options) {
  const envelope = readSqsEnvelope(messageOrEnvelope, options.maxEnvelopeBytes);
  if (!isObject(envelope)) {
    return undefined;
  }
  if (options.extractSnsEnvelopeTraceparent) {
    const snsTraceparent = readSnsEnvelopeTraceparent(envelope);
    if (snsTraceparent !== undefined) {
      return snsTraceparent;
    }
  }
  if (options.extractEventBridgeEnvelopeTraceparent) {
    return readEventBridgeEnvelopeTraceparent(envelope, options);
  }
  return undefined;
}

/**
 * @param {unknown} [messageOrAttributes]
 * @param {LogBrewSqsTraceExtractionOptions} [options]
 * @returns {string | undefined}
 */
function extractLogBrewSqsTraceparent(messageOrAttributes, options) {
  const traceparent = normalizeTraceparent(
    readSqsAttributeValue(readSqsAttributes(messageOrAttributes), TRACEPARENT_ATTRIBUTE)
  );
  if (traceparent !== undefined) {
    return traceparent;
  }
  const traceExtractionOptions = normalizeSqsTraceExtractionOptions(options);
  if (
    !traceExtractionOptions.extractSnsEnvelopeTraceparent &&
    !traceExtractionOptions.extractEventBridgeEnvelopeTraceparent
  ) {
    return undefined;
  }
  return extractEnvelopeTraceparent(messageOrAttributes, traceExtractionOptions);
}

/**
 * @param {unknown} message
 * @param {LogBrewSqsTraceExtractionOptions | undefined} options
 * @returns {{ traceparent: string } | undefined}
 */
function sqsMessageTraceCarrier(message, options) {
  const traceparent = extractLogBrewSqsTraceparent(message, options);
  return traceparent === undefined ? undefined : { traceparent };
}

/**
 * @param {unknown} [messages]
 * @param {LinkMetadata} [metadata]
 * @param {LogBrewSqsTraceExtractionOptions} [options]
 * @returns {SpanLinkSummary[]}
 */
function createLogBrewSqsTraceLinks(messages, metadata, options) {
  const carriers = Array.isArray(messages)
    ? messages.map((message) => sqsMessageTraceCarrier(message, options))
    : [sqsMessageTraceCarrier(messages, options)];
  return createLogBrewQueueTraceLinks(carriers, metadata);
}

module.exports = {
  createLogBrewSqsTraceLinks,
  extractLogBrewSqsTraceparent,
  normalizeSqsTraceExtractionOptions,
  parseJsonEnvelope
};
