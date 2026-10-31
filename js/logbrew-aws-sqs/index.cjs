"use strict";

const {
  createLogBrewEventBridgePutEventsInput,
  createLogBrewSnsPublishBatchInput,
  createLogBrewSnsPublishInput,
  createLogBrewSqsReceiveMessageInput,
  createLogBrewSqsSendMessageBatchInput,
  createLogBrewSqsSendMessageInput
} = require("./inputs.cjs");
const {
  createLogBrewSqsTraceLinks,
  extractLogBrewSqsTraceparent,
  normalizeSqsTraceExtractionOptions
} = require("./trace.cjs");
const {
  isCallable,
  isObject,
  mergeLinks,
  readField,
  readList,
  requireAwsClient,
  requireCommand,
  requireSpanOptions,
  resolveEventBridgeDestinationName,
  resolveQueueName,
  resolveSnsDestinationName
} = require("./internal.cjs");
const { queueBatchOperationWithLogBrewSpan, queueOperationWithLogBrewSpan } = require("@logbrew/node");
const { SdkError } = require("@logbrew/sdk");

/**
 * @import { QueueOperationWithLogBrewSpanOptions } from "@logbrew/node"
 * @import {
 *   LogBrewEventBridgeOperationOptions,
 *   LogBrewSnsBatchOperationOptions,
 *   LogBrewSnsOperationOptions,
 *   LogBrewSqsBatchOperationOptions,
 *   LogBrewSqsInstrumentation,
 *   LogBrewSqsOperationOptions,
 *   LogBrewSqsTraceExtractionOptions
 * } from "./index.cjs"
 * @import { Callable, CommandConstructor, SendClient } from "./internal.cjs"
 */

/**
 * @typedef {Omit<LogBrewSqsOperationOptions, keyof LogBrewSqsTraceExtractionOptions>} SqsSpanOptions
 * @typedef {{
 *   readonly ReceiveMessageCommand: CommandConstructor,
 *   readonly SendMessageBatchCommand: CommandConstructor,
 *   readonly SendMessageCommand: CommandConstructor
 * }} InstrumentationCommands
 */

const DEFAULT_SYSTEM = "aws_sqs";
const DEFAULT_EVENTBRIDGE_SYSTEM = "aws_eventbridge";
const DEFAULT_SNS_SYSTEM = "aws_sns";
const INSTRUMENTED_SEND = Symbol.for("@logbrew/aws-sqs.instrumentedSend");

/**
 * @param {LogBrewSqsOperationOptions | LogBrewSqsBatchOperationOptions} options
 * @returns {{ spanOptions: SqsSpanOptions, traceExtractionOptions: Required<LogBrewSqsTraceExtractionOptions> }}
 */
function splitSqsOptions(options) {
  const {
    extractEventBridgeEnvelopeTraceparent,
    extractSnsEnvelopeTraceparent,
    maxEnvelopeBytes,
    ...spanOptions
  } = options;
  return {
    spanOptions,
    traceExtractionOptions: normalizeSqsTraceExtractionOptions({
      extractEventBridgeEnvelopeTraceparent,
      extractSnsEnvelopeTraceparent,
      maxEnvelopeBytes
    })
  };
}

/**
 * @param {unknown} command
 * @returns {Readonly<Record<string, unknown>>}
 */
function commandInput(command) {
  const input = readField(command, "input");
  return isObject(input) ? input : {};
}

/**
 * @param {unknown} client
 * @param {unknown} SendMessageCommand
 * @param {unknown} [input]
 * @param {LogBrewSqsOperationOptions} [options]
 * @returns {Promise<unknown>}
 */
