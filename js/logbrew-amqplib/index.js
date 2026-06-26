import { parseTraceparent, SdkError } from "@logbrew/sdk";
import {
  createLogBrewQueueTraceHeaders,
  queueOperationWithLogBrewSpan
} from "@logbrew/node";

const DEFAULT_SYSTEM = "rabbitmq";
const DEFAULT_DESTINATION = "amqplib";
const TRACEPARENT_HEADER = "traceparent";

export async function amqplibPublishWithLogBrewSpan(channel, exchange, routingKey, content, publishOptions = {}, options = {}) {
  if (!channel || typeof channel.publish !== "function") {
    throw new SdkError("configuration_error", "amqplibPublishWithLogBrewSpan requires an amqplib channel");
  }
  const normalizedExchange = normalizeLabel(exchange, "");
  const normalizedRoutingKey = normalizeLabel(routingKey, "");

  return queueOperationWithLogBrewSpan("publish", {
    ...options,
    metadata: mergeAmqpMetadata(options.metadata, normalizedExchange, normalizedRoutingKey),
    operation: () => channel.publish(
      exchange,
      routingKey,
      content,
      createLogBrewAmqplibPublishOptions(publishOptions)
    ),
    operationKind: "publish",
    queueName: resolvePublishDestination(normalizedExchange, normalizedRoutingKey, options.destinationName),
    system: DEFAULT_SYSTEM
  });
}

export async function amqplibSendToQueueWithLogBrewSpan(channel, queue, content, publishOptions = {}, options = {}) {
  if (!channel || typeof channel.sendToQueue !== "function") {
    throw new SdkError("configuration_error", "amqplibSendToQueueWithLogBrewSpan requires an amqplib channel");
  }
  const queueName = normalizeLabel(queue, DEFAULT_DESTINATION);

  return queueOperationWithLogBrewSpan("sendToQueue", {
    ...options,
    metadata: mergeAmqpMetadata(options.metadata, "", queueName),
    operation: () => channel.sendToQueue(
      queue,
      content,
      createLogBrewAmqplibPublishOptions(publishOptions)
    ),
    operationKind: "publish",
    queueName,
    system: DEFAULT_SYSTEM
  });
}

export function withLogBrewAmqplibConsumer(onMessage, options = {}) {
  if (typeof onMessage !== "function") {
    throw new SdkError("configuration_error", "withLogBrewAmqplibConsumer requires an amqplib message handler");
  }

  return async function logBrewAmqplibConsumer(message) {
    if (message === null || message === undefined) {
      return onMessage(message);
    }

    const exchange = normalizeLabel(message?.fields?.exchange, "");
    const routingKey = normalizeLabel(message?.fields?.routingKey, "");
    return queueOperationWithLogBrewSpan("consume", {
      ...options,
      metadata: mergeAmqpMetadata(options.metadata, exchange, routingKey),
      operation: () => onMessage(message),
      operationKind: "process",
      queueName: resolveConsumeDestination(message, options.queueName),
      system: DEFAULT_SYSTEM,
      traceparent: extractLogBrewAmqplibTraceparent(message)
    });
  };
}

export function createLogBrewAmqplibPublishOptions(publishOptions = {}, traceparent = undefined) {
  const source = cloneObject(publishOptions);
  const headers = cloneObject(source.headers);
  const normalizedTraceparent = normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);

  if (!normalizedTraceparent) {
    return Object.keys(headers).length > 0 ? { ...source, headers } : source;
  }

  return {
    ...source,
    headers: {
      ...headers,
      [TRACEPARENT_HEADER]: normalizedTraceparent
    }
  };
}

export function extractLogBrewAmqplibTraceparent(messageOrHeaders) {
  const headers = readHeaders(messageOrHeaders);
  return normalizeTraceparent(readHeaderValue(headers, TRACEPARENT_HEADER));
}

function resolvePublishDestination(exchange, routingKey, fallback) {
  const explicit = normalizeLabel(fallback, "");
  if (explicit) {
    return explicit;
  }
  return exchange || routingKey || DEFAULT_DESTINATION;
}

function resolveConsumeDestination(message, fallback) {
  const explicit = normalizeLabel(fallback, "");
  if (explicit) {
    return explicit;
  }
  return normalizeLabel(message?.fields?.routingKey, DEFAULT_DESTINATION);
}

function mergeAmqpMetadata(metadata, exchange, routingKey) {
  return {
    ...cloneObject(metadata),
    ...(exchange ? { amqpExchange: exchange } : {}),
    ...(routingKey ? { amqpRoutingKey: routingKey } : {})
  };
}

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

function readHeaders(messageOrHeaders) {
  if (!messageOrHeaders || typeof messageOrHeaders !== "object") {
    return undefined;
  }
  if (isObject(messageOrHeaders.properties?.headers)) {
    return messageOrHeaders.properties.headers;
  }
  if (isObject(messageOrHeaders.headers)) {
    return messageOrHeaders.headers;
  }
  return isObject(messageOrHeaders) ? messageOrHeaders : undefined;
}

function readHeaderValue(headers, name) {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const exact = headers[name];
  if (exact !== undefined) {
    return readOneHeaderValue(exact);
  }
  const lowerName = name.toLowerCase();
  const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
  return matchedKey ? readOneHeaderValue(headers[matchedKey]) : undefined;
}

function readOneHeaderValue(value) {
  if (Array.isArray(value)) {
    return readOneHeaderValue(value[0]);
  }
  if (typeof value === "string") {
    return value;
  }
  if (isNodeBufferValue(value)) {
    return value.toString("utf8");
  }
  return undefined;
}

function normalizeLabel(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function cloneObject(value) {
  return isObject(value) ? { ...value } : {};
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNodeBufferValue(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.toString === "function" &&
    typeof value.constructor?.isBuffer === "function" &&
    value.constructor.isBuffer(value)
  );
}

export default {
  amqplibPublishWithLogBrewSpan,
  amqplibSendToQueueWithLogBrewSpan,
  createLogBrewAmqplibPublishOptions,
  extractLogBrewAmqplibTraceparent,
  withLogBrewAmqplibConsumer
};
