"use strict";

const { parseTraceparent, SdkError } = require("@logbrew/sdk");
const {
  createLogBrewQueueTraceHeaders,
  createLogBrewQueueTraceLinks,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} = require("@logbrew/node");

const DEFAULT_SYSTEM = "aws_sqs";
const DEFAULT_QUEUE_NAME = "sqs";
const TRACEPARENT_ATTRIBUTE = "traceparent";
const MAX_MESSAGE_ATTRIBUTES = 10;
const DEFAULT_MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const INSTRUMENTED_SEND = Symbol.for("@logbrew/aws-sqs.instrumentedSend");

async function sqsSendMessageWithLogBrewSpan(client, SendMessageCommand, input = {}, options = {}) {
  validateSqsClient(client, "sqsSendMessageWithLogBrewSpan");
  validateCommand(SendMessageCommand, "sqsSendMessageWithLogBrewSpan", "SendMessageCommand");
  const { spanOptions } = splitSqsOptions(options);

  return queueOperationWithLogBrewSpan("SendMessage", {
    ...spanOptions,
    operation: () => client.send(new SendMessageCommand(createLogBrewSqsSendMessageInput(input))),
    operationKind: "publish",
    queueName: resolveQueueName(input, spanOptions.queueName),
    system: DEFAULT_SYSTEM
  });
}

async function sqsSendMessageBatchWithLogBrewSpan(client, SendMessageBatchCommand, input = {}, options = {}) {
  validateSqsClient(client, "sqsSendMessageBatchWithLogBrewSpan");
  validateCommand(SendMessageBatchCommand, "sqsSendMessageBatchWithLogBrewSpan", "SendMessageBatchCommand");
  const { spanOptions } = splitSqsOptions(options);
  const entries = Array.isArray(input?.Entries) ? input.Entries : [];

  return queueBatchOperationWithLogBrewSpan("SendMessageBatch", {
    ...spanOptions,
    messageCount: entries.length,
    operation: () => client.send(new SendMessageBatchCommand(createLogBrewSqsSendMessageBatchInput(input))),
    operationKind: "publish",
    queueName: resolveQueueName(input, spanOptions.queueName),
    system: DEFAULT_SYSTEM
  });
}

async function sqsReceiveMessageWithLogBrewSpan(client, ReceiveMessageCommand, input = {}, options = {}) {
  validateSqsClient(client, "sqsReceiveMessageWithLogBrewSpan");
  validateCommand(ReceiveMessageCommand, "sqsReceiveMessageWithLogBrewSpan", "ReceiveMessageCommand");
  const { spanOptions, traceExtractionOptions } = splitSqsOptions(options);
  const operationOptions = {
    ...spanOptions,
    operation: async () => {
      const output = await client.send(new ReceiveMessageCommand(createLogBrewSqsReceiveMessageInput(input)));
      const messages = Array.isArray(output?.Messages) ? output.Messages : [];
      operationOptions.messageCount = messages.length;
      operationOptions.links = mergeLinks(
        createLogBrewSqsTraceLinks(messages, { relation: "sqs_receive" }, traceExtractionOptions),
        spanOptions.links
      );
      return output;
    },
    operationKind: "receive",
    queueName: resolveQueueName(input, spanOptions.queueName),
    system: DEFAULT_SYSTEM
  };

  return queueOperationWithLogBrewSpan("ReceiveMessage", operationOptions);
}

function withLogBrewSqsMessageProcessor(processor, options = {}) {
  if (typeof processor !== "function") {
    throw new SdkError("configuration_error", "withLogBrewSqsMessageProcessor requires a message processor");
  }
  const { spanOptions, traceExtractionOptions } = splitSqsOptions(options);

  return async function logBrewSqsMessageProcessor(message) {
    return queueOperationWithLogBrewSpan("ProcessMessage", {
      ...spanOptions,
      operation: () => processor(message),
      operationKind: "process",
      queueName: resolveQueueName(message, spanOptions.queueName),
      system: DEFAULT_SYSTEM,
      traceparent: extractLogBrewSqsTraceparent(message, traceExtractionOptions)
    });
  };
}