async function sqsSendMessageWithLogBrewSpan(client, SendMessageCommand, input, options) {
  const sendClient = requireAwsClient(client, "sqsSendMessageWithLogBrewSpan", "SQS");
  const Command = requireCommand(SendMessageCommand, "sqsSendMessageWithLogBrewSpan", "SendMessageCommand");
  const { spanOptions } = splitSqsOptions(requireSpanOptions(options));

  return queueOperationWithLogBrewSpan("SendMessage", {
    ...spanOptions,
    operation: () => sendClient.send(new Command(createLogBrewSqsSendMessageInput(input))),
    operationKind: "publish",
    queueName: resolveQueueName(input, spanOptions.queueName),
    system: DEFAULT_SYSTEM
  });
}

/**
 * @param {unknown} client
 * @param {unknown} SendMessageBatchCommand
 * @param {unknown} [input]
 * @param {LogBrewSqsBatchOperationOptions} [options]
 * @returns {Promise<unknown>}
 */
async function sqsSendMessageBatchWithLogBrewSpan(client, SendMessageBatchCommand, input, options) {
  const sendClient = requireAwsClient(client, "sqsSendMessageBatchWithLogBrewSpan", "SQS");
  const Command = requireCommand(SendMessageBatchCommand, "sqsSendMessageBatchWithLogBrewSpan", "SendMessageBatchCommand");
  const { spanOptions } = splitSqsOptions(requireSpanOptions(options));

  return queueBatchOperationWithLogBrewSpan("SendMessageBatch", {
    ...spanOptions,
    messageCount: readList(readField(input, "Entries")).length,
    operation: () => sendClient.send(new Command(createLogBrewSqsSendMessageBatchInput(input))),
    operationKind: "publish",
    queueName: resolveQueueName(input, spanOptions.queueName),
    system: DEFAULT_SYSTEM
  });
}

/**
 * @param {unknown} client
 * @param {unknown} PublishCommand
 * @param {unknown} [input]
 * @param {LogBrewSnsOperationOptions} [options]
 * @returns {Promise<unknown>}
 */
async function snsPublishWithLogBrewSpan(client, PublishCommand, input, options) {
  const sendClient = requireAwsClient(client, "snsPublishWithLogBrewSpan", "SNS");
  const Command = requireCommand(PublishCommand, "snsPublishWithLogBrewSpan", "PublishCommand");
  const { topicName, ...spanOptions } = requireSpanOptions(options);

  return queueOperationWithLogBrewSpan("Publish", {
    ...spanOptions,
    operation: () => sendClient.send(new Command(createLogBrewSnsPublishInput(input))),
    operationKind: "publish",
    queueName: resolveSnsDestinationName(input, topicName),
    system: DEFAULT_SNS_SYSTEM
  });
}

/**
 * @param {unknown} client
 * @param {unknown} PublishBatchCommand
 * @param {unknown} [input]
 * @param {LogBrewSnsBatchOperationOptions} [options]
 * @returns {Promise<unknown>}
 */
async function snsPublishBatchWithLogBrewSpan(client, PublishBatchCommand, input, options) {
  const sendClient = requireAwsClient(client, "snsPublishBatchWithLogBrewSpan", "SNS");
  const Command = requireCommand(PublishBatchCommand, "snsPublishBatchWithLogBrewSpan", "PublishBatchCommand");
  const { topicName, ...spanOptions } = requireSpanOptions(options);

  return queueBatchOperationWithLogBrewSpan("PublishBatch", {
    ...spanOptions,
    messageCount: readList(readField(input, "PublishBatchRequestEntries")).length,
    operation: () => sendClient.send(new Command(createLogBrewSnsPublishBatchInput(input))),
    operationKind: "publish",
    queueName: resolveSnsDestinationName(input, topicName),
    system: DEFAULT_SNS_SYSTEM
  });
}

/**
 * @param {unknown} client
 * @param {unknown} PutEventsCommand
 * @param {unknown} [input]
 * @param {LogBrewEventBridgeOperationOptions} [options]
 * @returns {Promise<unknown>}
 */
