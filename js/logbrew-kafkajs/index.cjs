"use strict";

const { parseTraceparent, SdkError } = require("@logbrew/sdk");
const {
  createLogBrewQueueTraceHeaders,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} = require("@logbrew/node");

const DEFAULT_SYSTEM = "kafka";
const DEFAULT_TOPIC = "kafka";
const TRACEPARENT_HEADER = "traceparent";

async function kafkaJsProducerSendWithLogBrewSpan(producer, record, options = {}) {
  if (!producer || typeof producer.send !== "function") {
    throw new SdkError("configuration_error", "kafkaJsProducerSendWithLogBrewSpan requires a KafkaJS producer");
  }
  const topic = normalizeLabel(record?.topic, options.topicName ?? DEFAULT_TOPIC);
  const messages = Array.isArray(record?.messages) ? record.messages : [];

  return queueBatchOperationWithLogBrewSpan("send", {
    ...options,
    messageCount: messages.length,
    operation: () => producer.send(createLogBrewKafkaJsProducerRecord(record)),
    operationKind: "publish",
    queueName: topic,
    system: DEFAULT_SYSTEM
  });
}

async function kafkaJsProducerSendBatchWithLogBrewSpan(producer, batch, options = {}) {
  if (!producer || typeof producer.sendBatch !== "function") {
    throw new SdkError("configuration_error", "kafkaJsProducerSendBatchWithLogBrewSpan requires a KafkaJS producer with sendBatch");
  }
  const topicMessages = Array.isArray(batch?.topicMessages) ? batch.topicMessages : [];

  return queueBatchOperationWithLogBrewSpan("sendBatch", {
    ...options,
    messageCount: countTopicMessages(topicMessages),
    operation: () => producer.sendBatch(createLogBrewKafkaJsProducerBatch(batch)),
    operationKind: "publish",
    queueName: resolveBatchTopicName(topicMessages, options.topicName),
    system: DEFAULT_SYSTEM
  });
}

function withLogBrewKafkaJsEachMessage(eachMessage, options = {}) {
  if (typeof eachMessage !== "function") {
    throw new SdkError("configuration_error", "withLogBrewKafkaJsEachMessage requires an eachMessage function");
  }

  return async function logBrewKafkaJsEachMessage(payload) {
    const topic = normalizeLabel(payload?.topic, options.topicName ?? DEFAULT_TOPIC);
    return queueOperationWithLogBrewSpan("eachMessage", {
      ...options,
      operation: () => eachMessage(payload),
      operationKind: "process",
      queueName: topic,
      system: DEFAULT_SYSTEM,
      traceparent: extractLogBrewKafkaJsTraceparent(payload?.message)
    });
  };
}

function withLogBrewKafkaJsEachBatch(eachBatch, options = {}) {
  if (typeof eachBatch !== "function") {
    throw new SdkError("configuration_error", "withLogBrewKafkaJsEachBatch requires an eachBatch function");
  }

  return async function logBrewKafkaJsEachBatch(payload) {
    const batch = payload?.batch;
    const topic = normalizeLabel(batch?.topic, options.topicName ?? DEFAULT_TOPIC);
    const messages = Array.isArray(batch?.messages) ? batch.messages : [];
    return queueBatchOperationWithLogBrewSpan("eachBatch", {
      ...options,
      linkMetadata: { topic },
      messages,
      operation: () => eachBatch(payload),
      operationKind: "process",
      queueName: topic,
      system: DEFAULT_SYSTEM
    });
  };
}

function createLogBrewKafkaJsProducerRecord(record = {}, traceparent = undefined) {
  const source = cloneObject(record);
  if (!Array.isArray(source.messages)) {
    return source;
  }
  const normalizedTraceparent = normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);
  return {
    ...source,
    messages: source.messages.map((message) => createLogBrewKafkaJsMessage(message, normalizedTraceparent))
  };
}

function createLogBrewKafkaJsProducerBatch(batch = {}, traceparent = undefined) {
  const source = cloneObject(batch);
  if (!Array.isArray(source.topicMessages)) {
    return source;
  }
  const normalizedTraceparent = normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);
  return {
    ...source,
    topicMessages: source.topicMessages.map((topicMessage) => {
      const nextTopicMessage = cloneObject(topicMessage);
      if (!Array.isArray(nextTopicMessage.messages)) {
        return nextTopicMessage;
      }
      return {
        ...nextTopicMessage,
        messages: nextTopicMessage.messages.map((message) => createLogBrewKafkaJsMessage(message, normalizedTraceparent))
      };
    })
  };
}

function createLogBrewKafkaJsMessage(message = {}, traceparent = undefined) {
  const source = cloneObject(message);
  const normalizedTraceparent = normalizeTraceparent(traceparent);
  if (!normalizedTraceparent) {
    return source;
  }
  return {
    ...source,
    headers: {
      ...cloneObject(source.headers),
      [TRACEPARENT_HEADER]: normalizedTraceparent
    }
  };
}

function extractLogBrewKafkaJsTraceparent(message) {
  return normalizeTraceparent(readHeaderValue(message?.headers, TRACEPARENT_HEADER));
}

function countTopicMessages(topicMessages) {
  return topicMessages.reduce((count, topicMessage) => {
    const messages = Array.isArray(topicMessage?.messages) ? topicMessage.messages.length : 0;
    return count + messages;
  }, 0);
}

function resolveBatchTopicName(topicMessages, fallback) {
  const explicit = normalizeLabel(fallback, "");
  if (explicit) {
    return explicit;
  }
  const topics = topicMessages
    .map((topicMessage) => normalizeLabel(topicMessage?.topic, ""))
    .filter(Boolean);
  const uniqueTopics = Array.from(new Set(topics));
  return uniqueTopics.length === 1 ? uniqueTopics[0] : DEFAULT_TOPIC;
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

function readHeaderValue(headers, name) {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const value = headers[name];
  if (Array.isArray(value)) {
    return readOneHeaderValue(value[0]);
  }
  return readOneHeaderValue(value);
}

function readOneHeaderValue(value) {
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
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
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

const defaultExport = {
  createLogBrewKafkaJsMessage,
  createLogBrewKafkaJsProducerBatch,
  createLogBrewKafkaJsProducerRecord,
  extractLogBrewKafkaJsTraceparent,
  kafkaJsProducerSendBatchWithLogBrewSpan,
  kafkaJsProducerSendWithLogBrewSpan,
  withLogBrewKafkaJsEachBatch,
  withLogBrewKafkaJsEachMessage
};

module.exports = {
  ...defaultExport,
  default: defaultExport
};
