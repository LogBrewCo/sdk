"use strict";

const { countBullMqFlowJobs, createLogBrewBullMqBulkJob, createLogBrewBullMqFlowJob, createLogBrewBullMqJobOptions } =
  require("./jobs.cjs");
const { isList, missingClientError, normalizeName, readField, resolveQueueName } = require("./internal.cjs");
const { queueBatchOperationWithLogBrewSpan, queueOperationWithLogBrewSpan } = require("@logbrew/node");
const { DEFAULT_SYSTEM } = require("./process.cjs");

/**
 * @import { LogBrewBullMqSpanOptions } from "./index.cjs"
 * @typedef {LogBrewBullMqSpanOptions | null | undefined} SpanOptionsInput
 * @typedef {{
 *   readonly add: (jobOptions: Readonly<Record<string, unknown>>) => unknown,
 *   readonly jobOptions: unknown,
 *   readonly name: unknown,
 *   readonly options: SpanOptionsInput,
 *   readonly queue: unknown
 * }} QueueAddRequest
 * @typedef {{
 *   readonly addBulk: (jobs: readonly Readonly<Record<string, unknown>>[]) => unknown,
 *   readonly jobs: unknown,
 *   readonly options: SpanOptionsInput,
 *   readonly queue: unknown
 * }} QueueAddBulkRequest
 * @typedef {{
 *   readonly add: (flow: Readonly<Record<string, unknown>>) => unknown,
 *   readonly flow: unknown,
 *   readonly options: SpanOptionsInput
 * }} FlowAddRequest
 */

/**
 * @param {QueueAddRequest} request
 * @returns {Promise<unknown>}
 */
async function queueAddWithLogBrewSpan(request) {
  const { add, jobOptions, name, options, queue } = request;
  const taskName = normalizeName(name, "job");
  const queueName = resolveQueueName(queue, options?.queueName);
  if (options === null || options === undefined) {
    throw missingClientError();
  }
  return queueOperationWithLogBrewSpan("add", {
    ...options,
    operation: () => add(createLogBrewBullMqJobOptions(jobOptions)),
    operationKind: "publish",
    queueName,
    system: DEFAULT_SYSTEM,
    taskName
  });
}

/**
 * @param {QueueAddBulkRequest} request
 * @returns {Promise<unknown>}
 */
async function queueAddBulkWithLogBrewSpan(request) {
  const { addBulk, jobs, options, queue } = request;
  const queueName = resolveQueueName(queue, options?.queueName);
  if (options === null || options === undefined) {
    throw missingClientError();
  }
  const jobList = isList(jobs) ? jobs : [];
  return queueBatchOperationWithLogBrewSpan("addBulk", {
    ...options,
    messageCount: jobList.length,
    operation: () => addBulk(jobList.map((job) => createLogBrewBullMqBulkJob(job))),
    operationKind: "publish",
    queueName,
    system: DEFAULT_SYSTEM
  });
}

/**
 * @param {FlowAddRequest} request
 * @returns {Promise<unknown>}
 */
async function flowAddWithLogBrewSpan(request) {
  const { add, flow, options } = request;
  const taskName = normalizeName(readField(flow, "name"), "flow");
  const queueName = resolveQueueName({ name: readField(flow, "queueName") }, options?.queueName);
  if (options === null || options === undefined) {
    throw missingClientError();
  }
  return queueBatchOperationWithLogBrewSpan("add", {
    ...options,
    messageCount: countBullMqFlowJobs(flow),
    operation: () => add(createLogBrewBullMqFlowJob(flow)),
    operationKind: "publish",
    queueName,
    system: DEFAULT_SYSTEM,
    taskName
  });
}

module.exports = {
  flowAddWithLogBrewSpan,
  queueAddBulkWithLogBrewSpan,
  queueAddWithLogBrewSpan
};
