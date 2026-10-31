import {
  cloneObject,
  createInstrumentationState,
  installMethod,
  isBatchMessage,
  isCallable,
  isObjectLike,
  normalizeLabel,
  normalizeTraceparent,
  readField,
  readHeaderValue,
  readList,
  requireSpanOptions
} from "./internal.js";
import {
  createLogBrewQueueTraceHeaders,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} from "@logbrew/node";
import { SdkError } from "@logbrew/sdk";

/**
 * @import { Callable } from "./internal.js"
 * @import {
 *   LogBrewKafkaJsBatchProcessOptions,
 *   LogBrewKafkaJsInstrumentation,
 *   LogBrewKafkaJsInstrumentationOptions,
 *   LogBrewKafkaJsProcessOptions,
 *   LogBrewKafkaJsSendOptions
 * } from "./index.js"
 */

const DEFAULT_SYSTEM = "kafka";
const DEFAULT_TOPIC = "kafka";
const TRACEPARENT_HEADER = "traceparent";
const PRODUCER_INSTRUMENTATION = Symbol("logbrew.kafkajs.producer.instrumentation");
const CONSUMER_INSTRUMENTATION = Symbol("logbrew.kafkajs.consumer.instrumentation");
const EMPTY_COUNT = 0;
const SINGLE_TOPIC = 1;

/**
 * @param {readonly unknown[]} topicMessages
 * @returns {number}
 */
function countTopicMessages(topicMessages) {
  let count = EMPTY_COUNT;
  for (const topicMessage of topicMessages) {
    count += readList(readField(topicMessage, "messages")).length;
  }
  return count;
}

/**
 * @param {readonly unknown[]} topicMessages
 * @param {unknown} fallback
 * @returns {string}
 */
function resolveBatchTopicName(topicMessages, fallback) {
  const explicit = normalizeLabel(fallback, "");
  if (explicit !== "") {
    return explicit;
  }
  const topics = new Set(
    topicMessages.map((topicMessage) => normalizeLabel(readField(topicMessage, "topic"), "")).filter((topic) => topic !== "")
  );
  const [onlyTopic] = topics;
  return topics.size === SINGLE_TOPIC && onlyTopic !== undefined ? onlyTopic : DEFAULT_TOPIC;
}

/**
 * @param {unknown} [message]
 * @param {unknown} [traceparent]
 * @returns {Record<string, unknown>}
 */
function createLogBrewKafkaJsMessage(message, traceparent) {
  const source = cloneObject(message);
  const normalizedTraceparent = normalizeTraceparent(traceparent);
  if (normalizedTraceparent === undefined) {
    return source;
  }
  return {
    ...source,
    headers: {
      ...cloneObject(source["headers"]),
      [TRACEPARENT_HEADER]: normalizedTraceparent
    }
  };
}

/**
 * @param {unknown} [record]
 * @param {unknown} [traceparent]
 * @returns {Record<string, unknown>}
 */
function createLogBrewKafkaJsProducerRecord(record, traceparent) {
  const source = cloneObject(record);
  const { messages } = source;
  if (!Array.isArray(messages)) {
    return source;
  }
  const normalizedTraceparent = normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);
  return {
    ...source,
    messages: messages.map((message) => createLogBrewKafkaJsMessage(message, normalizedTraceparent))
  };
}

/**
 * @param {unknown} [batch]
 * @param {unknown} [traceparent]
 * @returns {Record<string, unknown>}
 */
function createLogBrewKafkaJsProducerBatch(batch, traceparent) {
  const source = cloneObject(batch);
  const { topicMessages } = source;
  if (!Array.isArray(topicMessages)) {
    return source;
  }
  const normalizedTraceparent = normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);
  return {
    ...source,
    topicMessages: topicMessages.map((topicMessage) => {
      const nextTopicMessage = cloneObject(topicMessage);
      const { messages } = nextTopicMessage;
      if (Array.isArray(messages)) {
        nextTopicMessage["messages"] = messages.map((message) => createLogBrewKafkaJsMessage(message, normalizedTraceparent));
      }
      return nextTopicMessage;
    })
  };
}

/**
 * @param {unknown} message
 * @returns {string | undefined}
 */
function extractLogBrewKafkaJsTraceparent(message) {
  return normalizeTraceparent(readHeaderValue(readField(message, "headers"), TRACEPARENT_HEADER));
}

