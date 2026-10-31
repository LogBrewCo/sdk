"use strict";

const { flowAddWithLogBrewSpan, queueAddBulkWithLogBrewSpan, queueAddWithLogBrewSpan } = require("./producer.cjs");
const { hasFields, isCallable, isMarked, mark, requireMethod } = require("./internal.cjs");
const { callBullMqFlowProducerAdd, processWithLogBrewBullMqSpan } = require("./process.cjs");
const { SdkError } = require("@logbrew/sdk");

/**
 * @import { LogBrewBullMqInstrumentation, LogBrewBullMqSpanOptions } from "./index.cjs"
 * @import { Callable } from "./internal.cjs"
 * @typedef {{ readonly installed: boolean, readonly options: LogBrewBullMqSpanOptions | null | undefined }} InstrumentationState
 */

const INSTRUMENTED_FLOW_ADD = Symbol.for("@logbrew/bullmq.instrumentedFlowAdd");
const INSTRUMENTED_PROCESSOR_METHOD = Symbol.for("@logbrew/bullmq.instrumentedProcessorMethod");
const INSTRUMENTED_QUEUE_ADD = Symbol.for("@logbrew/bullmq.instrumentedQueueAdd");
const PROCESSOR_SOURCE = "instrumentLogBrewBullMqProcessor";
const QUEUE_SOURCE = "instrumentLogBrewBullMqQueue";

/**
 * @param {string} source
 * @param {string} target
 * @returns {SdkError}
 */
function alreadyInstrumentedError(source, target) {
  return new SdkError(
    "configuration_error",
    `${source} requires an uninstrumented ${target}; uninstall the existing LogBrew instrumentation first`
  );
}

/**
 * @param {unknown} methodNameOrOptions
 * @returns {string}
 */
function resolveProcessorMethodName(methodNameOrOptions) {
  const methodName = typeof methodNameOrOptions === "string" ? methodNameOrOptions.trim() : "process";
  if (methodName === "") {
    throw new SdkError("configuration_error", `${PROCESSOR_SOURCE} requires a method name`);
  }
  return methodName;
}

/**
 * @param {unknown} method
 * @param {string} methodName
 * @returns {Callable}
 */
function requireProcessorMethod(method, methodName) {
  if (!isCallable(method)) {
    throw new SdkError("configuration_error", `${PROCESSOR_SOURCE} requires ${methodName} to be a function`);
  }
  if (isMarked(method, INSTRUMENTED_PROCESSOR_METHOD)) {
    throw alreadyInstrumentedError(PROCESSOR_SOURCE, "processor method");
  }
  return method;
}

/**
 * @param {unknown} target
 * @param {Callable} originalProcess
 * @param {InstrumentationState} state
 * @returns {Callable}
 */
function createInstrumentedProcessor(target, originalProcess, state) {
  /** @type {Callable} */
  function logBrewInstrumentedBullMqProcessor(...args) {
    const [job, lock, signal, ...rest] = args;
    const callArgs = [job, lock, signal, ...rest];
    if (!state.installed) {
      return Reflect.apply(originalProcess, target, callArgs);
    }
    return processWithLogBrewBullMqSpan(job, () => Reflect.apply(originalProcess, target, callArgs), state.options);
  }

  mark(logBrewInstrumentedBullMqProcessor, INSTRUMENTED_PROCESSOR_METHOD);
  return logBrewInstrumentedBullMqProcessor;
}

/**
 * @param {unknown} target
 * @param {string | LogBrewBullMqSpanOptions | null} [methodNameOrOptions]
 * @param {LogBrewBullMqSpanOptions} [maybeOptions]
 * @returns {LogBrewBullMqInstrumentation}
 */
function instrumentLogBrewBullMqProcessor(target, methodNameOrOptions, maybeOptions) {
  if (!hasFields(target)) {
    throw new SdkError("configuration_error", `${PROCESSOR_SOURCE} requires a processor object`);
  }
  const methodName = resolveProcessorMethodName(methodNameOrOptions);
  const options = typeof methodNameOrOptions === "string" || methodNameOrOptions === undefined
    ? maybeOptions
    : methodNameOrOptions;
  const originalDescriptor = Object.getOwnPropertyDescriptor(target, methodName);
  const state = { installed: true, options };
  const instrumented = createInstrumentedProcessor(target, requireProcessorMethod(target[methodName], methodName), state);
  target[methodName] = instrumented;
  return {
    isInstalled: () => state.installed && target[methodName] === instrumented,
    uninstall: () => {
      state.installed = false;
      if (target[methodName] !== instrumented) {
        return;
      }
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(target, methodName);
      } else {
        Object.defineProperty(target, methodName, originalDescriptor);
      }
    }
  };
}

/**
 * @param {unknown} owner
 * @param {Callable} originalAdd
 * @param {InstrumentationState} state
 * @returns {Callable}
 */
