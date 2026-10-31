import { SdkError, parseTraceparent } from "@logbrew/sdk";

/**
 * @import { LogBrewQueueBatchMessage, LogBrewQueueTraceCarrier } from "@logbrew/node"
 * @import { LogBrewKafkaJsInstrumentation } from "./index.js"
 */

/**
 * @typedef {(...args: readonly unknown[]) => unknown} Callable
 * @typedef {(receiver: unknown, args: readonly unknown[]) => unknown} WrappedCall
 * @typedef {{ readonly handle: LogBrewKafkaJsInstrumentation, readonly undo: (() => void)[] }} InstrumentationState
 */

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is Callable}
 */
function isCallable(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {unknown}
 */
function readField(value, name) {
  return isObjectLike(value) ? value[name] : undefined;
}

/**
 * @param {unknown} value
 * @returns {readonly unknown[]}
 */
function readList(value) {
  return isList(value) ? value : [];
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeLabel(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function cloneObject(value) {
  return isObjectLike(value) && !isList(value) ? { ...value } : {};
}

/**
 * @param {unknown} value
 * @returns {value is Buffer}
 */
function isNodeBufferValue(value) {
  if (!isObjectLike(value) || !isCallable(readField(value, "toString"))) {
    return false;
  }
  const { constructor } = value;
  if (!isCallable(constructor) && !isObjectLike(constructor)) {
    return false;
  }
  /** @type {unknown} */
  const isBuffer = Reflect.get(constructor, "isBuffer");
  return isCallable(isBuffer) && Boolean(isBuffer.call(constructor, value));
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readOneHeaderValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (isNodeBufferValue(value)) {
    return value.toString("utf8");
  }
  return undefined;
}

/**
 * @param {unknown} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function readHeaderValue(headers, name) {
  const value = readField(headers, name);
  if (isList(value)) {
    const [first] = value;
    return readOneHeaderValue(first);
  }
  return readOneHeaderValue(value);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
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

/**
 * @param {unknown} value
 * @returns {value is LogBrewQueueTraceCarrier}
 */
function isTraceCarrier(value) {
  if (typeof value === "string") {
    return true;
  }
  const get = readField(value, "get");
  return isObjectLike(value) && (get === undefined || isCallable(get));
}

/**
 * @param {unknown} value
 * @returns {value is LogBrewQueueBatchMessage}
 */
function isBatchMessage(value) {
  const headers = readField(value, "headers");
  return isTraceCarrier(value) || (isObjectLike(value) && (headers === undefined || isTraceCarrier(headers)));
}

/**
 * @template Options
 * @param {Options | undefined} options
 * @returns {Options}
 */
function requireSpanOptions(options) {
  if (options === undefined) {
    throw new SdkError("configuration_error", "queueOperationWithLogBrewSpan requires client");
  }
  return options;
}

/**
 * @param {object} target
 * @param {symbol} key
 * @param {string} label
 * @returns {InstrumentationState}
 */
function createInstrumentationState(target, key, label) {
  const installed = Boolean(Reflect.get(target, key));
  if (installed) {
    throw new SdkError("configuration_error", `${label} is already instrumented by LogBrew`);
  }
  /** @type {(() => void)[]} */
  const undo = [];
  const handle = {
    uninstall() {
      for (let step = undo.pop(); step !== undefined; step = undo.pop()) {
        step();
      }
      Reflect.deleteProperty(target, key);
    }
  };
  Object.defineProperty(target, key, {
    configurable: true,
    value: handle
  });
  return { handle, undo };
}

/**
 * @param {object} target
 * @param {string} methodName
 * @param {WrappedCall} callWrapped
 * @returns {() => void}
 */
function installMethod(target, methodName, callWrapped) {
  /** @type {unknown} */
  const original = Reflect.get(target, methodName);
  const hadOwnProperty = Object.hasOwn(target, methodName);
  /**
   * @this {unknown}
   * @param {readonly unknown[]} args
   * @returns {unknown}
   */
  function logBrewKafkaJsInstrumentedMethod(...args) {
    return callWrapped(this, args);
  }
  Reflect.set(target, methodName, logBrewKafkaJsInstrumentedMethod);
  return () => {
    if (hadOwnProperty) {
      Reflect.set(target, methodName, original);
      return;
    }
    Reflect.deleteProperty(target, methodName);
  };
}

export {
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
};