/**
 * @param {Callable} send
 * @param {unknown} record
 * @param {LogBrewKafkaJsSendOptions | undefined} options
 * @returns {Promise<unknown>}
 */
async function sendWithSpan(send, record, options) {
  const spanOptions = requireSpanOptions(options);
  return queueBatchOperationWithLogBrewSpan("send", {
    ...spanOptions,
    messageCount: readList(readField(record, "messages")).length,
    operation: () => send(createLogBrewKafkaJsProducerRecord(record)),
    operationKind: "publish",
    queueName: normalizeLabel(readField(record, "topic"), spanOptions.topicName ?? DEFAULT_TOPIC),
    system: DEFAULT_SYSTEM
  });
}

/**
 * @param {Callable} sendBatch
 * @param {unknown} batch
 * @param {LogBrewKafkaJsSendOptions | undefined} options
 * @returns {Promise<unknown>}
 */
async function sendBatchWithSpan(sendBatch, batch, options) {
  const spanOptions = requireSpanOptions(options);
  const topicMessages = readList(readField(batch, "topicMessages"));
  return queueBatchOperationWithLogBrewSpan("sendBatch", {
    ...spanOptions,
    messageCount: countTopicMessages(topicMessages),
    operation: () => sendBatch(createLogBrewKafkaJsProducerBatch(batch)),
    operationKind: "publish",
    queueName: resolveBatchTopicName(topicMessages, spanOptions.topicName),
    system: DEFAULT_SYSTEM
  });
}

/**
 * @param {unknown} producer
 * @param {unknown} record
 * @param {LogBrewKafkaJsSendOptions | undefined} options
 * @returns {Promise<unknown>}
 */
async function kafkaJsProducerSendWithLogBrewSpan(producer, record, options) {
  const send = readField(producer, "send");
  if (!isCallable(send)) {
    throw new SdkError("configuration_error", "kafkaJsProducerSendWithLogBrewSpan requires a KafkaJS producer");
  }
  return sendWithSpan((nextRecord) => send.call(producer, nextRecord), record, options);
}

/**
 * @param {unknown} producer
 * @param {unknown} batch
 * @param {LogBrewKafkaJsSendOptions | undefined} options
 * @returns {Promise<unknown>}
 */
async function kafkaJsProducerSendBatchWithLogBrewSpan(producer, batch, options) {
  const sendBatch = readField(producer, "sendBatch");
  if (!isCallable(sendBatch)) {
    throw new SdkError(
      "configuration_error",
      "kafkaJsProducerSendBatchWithLogBrewSpan requires a KafkaJS producer with sendBatch"
    );
  }
  return sendBatchWithSpan((nextBatch) => sendBatch.call(producer, nextBatch), batch, options);
}

/**
 * @param {unknown} eachMessage
 * @param {LogBrewKafkaJsProcessOptions | undefined} options
 * @returns {(payload: unknown) => Promise<unknown>}
 */
function withLogBrewKafkaJsEachMessage(eachMessage, options) {
  if (!isCallable(eachMessage)) {
    throw new SdkError("configuration_error", "withLogBrewKafkaJsEachMessage requires an eachMessage function");
  }

  return async function logBrewKafkaJsEachMessage(payload) {
    const spanOptions = requireSpanOptions(options);
    const traceparent = extractLogBrewKafkaJsTraceparent(readField(payload, "message"));
    return queueOperationWithLogBrewSpan("eachMessage", {
      ...spanOptions,
      operation: () => eachMessage(payload),
      operationKind: "process",
      queueName: normalizeLabel(readField(payload, "topic"), spanOptions.topicName ?? DEFAULT_TOPIC),
      system: DEFAULT_SYSTEM,
      ...(traceparent === undefined ? {} : { traceparent })
    });
  };
}

/**
 * @param {unknown} eachBatch
 * @param {LogBrewKafkaJsBatchProcessOptions | undefined} options
 * @returns {(payload: unknown) => Promise<unknown>}
 */