function instrumentLogBrewSqsClient(client, commands, options = {}) {
  validateSqsClient(client, "instrumentLogBrewSqsClient");
  validateInstrumentationOptions(options);
  const {
    ReceiveMessageCommand,
    SendMessageBatchCommand,
    SendMessageCommand
  } = validateInstrumentationCommands(commands);
  const originalSend = client.send;
  if (originalSend?.[INSTRUMENTED_SEND] === true) {
    throw new SdkError(
      "configuration_error",
      "instrumentLogBrewSqsClient requires an uninstrumented SQS client; uninstall the existing LogBrew instrumentation first"
    );
  }

  let installed = true;
  function logBrewInstrumentedSqsSend(command, ...args) {
    if (!installed) {
      return originalSend.call(client, command, ...args);
    }
    const sendClient = {
      send(nextCommand) {
        return originalSend.call(client, nextCommand, ...args);
      }
    };

    if (command instanceof SendMessageCommand) {
      return sqsSendMessageWithLogBrewSpan(sendClient, SendMessageCommand, commandInput(command), options);
    }
    if (command instanceof SendMessageBatchCommand) {
      return sqsSendMessageBatchWithLogBrewSpan(sendClient, SendMessageBatchCommand, commandInput(command), options);
    }
    if (command instanceof ReceiveMessageCommand) {
      return sqsReceiveMessageWithLogBrewSpan(sendClient, ReceiveMessageCommand, commandInput(command), options);
    }
    return originalSend.call(client, command, ...args);
  }

  Object.defineProperty(logBrewInstrumentedSqsSend, INSTRUMENTED_SEND, {
    value: true
  });
  client.send = logBrewInstrumentedSqsSend;

  return {
    isInstalled() {
      return installed && client.send === logBrewInstrumentedSqsSend;
    },
    uninstall() {
      installed = false;
      if (client.send === logBrewInstrumentedSqsSend) {
        client.send = originalSend;
      }
    }
  };
}

function createLogBrewSqsSendMessageInput(input = {}, traceparent = undefined) {
  const source = cloneObject(input);
  return {
    ...source,
    MessageAttributes: withTraceparentAttribute(source.MessageAttributes, traceparent)
  };
}

function createLogBrewSqsSendMessageBatchInput(input = {}, traceparent = undefined) {
  const source = cloneObject(input);
  const normalizedTraceparent = normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);
  const entries = Array.isArray(source.Entries)
    ? source.Entries.map((entry) => {
      const nextEntry = cloneObject(entry);
      return {
        ...nextEntry,
        MessageAttributes: withTraceparentAttribute(nextEntry.MessageAttributes, normalizedTraceparent)
      };
    })
    : source.Entries;

  return {
    ...source,
    ...(entries !== undefined ? { Entries: entries } : {})
  };
}

function createLogBrewSqsReceiveMessageInput(input = {}) {
  const source = cloneObject(input);
  return {
    ...source,
    MessageAttributeNames: withTraceparentAttributeName(source.MessageAttributeNames)
  };
}

function createLogBrewSqsTraceLinks(messages, metadata = undefined, options = {}) {
  const carriers = Array.isArray(messages)
    ? messages.map((message) => sqsMessageTraceCarrier(message, options))
    : [sqsMessageTraceCarrier(messages, options)];
  return createLogBrewQueueTraceLinks(carriers, metadata);
}

function extractLogBrewSqsTraceparent(messageOrAttributes, options = {}) {
  const traceparent = normalizeTraceparent(readSqsAttributeValue(readSqsAttributes(messageOrAttributes), TRACEPARENT_ATTRIBUTE));
  if (traceparent) {
    return traceparent;
  }
  const traceExtractionOptions = normalizeSqsTraceExtractionOptions(options);
  if (!traceExtractionOptions.extractSnsEnvelopeTraceparent && !traceExtractionOptions.extractEventBridgeEnvelopeTraceparent) {
    return undefined;
  }
  return extractEnvelopeTraceparent(messageOrAttributes, traceExtractionOptions);
}

