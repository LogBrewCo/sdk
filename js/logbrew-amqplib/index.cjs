"use strict";

const { SdkError, parseTraceparent } = require("@logbrew/sdk");
const { createLogBrewQueueTraceHeaders, queueOperationWithLogBrewSpan } = require("@logbrew/node");

/**
 * @import {
 *   LogBrewAmqplibConsumeOptions,
 *   LogBrewAmqplibPublishOptions,
 *   LogBrewAmqplibPublishOptionsLike
 * } from "./index.cjs"
 */

const DEFAULT_SYSTEM = "rabbitmq";
const DEFAULT_DESTINATION = "amqplib";
const TRACEPARENT_HEADER = "traceparent";
const EMPTY_LENGTH = 0;

/**
 * @typedef {(
 *   exchange: string,
 *   routingKey: string,
 *   content: Buffer,
 *   options: Readonly<Record<string, unknown>>
 * ) => unknown} PublishMethod
 * @typedef {(queue: string, content: Buffer, options: Readonly<Record<string, unknown>>) => unknown} SendToQueueMethod
 * @typedef {(message: unknown) => unknown} MessageHandler
 * @typedef {Record<string, string | number | boolean | null>} SpanMetadata
 */

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
 * @returns {value is Readonly<{ publish: PublishMethod }>}
 */
function isPublishChannel(value) {
  return isObject(value) && typeof value["publish"] === "function";
}

/**
 * @param {unknown} value
 * @returns {value is Readonly<{ sendToQueue: SendToQueueMethod }>}
 */
function isSendToQueueChannel(value) {
  return isObject(value) && typeof value["sendToQueue"] === "function";
}

/**
 * @param {unknown} value
 * @returns {value is MessageHandler}
 */
function isMessageHandler(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeLabel(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  return value.trim();
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
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readOneHeaderValue(value) {
  if (isList(value)) {
    const [first] = value;
    return readOneHeaderValue(first);
  }
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return undefined;
}

/**
 * @param {Readonly<Record<string, unknown>> | undefined} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function readHeaderValue(headers, name) {
  if (headers === undefined) {
    return undefined;
  }
  const exact = headers[name];
  if (exact !== undefined) {
    return readOneHeaderValue(exact);
  }
  const lowerName = name.toLowerCase();
  const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
  return matchedKey === undefined ? undefined : readOneHeaderValue(headers[matchedKey]);
}

/**
 * @param {unknown} messageOrHeaders
 * @returns {Readonly<Record<string, unknown>> | undefined}
 */
function readHeaders(messageOrHeaders) {
  if (!isObject(messageOrHeaders)) {
    return undefined;
  }
  const { headers, properties } = messageOrHeaders;
  if (isObject(properties) && isObject(properties["headers"])) {
    return properties["headers"];
  }
  if (isObject(headers)) {
    return headers;
  }
  return messageOrHeaders;
}

/**
 * @param {unknown} message
 * @param {string} name
 * @returns {unknown}
 */
function readMessageField(message, name) {
  if (!isObject(message) || !isObject(message["fields"])) {
    return undefined;
  }
  return message["fields"][name];
}

/**
 * @param {string} exchange
 * @param {string} routingKey
 * @param {unknown} fallback
 * @returns {string}
 */
function resolvePublishDestination(exchange, routingKey, fallback) {
  const explicit = normalizeLabel(fallback, "");
  if (explicit !== "") {
    return explicit;
  }
  if (exchange !== "") {
    return exchange;
  }
  return routingKey === "" ? DEFAULT_DESTINATION : routingKey;
}

/**
 * @param {unknown} message
 * @param {unknown} fallback
 * @returns {string}
 */
function resolveConsumeDestination(message, fallback) {
  const explicit = normalizeLabel(fallback, "");
  if (explicit !== "") {
    return explicit;
  }
  return normalizeLabel(readMessageField(message, "routingKey"), DEFAULT_DESTINATION);
}

/**
 * @param {unknown} metadata
 * @param {string} exchange
 * @param {string} routingKey
 * @returns {SpanMetadata}
 */
function mergeAmqpMetadata(metadata, exchange, routingKey) {
  /** @type {SpanMetadata} */
  const merged = {};
  for (const [key, value] of Object.entries(cloneObject(metadata))) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      merged[key] = value;
    }
  }
  if (exchange !== "") {
    merged["amqpExchange"] = exchange;
  }
  if (routingKey !== "") {
    merged["amqpRoutingKey"] = routingKey;
  }
  return merged;
}

/**
 * @template Options
 * @param {Options | undefined} options
 * @returns {Options}
 */
function requireSpanOptions(options) {
  if (options === undefined) {
    throw new SdkError("configuration_error", "queueOperationWithLogBrewSpan requires client");
  }
  return options;
}

/**
 * @param {unknown} messageOrHeaders
 * @returns {string | undefined}
 */