function withLogBrewKafkaJsEachBatch(eachBatch, options) {
  if (!isCallable(eachBatch)) {
    throw new SdkError("configuration_error", "withLogBrewKafkaJsEachBatch requires an eachBatch function");
  }

  return async function logBrewKafkaJsEachBatch(payload) {
    const spanOptions = requireSpanOptions(options);
    const batch = readField(payload, "batch");
    const topic = normalizeLabel(readField(batch, "topic"), spanOptions.topicName ?? DEFAULT_TOPIC);
    return queueBatchOperationWithLogBrewSpan("eachBatch", {
      ...spanOptions,
      linkMetadata: { topic },
      messages: readList(readField(batch, "messages")).map((message) => (isBatchMessage(message) ? message : {})),
      operation: () => eachBatch(payload),
      operationKind: "process",
      queueName: topic,
      system: DEFAULT_SYSTEM
    });
  };
}

/**
 * @param {unknown} producer
 * @param {LogBrewKafkaJsSendOptions | undefined} options
 * @returns {LogBrewKafkaJsInstrumentation}
 */
function instrumentLogBrewKafkaJsProducer(producer, options) {
  const send = readField(producer, "send");
  const sendBatch = readField(producer, "sendBatch");
  if (!isObjectLike(producer) || (!isCallable(send) && !isCallable(sendBatch))) {
    throw new SdkError("configuration_error", "instrumentLogBrewKafkaJsProducer requires an owned KafkaJS producer");
  }

  const state = createInstrumentationState(producer, PRODUCER_INSTRUMENTATION, "KafkaJS producer");

  if (isCallable(send)) {
    state.undo.push(installMethod(producer, "send", async (receiver, [record, ...args]) =>
      sendWithSpan((nextRecord) => send.call(receiver, nextRecord, ...args), record, options)));
  }

  if (isCallable(sendBatch)) {
    state.undo.push(installMethod(producer, "sendBatch", async (receiver, [batch, ...args]) =>
      sendBatchWithSpan((nextBatch) => sendBatch.call(receiver, nextBatch, ...args), batch, options)));
  }

  return state.handle;
}

/**
 * @param {unknown} consumer
 * @param {LogBrewKafkaJsInstrumentationOptions | undefined} options
 * @returns {LogBrewKafkaJsInstrumentation}
 */
function instrumentLogBrewKafkaJsConsumer(consumer, options) {
  const run = readField(consumer, "run");
  if (!isObjectLike(consumer) || !isCallable(run)) {
    throw new SdkError("configuration_error", "instrumentLogBrewKafkaJsConsumer requires an owned KafkaJS consumer");
  }

  const state = createInstrumentationState(consumer, CONSUMER_INSTRUMENTATION, "KafkaJS consumer");
  state.undo.push(installMethod(consumer, "run", (receiver, [config, ...args]) => {
    if (!isObjectLike(config)) {
      return run.call(receiver, config, ...args);
    }

    const { eachBatch, eachMessage } = config;
    if (!isCallable(eachMessage) && !isCallable(eachBatch)) {
      return run.call(receiver, config, ...args);
    }
    return run.call(
      receiver,
      {
        ...config,
        ...(isCallable(eachMessage) ? { eachMessage: withLogBrewKafkaJsEachMessage(eachMessage, options) } : {}),
        ...(isCallable(eachBatch) ? { eachBatch: withLogBrewKafkaJsEachBatch(eachBatch, options) } : {})
      },
      ...args
    );
  }));

  return state.handle;
}

const defaultExport = {
  createLogBrewKafkaJsMessage,
  createLogBrewKafkaJsProducerBatch,
  createLogBrewKafkaJsProducerRecord,
  extractLogBrewKafkaJsTraceparent,
  instrumentLogBrewKafkaJsConsumer,
  instrumentLogBrewKafkaJsProducer,
  kafkaJsProducerSendBatchWithLogBrewSpan,
  kafkaJsProducerSendWithLogBrewSpan,
  withLogBrewKafkaJsEachBatch,
  withLogBrewKafkaJsEachMessage
};

export {
  createLogBrewKafkaJsMessage,
  createLogBrewKafkaJsProducerBatch,
  createLogBrewKafkaJsProducerRecord,
  extractLogBrewKafkaJsTraceparent,
  instrumentLogBrewKafkaJsConsumer,
  instrumentLogBrewKafkaJsProducer,
  kafkaJsProducerSendBatchWithLogBrewSpan,
  kafkaJsProducerSendWithLogBrewSpan,
  withLogBrewKafkaJsEachBatch,
  withLogBrewKafkaJsEachMessage
};
export default defaultExport;