function withTraceparentAttribute(attributes, traceparent = undefined) {
  const nextAttributes = cloneObject(attributes);
  const normalizedTraceparent = normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);
  if (!normalizedTraceparent) {
    return nextAttributes;
  }
  if (!hasOwn(nextAttributes, TRACEPARENT_ATTRIBUTE) && Object.keys(nextAttributes).length >= MAX_MESSAGE_ATTRIBUTES) {
    return nextAttributes;
  }
  return {
    ...nextAttributes,
    [TRACEPARENT_ATTRIBUTE]: {
      DataType: "String",
      StringValue: normalizedTraceparent
    }
  };
}

function withTraceparentAttributeName(attributeNames) {
  const names = Array.isArray(attributeNames)
    ? attributeNames.filter((name) => typeof name === "string" && name.trim() !== "")
    : [];
  if (names.includes("All") || names.includes(".*") || names.includes(TRACEPARENT_ATTRIBUTE)) {
    return names.length > 0 ? names : [TRACEPARENT_ATTRIBUTE];
  }
  return [...names, TRACEPARENT_ATTRIBUTE];
}

function sqsMessageTraceCarrier(message, options = {}) {
  const traceparent = extractLogBrewSqsTraceparent(message, options);
  return traceparent ? { traceparent } : undefined;
}

function splitSqsOptions(options) {
  const {
    extractEventBridgeEnvelopeTraceparent,
    extractSnsEnvelopeTraceparent,
    maxEnvelopeBytes,
    ...spanOptions
  } = isObject(options) ? options : {};
  return {
    spanOptions,
    traceExtractionOptions: normalizeSqsTraceExtractionOptions({
      extractEventBridgeEnvelopeTraceparent,
      extractSnsEnvelopeTraceparent,
      maxEnvelopeBytes
    })
  };
}

function normalizeSqsTraceExtractionOptions(options = {}) {
  return {
    extractEventBridgeEnvelopeTraceparent: options.extractEventBridgeEnvelopeTraceparent === true,
    extractSnsEnvelopeTraceparent: options.extractSnsEnvelopeTraceparent === true,
    maxEnvelopeBytes: normalizeEnvelopeByteLimit(options.maxEnvelopeBytes)
  };
}

function extractEnvelopeTraceparent(messageOrEnvelope, options) {
  const envelope = readSqsEnvelope(messageOrEnvelope, options.maxEnvelopeBytes);
  if (!isObject(envelope)) {
    return undefined;
  }
  if (options.extractSnsEnvelopeTraceparent) {
    const snsTraceparent = readSnsEnvelopeTraceparent(envelope);
    if (snsTraceparent) {
      return snsTraceparent;
    }
  }
  if (options.extractEventBridgeEnvelopeTraceparent) {
    return readEventBridgeEnvelopeTraceparent(envelope, options);
  }
  return undefined;
}

function readSqsEnvelope(messageOrEnvelope, maxEnvelopeBytes) {
  if (typeof messageOrEnvelope === "string") {
    return parseJsonEnvelope(messageOrEnvelope, maxEnvelopeBytes);
  }
  if (!isObject(messageOrEnvelope)) {
    return undefined;
  }
  if (typeof messageOrEnvelope.Body === "string") {
    return parseJsonEnvelope(messageOrEnvelope.Body, maxEnvelopeBytes);
  }
  return messageOrEnvelope;
}

function readSnsEnvelopeTraceparent(envelope) {
  if (!isSnsEnvelope(envelope)) {
    return undefined;
  }
  return normalizeTraceparent(readSqsAttributeValue(envelope.MessageAttributes, TRACEPARENT_ATTRIBUTE));
}

function readEventBridgeEnvelopeTraceparent(envelope, options) {
  const direct = readEventBridgeDetailTraceparent(envelope);
  if (direct) {
    return direct;
  }
  if (!isSnsEnvelope(envelope) || typeof envelope.Message !== "string") {
    return undefined;
  }
  return readEventBridgeDetailTraceparent(parseJsonEnvelope(envelope.Message, options.maxEnvelopeBytes));
}

function readEventBridgeDetailTraceparent(envelope) {
  if (!isObject(envelope) || typeof envelope["detail-type"] !== "string" || !isObject(envelope.detail)) {
    return undefined;
  }
  const detail = envelope.detail;
  return normalizeTraceparent(detail.traceparent ?? detail.traceParent);
}