function createInstrumentedFlowAdd(owner, originalAdd, state) {
  /** @type {Callable} */
  function logBrewInstrumentedBullMqFlowAdd(...args) {
    if (!state.installed) {
      return callBullMqFlowProducerAdd(originalAdd, owner, args);
    }
    const [flow, ...rest] = args;
    return flowAddWithLogBrewSpan({
      add: (flowJob) => callBullMqFlowProducerAdd(originalAdd, owner, [flowJob, ...rest]),
      flow,
      options: state.options
    });
  }

  mark(logBrewInstrumentedBullMqFlowAdd, INSTRUMENTED_FLOW_ADD);
  return logBrewInstrumentedBullMqFlowAdd;
}

/**
 * @param {unknown} flowProducer
 * @param {LogBrewBullMqSpanOptions} [options]
 * @returns {LogBrewBullMqInstrumentation}
 */
function instrumentLogBrewBullMqFlowProducer(flowProducer, options) {
  const source = "instrumentLogBrewBullMqFlowProducer";
  const { method: originalAdd, owner } = requireMethod(flowProducer, "add", `${source} requires a BullMQ FlowProducer`);
  if (isMarked(originalAdd, INSTRUMENTED_FLOW_ADD)) {
    throw alreadyInstrumentedError(source, "BullMQ FlowProducer");
  }
  const state = { installed: true, options };
  const instrumented = createInstrumentedFlowAdd(owner, originalAdd, state);
  owner["add"] = instrumented;
  return {
    isInstalled: () => state.installed && owner["add"] === instrumented,
    uninstall: () => {
      state.installed = false;
      if (owner["add"] === instrumented) {
        owner["add"] = originalAdd;
      }
    }
  };
}

/**
 * @param {unknown} owner
 * @param {Callable} originalAdd
 * @param {InstrumentationState} state
 * @returns {Callable}
 */
function createInstrumentedQueueAdd(owner, originalAdd, state) {
  /** @type {Callable} */
  function logBrewInstrumentedBullMqAdd(...args) {
    const [name, data, jobOptions, ...rest] = args;
    if (!state.installed) {
      return Reflect.apply(originalAdd, owner, [name, data, jobOptions, ...rest]);
    }
    return queueAddWithLogBrewSpan({
      add: (nextJobOptions) => Reflect.apply(originalAdd, owner, [name, data, nextJobOptions, ...rest]),
      jobOptions,
      name,
      options: state.options,
      queue: owner
    });
  }

  mark(logBrewInstrumentedBullMqAdd, INSTRUMENTED_QUEUE_ADD);
  return logBrewInstrumentedBullMqAdd;
}

/**
 * @param {unknown} owner
 * @param {Callable} originalAddBulk
 * @param {InstrumentationState} state
 * @returns {Callable}
 */
function createInstrumentedQueueAddBulk(owner, originalAddBulk, state) {
  return function logBrewInstrumentedBullMqAddBulk(...args) {
    const [jobs, ...rest] = args;
    if (!state.installed) {
      return Reflect.apply(originalAddBulk, owner, [jobs, ...rest]);
    }
    return queueAddBulkWithLogBrewSpan({
      addBulk: (nextJobs) => Reflect.apply(originalAddBulk, owner, [nextJobs, ...rest]),
      jobs,
      options: state.options,
      queue: owner
    });
  };
}

/**
 * @param {unknown} queue
 * @returns {{ readonly originalAdd: Callable, readonly originalAddBulk: unknown, readonly owner: Record<PropertyKey, unknown> }}
 */
function requireUninstrumentedQueue(queue) {
  const { method: originalAdd, owner } = requireMethod(queue, "add", `${QUEUE_SOURCE} requires a BullMQ queue`);
  const { addBulk: originalAddBulk } = owner;
  if (isMarked(originalAdd, INSTRUMENTED_QUEUE_ADD)) {
    throw alreadyInstrumentedError(QUEUE_SOURCE, "BullMQ queue");
  }
  return { originalAdd, originalAddBulk, owner };
}

/**
 * @param {unknown} queue
 * @param {LogBrewBullMqSpanOptions} [options]
 * @returns {LogBrewBullMqInstrumentation}
 */
function instrumentLogBrewBullMqQueue(queue, options) {
  const { originalAdd, originalAddBulk, owner } = requireUninstrumentedQueue(queue);
  const state = { installed: true, options };
  const instrumentedAdd = createInstrumentedQueueAdd(owner, originalAdd, state);
  owner["add"] = instrumentedAdd;
  const instrumentedAddBulk = isCallable(originalAddBulk)
    ? createInstrumentedQueueAddBulk(owner, originalAddBulk, state)
    : undefined;
  if (instrumentedAddBulk !== undefined) {
    owner["addBulk"] = instrumentedAddBulk;
  }
  return {
    isInstalled: () => state.installed && owner["add"] === instrumentedAdd,
    uninstall: () => {
      state.installed = false;
      if (owner["add"] === instrumentedAdd) {
        owner["add"] = originalAdd;
      }
      if (instrumentedAddBulk !== undefined && owner["addBulk"] === instrumentedAddBulk) {
        owner["addBulk"] = originalAddBulk;
      }
    }
  };
}

module.exports = {
  instrumentLogBrewBullMqFlowProducer,
  instrumentLogBrewBullMqProcessor,
  instrumentLogBrewBullMqQueue
};
