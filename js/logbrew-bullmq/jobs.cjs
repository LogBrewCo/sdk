"use strict";

const { cloneObject, isList, isObject, normalizeTraceparent, readField } = require("./internal.cjs");
const { createLogBrewQueueTraceHeaders } = require("@logbrew/node");

const LOGBREW_METADATA_KEY = "logbrew";
const NO_JOBS = 0;
const ROOT_JOB = 1;

/**
 * @param {unknown} metadata
 * @returns {Readonly<Record<string, unknown>> | undefined}
 */
function parseTelemetryMetadata(metadata) {
  if (metadata === undefined || metadata === null || metadata === "") {
    return {};
  }
  if (isObject(metadata)) {
    return { ...metadata };
  }
  if (typeof metadata !== "string") {
    return undefined;
  }
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(metadata);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} existingMetadata
 * @param {string} traceparent
 * @returns {string | undefined}
 */
function mergeLogBrewTraceparentMetadata(existingMetadata, traceparent) {
  const metadata = existingMetadata === undefined || existingMetadata === ""
    ? {}
    : parseTelemetryMetadata(existingMetadata);
  if (metadata === undefined) {
    return undefined;
  }
  return JSON.stringify({
    ...metadata,
    [LOGBREW_METADATA_KEY]: {
      ...cloneObject(metadata[LOGBREW_METADATA_KEY]),
      traceparent
    }
  });
}

/**
 * @param {unknown} [jobOptions]
 * @param {string} [traceparent]
 * @returns {Record<string, unknown>}
 */
function createLogBrewBullMqJobOptions(jobOptions, traceparent) {
  const nextOptions = cloneObject(jobOptions);
  const normalizedTraceparent = normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);
  if (normalizedTraceparent === undefined) {
    return nextOptions;
  }
  const telemetry = cloneObject(nextOptions["telemetry"]);
  const metadata = mergeLogBrewTraceparentMetadata(telemetry["metadata"], normalizedTraceparent);
  if (metadata === undefined) {
    return nextOptions;
  }
  return {
    ...nextOptions,
    telemetry: {
      ...telemetry,
      metadata
    }
  };
}

/**
 * @param {unknown} flow
 * @param {string} [traceparent]
 * @returns {Record<string, unknown>}
 */
function createLogBrewBullMqFlowJob(flow, traceparent) {
  const source = cloneObject(flow);
  const { children: sourceChildren } = source;
  const children = isList(sourceChildren)
    ? sourceChildren.map((child) => createLogBrewBullMqFlowJob(child, traceparent))
    : sourceChildren;
  return {
    ...source,
    ...(children === undefined ? {} : { children }),
    opts: createLogBrewBullMqJobOptions(source["opts"], traceparent)
  };
}

/**
 * @param {unknown} job
 * @returns {Record<string, unknown>}
 */
function createLogBrewBullMqBulkJob(job) {
  const source = cloneObject(job);
  return {
    ...source,
    opts: createLogBrewBullMqJobOptions(source["opts"])
  };
}

/**
 * @param {unknown} job
 * @returns {string | undefined}
 */
function extractLogBrewBullMqTraceparent(job) {
  const telemetry = readField(readField(job, "opts"), "telemetry");
  const metadata = parseTelemetryMetadata(readField(telemetry, "metadata"));
  return normalizeTraceparent(readField(readField(metadata, LOGBREW_METADATA_KEY), "traceparent"));
}

/**
 * @param {unknown} flow
 * @returns {number}
 */
function countBullMqFlowJobs(flow) {
  if (!isObject(flow)) {
    return NO_JOBS;
  }
  const { children } = flow;
  let count = ROOT_JOB;
  for (const child of isList(children) ? children : []) {
    count += countBullMqFlowJobs(child);
  }
  return count;
}

module.exports = {
  countBullMqFlowJobs,
  createLogBrewBullMqBulkJob,
  createLogBrewBullMqFlowJob,
  createLogBrewBullMqJobOptions,
  extractLogBrewBullMqTraceparent
};