function parseJsonEnvelope(value, maxEnvelopeBytes) {
  if (typeof value !== "string" || value.trim() === "" || utf8ByteLength(value) > maxEnvelopeBytes) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEnvelopeByteLimit(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_ENVELOPE_BYTES;
  }
  return Math.min(Math.floor(value), MAX_ENVELOPE_BYTES);
}

function utf8ByteLength(value) {
  if (typeof globalThis.Buffer?.byteLength === "function") {
    return globalThis.Buffer.byteLength(value, "utf8");
  }
  if (typeof globalThis.TextEncoder === "function") {
    return new globalThis.TextEncoder().encode(value).byteLength;
  }
  return value.length;
}

function isSnsEnvelope(value) {
  return isObject(value) && value.Type === "Notification";
}

function readSqsAttributes(messageOrAttributes) {
  if (!isObject(messageOrAttributes)) {
    return undefined;
  }
  if (isObject(messageOrAttributes.MessageAttributes)) {
    return messageOrAttributes.MessageAttributes;
  }
  return messageOrAttributes;
}

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
  return matchedKey ? readOneSqsAttributeValue(attributes[matchedKey]) : undefined;
}

function readOneSqsAttributeValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!isObject(value)) {
    return undefined;
  }
  if (typeof value.StringValue === "string") {
    return value.StringValue;
  }
  if (typeof value.Value === "string") {
    return value.Value;
  }
  return readBytesAsUtf8(value.BinaryValue);
}

function readBytesAsUtf8(value) {
  if (isNodeBufferValue(value)) {
    return value.toString("utf8");
  }
  if (value instanceof Uint8Array && typeof globalThis.TextDecoder === "function") {
    return new globalThis.TextDecoder().decode(value);
  }
  return undefined;
}

function mergeLinks(generatedLinks, explicitLinks) {
  const links = Array.isArray(generatedLinks) ? [...generatedLinks] : [];
  if (Array.isArray(explicitLinks)) {
    links.push(...explicitLinks);
  }
  return links.length > 0 ? links.slice(0, 8) : undefined;
}

function resolveQueueName(source, fallback) {
  const explicit = normalizeLabel(fallback, "");
  if (explicit) {
    return explicit;
  }
  const queueUrl = normalizeLabel(source?.QueueUrl, "");
  if (!queueUrl) {
    return DEFAULT_QUEUE_NAME;
  }
  const parts = queueUrl.split("/").filter(Boolean);
  return normalizeLabel(parts[parts.length - 1], DEFAULT_QUEUE_NAME);
}

function validateSqsClient(client, source) {
  if (!client || typeof client.send !== "function") {
    throw new SdkError("configuration_error", `${source} requires an AWS SDK SQS client`);
  }
}

function validateCommand(Command, source, name) {
  if (typeof Command !== "function") {
    throw new SdkError("configuration_error", `${source} requires ${name}`);
  }
}

function validateInstrumentationOptions(options) {
  if (!options?.client) {
    throw new SdkError("configuration_error", "instrumentLogBrewSqsClient requires client");
  }
}

function validateInstrumentationCommands(commands) {
  if (!isObject(commands)) {
    throw new SdkError("configuration_error", "instrumentLogBrewSqsClient requires SQS command constructors");
  }
  validateCommand(commands.SendMessageCommand, "instrumentLogBrewSqsClient", "SendMessageCommand");
  validateCommand(commands.SendMessageBatchCommand, "instrumentLogBrewSqsClient", "SendMessageBatchCommand");
  validateCommand(commands.ReceiveMessageCommand, "instrumentLogBrewSqsClient", "ReceiveMessageCommand");
  return commands;
}

function commandInput(command) {
  return isObject(command?.input) ? command.input : {};
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

function normalizeLabel(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function cloneObject(value) {
  return isObject(value) ? { ...value } : {};
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
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

const api = {
  createLogBrewSqsReceiveMessageInput,
  createLogBrewSqsSendMessageBatchInput,
  createLogBrewSqsSendMessageInput,
  createLogBrewSqsTraceLinks,
  extractLogBrewSqsTraceparent,
  instrumentLogBrewSqsClient,
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan,
  withLogBrewSqsMessageProcessor
};

module.exports = {
  ...api,
  default: api
};
