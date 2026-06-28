import { parseTraceparent, SdkError } from "@logbrew/sdk";
import {
  createLogBrewQueueTraceHeaders,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
} from "@logbrew/node";

const DEFAULT_SYSTEM = "bullmq";
const DEFAULT_QUEUE_NAME = "bullmq";
const LOGBREW_METADATA_KEY = "logbrew";
const INSTRUMENTED_QUEUE_ADD = Symbol.for("@logbrew/bullmq.instrumentedQueueAdd");

export async function bullMqQueueAddWithLogBrewSpan(queue, name, data, jobOptions = {}, options = {}) {
  if (!queue || typeof queue.add !== "function") {
    throw new SdkError("configuration_error", "bullMqQueueAddWithLogBrewSpan requires a BullMQ queue");
  }
  const taskName = normalizeName(name, "job");
  const queueName = resolveQueueName(queue, options.queueName);

  return queueOperationWithLogBrewSpan("add", {
    ...options,
    operation: () => queue.add(name, data, createLogBrewBullMqJobOptions(jobOptions)),
    operationKind: "publish",
    queueName,
    system: DEFAULT_SYSTEM,
    taskName
  });
}

export async function bullMqQueueAddBulkWithLogBrewSpan(queue, jobs, options = {}) {
  if (!queue || typeof queue.addBulk !== "function") {
    throw new SdkError("configuration_error", "bullMqQueueAddBulkWithLogBrewSpan requires a BullMQ queue with addBulk");
  }
  const queueName = resolveQueueName(queue, options.queueName);
  const jobList = Array.isArray(jobs) ? jobs : [];

  return queueBatchOperationWithLogBrewSpan("addBulk", {
    ...options,
    messageCount: jobList.length,
    operation: () => queue.addBulk(jobList.map((job) => createLogBrewBullMqBulkJob(job))),
    operationKind: "publish",
    queueName,
    system: DEFAULT_SYSTEM
  });
}

export function withLogBrewBullMqProcessor(processor, options = {}) {
  if (typeof processor !== "function") {
    throw new SdkError("configuration_error", "withLogBrewBullMqProcessor requires a processor function");
  }

  return async function logBrewBullMqProcessor(job, lock, signal) {
    const queueName = resolveQueueName(job?.queue, options.queueName ?? job?.queueName);
    const taskName = normalizeName(job?.name, "job");
    return queueOperationWithLogBrewSpan("process", {
      ...options,
      operation: () => processor(job, lock, signal),
      operationKind: "process",
      queueName,
      system: DEFAULT_SYSTEM,
      taskName,
      traceparent: extractLogBrewBullMqTraceparent(job)
    });
  };
}

export function instrumentLogBrewBullMqQueue(queue, options = {}) {
  if (!queue || typeof queue.add !== "function") {
    throw new SdkError("configuration_error", "instrumentLogBrewBullMqQueue requires a BullMQ queue");
  }
  const originalAdd = queue.add;
  const originalAddBulk = queue.addBulk;
  if (originalAdd?.[INSTRUMENTED_QUEUE_ADD] === true) {
    throw new SdkError(
      "configuration_error",
      "instrumentLogBrewBullMqQueue requires an uninstrumented BullMQ queue; uninstall the existing LogBrew instrumentation first"
    );
  }

  let installed = true;
  function logBrewInstrumentedBullMqAdd(name, data, jobOptions, ...args) {
    if (!installed) {
      return originalAdd.call(queue, name, data, jobOptions, ...args);
    }
    return bullMqQueueAddWithLogBrewSpan({
      name: queue.name,
      add(nextName, nextData, nextJobOptions) {
        return originalAdd.call(queue, nextName, nextData, nextJobOptions, ...args);
      }
    }, name, data, jobOptions, options);
  }

  Object.defineProperty(logBrewInstrumentedBullMqAdd, INSTRUMENTED_QUEUE_ADD, {
    value: true
  });
  queue.add = logBrewInstrumentedBullMqAdd;

  let logBrewInstrumentedBullMqAddBulk;
  if (typeof originalAddBulk === "function") {
    logBrewInstrumentedBullMqAddBulk = function logBrewInstrumentedBullMqAddBulk(jobs, ...args) {
      if (!installed) {
        return originalAddBulk.call(queue, jobs, ...args);
      }
      return bullMqQueueAddBulkWithLogBrewSpan({
        name: queue.name,
        addBulk(nextJobs) {
          return originalAddBulk.call(queue, nextJobs, ...args);
        }
      }, jobs, options);
    };
    queue.addBulk = logBrewInstrumentedBullMqAddBulk;
  }

  return {
    isInstalled() {
      return installed && queue.add === logBrewInstrumentedBullMqAdd;
    },
    uninstall() {
      installed = false;
      if (queue.add === logBrewInstrumentedBullMqAdd) {
        queue.add = originalAdd;
      }
      if (logBrewInstrumentedBullMqAddBulk && queue.addBulk === logBrewInstrumentedBullMqAddBulk) {
        queue.addBulk = originalAddBulk;
      }
    }
  };
}

export function createLogBrewBullMqJobOptions(jobOptions = {}, traceparent = undefined) {
  const nextOptions = cloneObject(jobOptions);
  const normalizedTraceparent = normalizeTraceparent(traceparent ?? createLogBrewQueueTraceHeaders().traceparent);
  if (!normalizedTraceparent) {
    return nextOptions;
  }

  const telemetry = cloneObject(nextOptions.telemetry);
  const metadata = mergeLogBrewTraceparentMetadata(telemetry.metadata, normalizedTraceparent);
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

export function extractLogBrewBullMqTraceparent(job) {
  const metadata = parseTelemetryMetadata(job?.opts?.telemetry?.metadata);
  const value = metadata?.[LOGBREW_METADATA_KEY]?.traceparent;
  return normalizeTraceparent(value);
}

function createLogBrewBullMqBulkJob(job) {
  const source = cloneObject(job);
  return {
    ...source,
    opts: createLogBrewBullMqJobOptions(source.opts)
  };
}

function mergeLogBrewTraceparentMetadata(existingMetadata, traceparent) {
  const metadata = existingMetadata === undefined || existingMetadata === ""
    ? {}
    : parseTelemetryMetadata(existingMetadata);
  if (!metadata) {
    return undefined;
  }

  const existingLogBrewMetadata = cloneObject(metadata[LOGBREW_METADATA_KEY]);
  return JSON.stringify({
    ...metadata,
    [LOGBREW_METADATA_KEY]: {
      ...existingLogBrewMetadata,
      traceparent
    }
  });
}

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
    const parsed = JSON.parse(metadata);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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

function resolveQueueName(queue, fallback) {
  if (typeof fallback === "string" && fallback.trim() !== "") {
    return fallback.trim();
  }
  if (typeof queue?.name === "string" && queue.name.trim() !== "") {
    return queue.name.trim();
  }
  return DEFAULT_QUEUE_NAME;
}

function normalizeName(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function cloneObject(value) {
  return isObject(value) ? { ...value } : {};
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export default {
  bullMqQueueAddBulkWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  createLogBrewBullMqJobOptions,
  extractLogBrewBullMqTraceparent,
  instrumentLogBrewBullMqQueue,
  withLogBrewBullMqProcessor
};