function extractLogBrewAmqplibTraceparent(messageOrHeaders) {
  return normalizeTraceparent(readHeaderValue(readHeaders(messageOrHeaders), TRACEPARENT_HEADER));
}

/**
 * @param {unknown} [publishOptions]
 * @param {unknown} [traceparent]
 * @returns {LogBrewAmqplibPublishOptionsLike}
 */
function createLogBrewAmqplibPublishOptions(publishOptions, traceparent) {
  const source = cloneObject(publishOptions);
  const headers = cloneObject(source["headers"]);
  const normalizedTraceparent = normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);

  if (normalizedTraceparent === undefined) {
    return Object.keys(headers).length === EMPTY_LENGTH ? source : { ...source, headers };
  }

  return {
    ...source,
    headers: {
      ...headers,
      [TRACEPARENT_HEADER]: normalizedTraceparent
    }
  };
}

/**
 * @param {unknown} channel
 * @param {string} exchange
 * @param {string} routingKey
 * @param {Buffer} content
 * @param {unknown} publishOptions
 * @param {LogBrewAmqplibPublishOptions | undefined} options
 * @returns {Promise<unknown>}
 */
async function amqplibPublishWithLogBrewSpan(channel, exchange, routingKey, content, publishOptions, options) {
  if (!isPublishChannel(channel)) {
    throw new SdkError("configuration_error", "amqplibPublishWithLogBrewSpan requires an amqplib channel");
  }
  const normalizedExchange = normalizeLabel(exchange, "");
  const normalizedRoutingKey = normalizeLabel(routingKey, "");
  const spanOptions = requireSpanOptions(options);

  return queueOperationWithLogBrewSpan("publish", {
    ...spanOptions,
    metadata: mergeAmqpMetadata(spanOptions.metadata, normalizedExchange, normalizedRoutingKey),
    operation: () => channel.publish(exchange, routingKey, content, createLogBrewAmqplibPublishOptions(publishOptions)),
    operationKind: "publish",
    queueName: resolvePublishDestination(normalizedExchange, normalizedRoutingKey, spanOptions.destinationName),
    system: DEFAULT_SYSTEM
  });
}

/**
 * @param {unknown} channel
 * @param {string} queue
 * @param {Buffer} content
 * @param {unknown} publishOptions
 * @param {LogBrewAmqplibPublishOptions | undefined} options
 * @returns {Promise<unknown>}
 */
async function amqplibSendToQueueWithLogBrewSpan(channel, queue, content, publishOptions, options) {
  if (!isSendToQueueChannel(channel)) {
    throw new SdkError("configuration_error", "amqplibSendToQueueWithLogBrewSpan requires an amqplib channel");
  }
  const queueName = normalizeLabel(queue, DEFAULT_DESTINATION);
  const spanOptions = requireSpanOptions(options);

  return queueOperationWithLogBrewSpan("sendToQueue", {
    ...spanOptions,
    metadata: mergeAmqpMetadata(spanOptions.metadata, "", queueName),
    operation: () => channel.sendToQueue(queue, content, createLogBrewAmqplibPublishOptions(publishOptions)),
    operationKind: "publish",
    queueName,
    system: DEFAULT_SYSTEM
  });
}

/**
 * @param {unknown} onMessage
 * @param {LogBrewAmqplibConsumeOptions | undefined} options
 * @returns {(message: unknown) => Promise<unknown>}
 */
function withLogBrewAmqplibConsumer(onMessage, options) {
  if (!isMessageHandler(onMessage)) {
    throw new SdkError("configuration_error", "withLogBrewAmqplibConsumer requires an amqplib message handler");
  }

  return async function logBrewAmqplibConsumer(message) {
    if (message === null || message === undefined) {
      return onMessage(message);
    }

    const exchange = normalizeLabel(readMessageField(message, "exchange"), "");
    const routingKey = normalizeLabel(readMessageField(message, "routingKey"), "");
    const traceparent = extractLogBrewAmqplibTraceparent(message);
    const spanOptions = requireSpanOptions(options);
    return queueOperationWithLogBrewSpan("consume", {
      ...spanOptions,
      metadata: mergeAmqpMetadata(spanOptions.metadata, exchange, routingKey),
      operation: () => onMessage(message),
      operationKind: "process",
      queueName: resolveConsumeDestination(message, spanOptions.queueName),
      system: DEFAULT_SYSTEM,
      ...(traceparent === undefined ? {} : { traceparent })
    });
  };
}

const defaultExport = {
  amqplibPublishWithLogBrewSpan,
  amqplibSendToQueueWithLogBrewSpan,
  createLogBrewAmqplibPublishOptions,
  extractLogBrewAmqplibTraceparent,
  withLogBrewAmqplibConsumer
};

module.exports = {
  ...defaultExport,
  default: defaultExport
};
