"use strict";

const { hasFields, isCallable, isObject, missingClientError, normalizeName, readField, resolveQueueName } = require("./internal.cjs");
const { extractLogBrewBullMqTraceparent } = require("./jobs.cjs");
const { captureLogBrewLog, queueOperationWithLogBrewSpan } = require("@logbrew/node");

/**
 * @import { LogBrewClient } from "@logbrew/sdk"
 * @import { LogBrewBullMqSpanOptions } from "./index.cjs"
 * @import { Callable } from "./internal.cjs"
 * @typedef {LogBrewBullMqSpanOptions["metadata"]} SpanMetadata
 * @typedef {Readonly<NonNullable<SpanMetadata>> | undefined} SpanMetadataInput
 */

const DEFAULT_SYSTEM = "bullmq";
const ATTEMPTS_MADE_KEY = "bullmq.job.attempts.made";
const NO_ATTEMPTS = 0;
const FLOW_ADD_ARGUMENTS = 2;

/**
 * @param {unknown} job
 * @returns {unknown}
 */
function readAttemptsMade(job) {
  try {
    return readField(job, "attemptsMade");
  } catch {
    return undefined;
  }
}

/**
 * @param {SpanMetadataInput} metadata
 * @returns {SpanMetadata}
 */
function cloneMetadata(metadata) {
  try {
    return isObject(metadata) ? { ...metadata } : {};
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} job
 * @param {SpanMetadataInput} metadata
 * @returns {SpanMetadata}
 */
function createBullMqProcessorMetadata(job, metadata) {
  const nextMetadata = cloneMetadata(metadata);
  if (nextMetadata === undefined) {
    return undefined;
  }
  const attemptsMade = readAttemptsMade(job);
  if (typeof attemptsMade === "number" && Number.isSafeInteger(attemptsMade) && attemptsMade >= NO_ATTEMPTS) {
    nextMetadata[ATTEMPTS_MADE_KEY] = attemptsMade;
  }
  return nextMetadata;
}

/**
 * @param {Callable} log
 * @param {object} job
 * @param {Readonly<{ client: LogBrewClient, metadata: Readonly<{ jobName: string, queueName: string }> }>} target
 * @returns {(...args: readonly unknown[]) => unknown}
 */
function createJobLog(log, job, { client, metadata }) {
  return (...args) => {
    const [line] = args;
    captureLogBrewLog(client, { logger: "bullmq", message: typeof line === "string" ? line : "", metadata });
    return Reflect.apply(log, job, args);
  };
}

/**
 * @param {unknown} job
 * @param {LogBrewClient} client
 * @param {Readonly<{ queueName: string, taskName: string }>} names
 * @returns {void}
 */
function captureJobLogs(job, client, { queueName, taskName }) {
  const log = readField(job, "log");
  if (!hasFields(job) || !isCallable(log) || Object.hasOwn(job, "log")) {
    return;
  }
  const value = createJobLog(log, job, { client, metadata: { jobName: taskName, queueName } });
  Reflect.defineProperty(job, "log", { configurable: true, value, writable: true });
}

/**
 * @template Result
 * @param {unknown} job
 * @param {() => Result | Promise<Result>} operation
 * @param {LogBrewBullMqSpanOptions | null | undefined} options
 * @returns {Promise<Awaited<Result>>}
 */
async function processWithLogBrewBullMqSpan(job, operation, options) {
  const queueName = resolveQueueName(readField(job, "queue"), options?.queueName ?? readField(job, "queueName"));
  const taskName = normalizeName(readField(job, "name"), "job");
  const traceparent = extractLogBrewBullMqTraceparent(job);
  if (options === null || options === undefined) {
    throw missingClientError();
  }
  const spanOptions = { ...options };
  Reflect.deleteProperty(spanOptions, "traceparent");
  const metadata = createBullMqProcessorMetadata(job, spanOptions.metadata);
  Reflect.deleteProperty(spanOptions, "metadata");
  return queueOperationWithLogBrewSpan("process", {
    ...spanOptions,
    ...(metadata === undefined ? {} : { metadata }),
    async operation() {
      captureJobLogs(job, spanOptions.client, { queueName, taskName });
      return operation();
    },
    operationKind: "process",
    queueName,
    system: DEFAULT_SYSTEM,
    taskName,
    ...(traceparent === undefined ? {} : { traceparent })
  });
}

/**
 * @param {Callable} add
 * @param {unknown} receiver
 * @param {readonly unknown[]} args
 * @returns {unknown}
 */
function callBullMqFlowProducerAdd(add, receiver, args) {
  const [flow, flowOptions] = args;
  if (flowOptions === undefined && args.length <= FLOW_ADD_ARGUMENTS) {
    return Reflect.apply(add, receiver, [flow]);
  }
  return Reflect.apply(add, receiver, args);
}

module.exports = {
  DEFAULT_SYSTEM,
  callBullMqFlowProducerAdd,
  processWithLogBrewBullMqSpan
};
