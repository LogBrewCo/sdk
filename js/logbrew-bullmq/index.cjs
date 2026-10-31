"use strict";

const {
  createLogBrewBullMqFlowJob,
  createLogBrewBullMqJobOptions,
  extractLogBrewBullMqTraceparent
} = require("./jobs.cjs");
const { callBullMqFlowProducerAdd, processWithLogBrewBullMqSpan } = require("./process.cjs");
const {
  instrumentLogBrewBullMqFlowProducer,
  instrumentLogBrewBullMqProcessor,
  instrumentLogBrewBullMqQueue
} = require("./instrument.cjs");
const { flowAddWithLogBrewSpan, queueAddBulkWithLogBrewSpan, queueAddWithLogBrewSpan } = require("./producer.cjs");
const { isCallable, requireMethod } = require("./internal.cjs");
const { SdkError } = require("@logbrew/sdk");

/**
 * @import { LogBrewBullMqSpanOptions } from "./index.cjs"
 */

/**
 * @param {unknown} queue
 * @param {unknown} name
 * @param {unknown} data
 * @param {unknown} [jobOptions]
 * @param {LogBrewBullMqSpanOptions | null} [options]
 * @returns {Promise<unknown>}
 */
async function bullMqQueueAddWithLogBrewSpan(queue, name, data, jobOptions, options) {
  const { method: add, owner } = requireMethod(queue, "add", "bullMqQueueAddWithLogBrewSpan requires a BullMQ queue");
  return queueAddWithLogBrewSpan({
    add: (nextJobOptions) => Reflect.apply(add, owner, [name, data, nextJobOptions]),
    jobOptions,
    name,
    options,
    queue: owner
  });
}

/**
 * @param {unknown} queue
 * @param {unknown} jobs
 * @param {LogBrewBullMqSpanOptions | null} [options]
 * @returns {Promise<unknown>}
 */
async function bullMqQueueAddBulkWithLogBrewSpan(queue, jobs, options) {
  const { method: addBulk, owner } = requireMethod(
    queue,
    "addBulk",
    "bullMqQueueAddBulkWithLogBrewSpan requires a BullMQ queue with addBulk"
  );
  return queueAddBulkWithLogBrewSpan({
    addBulk: (nextJobs) => Reflect.apply(addBulk, owner, [nextJobs]),
    jobs,
    options,
    queue: owner
  });
}

/**
 * @param {unknown} flowProducer
 * @param {unknown} flow
 * @param {unknown} [flowOptions]
 * @param {LogBrewBullMqSpanOptions | null} [options]
 * @returns {Promise<unknown>}
 */
async function bullMqFlowProducerAddWithLogBrewSpan(flowProducer, flow, flowOptions, options) {
  const { method: add, owner } = requireMethod(
    flowProducer,
    "add",
    "bullMqFlowProducerAddWithLogBrewSpan requires a BullMQ FlowProducer"
  );
  return flowAddWithLogBrewSpan({
    add: (flowJob) => callBullMqFlowProducerAdd(add, owner, [flowJob, flowOptions]),
    flow,
    options
  });
}

/**
 * @param {unknown} processor
 * @param {LogBrewBullMqSpanOptions | null} [options]
 * @returns {(job: unknown, lock: unknown, signal: unknown) => Promise<unknown>}
 */
function withLogBrewBullMqProcessor(processor, options) {
  if (!isCallable(processor)) {
    throw new SdkError("configuration_error", "withLogBrewBullMqProcessor requires a processor function");
  }
  return async function logBrewBullMqProcessor(job, lock, signal) {
    return processWithLogBrewBullMqSpan(job, () => processor(job, lock, signal), options);
  };
}

const api = {
  bullMqFlowProducerAddWithLogBrewSpan,
  bullMqQueueAddBulkWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  createLogBrewBullMqFlowJob,
  createLogBrewBullMqJobOptions,
  extractLogBrewBullMqTraceparent,
  instrumentLogBrewBullMqFlowProducer,
  instrumentLogBrewBullMqProcessor,
  instrumentLogBrewBullMqQueue,
  withLogBrewBullMqProcessor
};

module.exports = { ...api, default: api };