async function eventBridgePutEventsWithLogBrewSpan(client, PutEventsCommand, input, options) {
  const sendClient = requireAwsClient(client, "eventBridgePutEventsWithLogBrewSpan", "EventBridge");
  const Command = requireCommand(PutEventsCommand, "eventBridgePutEventsWithLogBrewSpan", "PutEventsCommand");
  const { eventBusName, maxEventBridgeRequestBytes, maxRequestBytes, ...spanOptions } = requireSpanOptions(options);
  const inputOptions = { maxRequestBytes: maxEventBridgeRequestBytes ?? maxRequestBytes };

  return queueBatchOperationWithLogBrewSpan("PutEvents", {
    ...spanOptions,
    messageCount: readList(readField(input, "Entries")).length,
    operation: () => sendClient.send(new Command(createLogBrewEventBridgePutEventsInput(input, undefined, inputOptions))),
    operationKind: "publish",
    queueName: resolveEventBridgeDestinationName(input, eventBusName),
    system: DEFAULT_EVENTBRIDGE_SYSTEM
  });
}

/**
 * @param {unknown} client
 * @param {unknown} ReceiveMessageCommand
 * @param {unknown} [input]
 * @param {LogBrewSqsOperationOptions} [options]
 * @returns {Promise<unknown>}
 */
async function sqsReceiveMessageWithLogBrewSpan(client, ReceiveMessageCommand, input, options) {
  const sendClient = requireAwsClient(client, "sqsReceiveMessageWithLogBrewSpan", "SQS");
  const Command = requireCommand(ReceiveMessageCommand, "sqsReceiveMessageWithLogBrewSpan", "ReceiveMessageCommand");
  const { spanOptions, traceExtractionOptions } = splitSqsOptions(requireSpanOptions(options));
  /** @type {QueueOperationWithLogBrewSpanOptions} */
  const operationOptions = {
    ...spanOptions,
    operation: async () => {
      const output = await sendClient.send(new Command(createLogBrewSqsReceiveMessageInput(input)));
      const messages = readList(readField(output, "Messages"));
      operationOptions.messageCount = messages.length;
      const links = mergeLinks(
        createLogBrewSqsTraceLinks(messages, { relation: "sqs_receive" }, traceExtractionOptions),
        spanOptions.links
      );
      if (links === undefined) {
        delete operationOptions.links;
      } else {
        operationOptions.links = links;
      }
      return output;
    },
    operationKind: "receive",
    queueName: resolveQueueName(input, spanOptions.queueName),
    system: DEFAULT_SYSTEM
  };

  return queueOperationWithLogBrewSpan("ReceiveMessage", operationOptions);
}

/**
 * @param {unknown} processor
 * @param {LogBrewSqsOperationOptions} [options]
 * @returns {(message: unknown) => Promise<unknown>}
 */
function withLogBrewSqsMessageProcessor(processor, options) {
  if (!isCallable(processor)) {
    throw new SdkError("configuration_error", "withLogBrewSqsMessageProcessor requires a message processor");
  }
  const split = isObject(options) ? splitSqsOptions(options) : undefined;

  return async function logBrewSqsMessageProcessor(message) {
    const { spanOptions, traceExtractionOptions } = requireSpanOptions(split);
    const processOptions = { ...spanOptions };
    Reflect.deleteProperty(processOptions, "traceparent");
    const traceparent = extractLogBrewSqsTraceparent(message, traceExtractionOptions);
    return queueOperationWithLogBrewSpan("ProcessMessage", {
      ...processOptions,
      operation: () => processor(message),
      operationKind: "process",
      queueName: resolveQueueName(message, spanOptions.queueName),
      system: DEFAULT_SYSTEM,
      ...(traceparent === undefined ? {} : { traceparent })
    });
  };
}

/**
 * @param {unknown} commands
 * @returns {InstrumentationCommands}
 */
