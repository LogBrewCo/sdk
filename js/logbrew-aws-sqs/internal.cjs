"use strict";

const { SdkError, parseTraceparent } = require("@logbrew/sdk");

/**
 * @import { SpanLinkSummary } from "@logbrew/sdk"
 */

/**
 * @typedef {(...args: readonly unknown[]) => unknown} Callable
 * @typedef {new (input: Readonly<Record<string, unknown>>) => unknown} CommandConstructor
 * @typedef {Readonly<{ send: Callable }>} SendClient
 */

const EMPTY_LENGTH = 0;
const MAX_LINKS = 8;

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is Callable}
 */
function isCallable(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {unknown}
 */
function readField(value, name) {
  return isObject(value) ? value[name] : undefined;
}

/**
 * @param {unknown} value
 * @returns {readonly unknown[]}
 */
function readList(value) {
  return isList(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function cloneObject(value) {
  return isObject(value) ? { ...value } : {};
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeLabel(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeTraceparent(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  try {
    const context = parseTraceparent(value);
    return `${context.version}-${context.traceId}-${context.parentSpanId}-${context.traceFlags}`;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} value
 * @returns {number}
 */
function utf8ByteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

/**
 * @param {unknown} value
 * @returns {value is Buffer}
 */
function isNodeBufferValue(value) {
  if (!isCallable(readField(value, "toString")) || !isObject(value)) {
    return false;
  }
  const { constructor } = value;
  if (!isCallable(constructor) && !isObject(constructor)) {
    return false;
  }
  /** @type {unknown} */
  const isBuffer = Reflect.get(constructor, "isBuffer");
  return isCallable(isBuffer) && Boolean(isBuffer.call(constructor, value));
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readBytesAsUtf8(value) {
  if (isNodeBufferValue(value)) {
    return value.toString("utf8");
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  return undefined;
}

/**
 * @param {readonly SpanLinkSummary[] | undefined} value
 * @returns {value is readonly SpanLinkSummary[]}
 */
function isLinkList(value) {
  return Array.isArray(value);
}

/**
 * @param {readonly SpanLinkSummary[]} generatedLinks
 * @param {readonly SpanLinkSummary[] | undefined} explicitLinks
 * @returns {SpanLinkSummary[] | undefined}
 */
function mergeLinks(generatedLinks, explicitLinks) {
  const links = isLinkList(explicitLinks) ? [...generatedLinks, ...explicitLinks] : [...generatedLinks];
  return links.length > EMPTY_LENGTH ? links.slice(EMPTY_LENGTH, MAX_LINKS) : undefined;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeArnLabel(value, fallback) {
  const label = normalizeLabel(value, "");
  if (label === "") {
    return fallback;
  }
  return normalizeLabel(/(?<last>[^/:]+)[/:]*$/u.exec(label)?.groups?.["last"], fallback);
}

/**
 * @param {unknown} source
 * @param {unknown} fallback
 * @returns {string}
 */
function resolveQueueName(source, fallback) {
  const explicit = normalizeLabel(fallback, "");
  if (explicit !== "") {
    return explicit;
  }
  const queueUrl = normalizeLabel(readField(source, "QueueUrl"), "");
  if (queueUrl === "") {
    return "sqs";
  }
  return normalizeLabel(/(?<last>[^/]+)\/*$/u.exec(queueUrl)?.groups?.["last"], "sqs");
}

/**
 * @param {unknown} source
 * @param {unknown} fallback
 * @returns {string}
 */
function resolveSnsDestinationName(source, fallback) {
  const explicit = normalizeLabel(fallback, "");
  if (explicit !== "") {
    return explicit;
  }
  return normalizeArnLabel(readField(source, "TopicArn"), "sns");
}

/**
 * @param {unknown} source
 * @param {unknown} fallback
 * @returns {string}
 */
function resolveEventBridgeDestinationName(source, fallback) {
  const explicit = normalizeLabel(fallback, "");
  if (explicit !== "") {
    return explicit;
  }
  const firstEntry = readList(readField(source, "Entries")).find((entry) => isObject(entry));
  return normalizeArnLabel(readField(firstEntry, "EventBusName"), "eventbridge");
}

/**
 * @param {unknown} value
 * @returns {value is SendClient}
 */
function isSendClient(value) {
  return (typeof value === "object" || typeof value === "function") && value !== null && isCallable(Reflect.get(value, "send"));
}

/**
 * @param {unknown} value
 * @returns {value is CommandConstructor}
 */
function isCommandConstructor(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} client
 * @param {string} source
 * @param {string} service
 * @returns {SendClient}
 */
function requireAwsClient(client, source, service) {
  if (!isSendClient(client)) {
    throw new SdkError("configuration_error", `${source} requires an AWS SDK ${service} client`);
  }
  return client;
}

/**
 * @param {unknown} command
 * @param {string} source
 * @param {string} name
 * @returns {CommandConstructor}
 */
function requireCommand(command, source, name) {
  if (!isCommandConstructor(command)) {
    throw new SdkError("configuration_error", `${source} requires ${name}`);
  }
  return command;
}

/**
 * @template Options
 * @param {Options | undefined} options
 * @returns {Options}
 */
function requireSpanOptions(options) {
  if (!isObject(options)) {
    throw new SdkError("configuration_error", "queueOperationWithLogBrewSpan requires client");
  }
  return options;
}

module.exports = {
  cloneObject,
  isCallable,
  isObject,
  mergeLinks,
  normalizeLabel,
  normalizeTraceparent,
  readBytesAsUtf8,
  readField,
  readList,
  requireAwsClient,
  requireCommand,
  requireSpanOptions,
  resolveEventBridgeDestinationName,
  resolveQueueName,
  resolveSnsDestinationName,
  utf8ByteLength
};