function requireInstrumentationCommands(commands) {
  if (!isObject(commands)) {
    throw new SdkError("configuration_error", "instrumentLogBrewSqsClient requires SQS command constructors");
  }
  const source = "instrumentLogBrewSqsClient";
  const SendMessageCommand = requireCommand(commands["SendMessageCommand"], source, "SendMessageCommand");
  const SendMessageBatchCommand = requireCommand(commands["SendMessageBatchCommand"], source, "SendMessageBatchCommand");
  const ReceiveMessageCommand = requireCommand(commands["ReceiveMessageCommand"], source, "ReceiveMessageCommand");
  return { ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand };
}

/**
 * @param {SendClient} client
 * @param {InstrumentationCommands} commands
 * @param {LogBrewSqsOperationOptions} options
 * @returns {Callable}
 */
function createInstrumentedSend(client, commands, options) {
  const originalSend = client.send;
  const { ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand } = commands;
  /** @type {Callable} */
  function instrumentedSqsSend(...args) {
    const [command, ...sendArgs] = args;
    /** @type {SendClient} */
    const sendClient = {
      send: (nextCommand) => originalSend.call(client, nextCommand, ...sendArgs)
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
    return originalSend.call(client, ...args);
  }
  return instrumentedSqsSend;
}

/**
 * @param {unknown} client
 * @param {LogBrewSqsOperationOptions | undefined} options
 * @returns {SendClient}
 */
function requireUninstrumentedClient(client, options) {
  const sqsClient = requireAwsClient(client, "instrumentLogBrewSqsClient", "SQS");
  if (!options?.client) {
    throw new SdkError("configuration_error", "instrumentLogBrewSqsClient requires client");
  }
  return sqsClient;
}

/**
 * @param {Callable} originalSend
 * @returns {void}
 */
function assertNotInstrumented(originalSend) {
  if (Reflect.get(originalSend, INSTRUMENTED_SEND) === true) {
    throw new SdkError(
      "configuration_error",
      "instrumentLogBrewSqsClient requires an uninstrumented SQS client; uninstall the existing LogBrew instrumentation first"
    );
  }
}

/**
 * @param {unknown} client
 * @param {unknown} commands
 * @param {LogBrewSqsOperationOptions} [options]
 * @returns {LogBrewSqsInstrumentation}
 */
function instrumentLogBrewSqsClient(client, commands, options) {
  const sqsClient = requireUninstrumentedClient(client, options);
  const validCommands = requireInstrumentationCommands(commands);
  const originalSend = sqsClient.send;
  assertNotInstrumented(originalSend);
  const state = { installed: true };
  const instrumentedSend = createInstrumentedSend(sqsClient, validCommands, requireSpanOptions(options));
  /** @type {Callable} */
  function logBrewInstrumentedSqsSend(...args) {
    return state.installed ? instrumentedSend(...args) : originalSend.call(sqsClient, ...args);
  }
  Object.defineProperty(logBrewInstrumentedSqsSend, INSTRUMENTED_SEND, { value: true });
  Reflect.set(sqsClient, "send", logBrewInstrumentedSqsSend);

  return {
    isInstalled: () => state.installed && sqsClient.send === logBrewInstrumentedSqsSend,
    uninstall: () => {
      state.installed = false;
      if (sqsClient.send === logBrewInstrumentedSqsSend) {
        Reflect.set(sqsClient, "send", originalSend);
      }
    }
  };
}

const api = {
  createLogBrewEventBridgePutEventsInput,
  createLogBrewSnsPublishBatchInput,
  createLogBrewSnsPublishInput,
  createLogBrewSqsReceiveMessageInput,
  createLogBrewSqsSendMessageBatchInput,
  createLogBrewSqsSendMessageInput,
  createLogBrewSqsTraceLinks,
  eventBridgePutEventsWithLogBrewSpan,
  extractLogBrewSqsTraceparent,
  instrumentLogBrewSqsClient,
  snsPublishBatchWithLogBrewSpan,
  snsPublishWithLogBrewSpan,
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan,
  withLogBrewSqsMessageProcessor
};

module.exports = {
  ...api,
  default: api
};
