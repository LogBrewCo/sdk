"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  defaultRouteTemplateFactory,
  isCallable,
  isWritableRecord,
  readField,
  toText
} = require("./instrumentation-values.cjs");
const { XhrRequestState } = require("./instrumentation-xhr-request.cjs");

/**
 * @import { LogBrewClient, Metadata } from "@logbrew/sdk"
 * @import { TracePropagationTarget } from "./index.cjs"
 * @import { AppStateInput, Callable, PlatformInput, TraceInput } from "./instrumentation-values.cjs"
 * @import { XhrMethods, XhrWrapperSettings } from "./instrumentation-xhr-request.cjs"
 */

/**
 * @typedef {{
 *   readonly appState: AppStateInput | undefined,
 *   readonly globalObject: unknown,
 *   readonly measureXhrResponseBodySize: boolean,
 *   readonly metadata: Readonly<Metadata>,
 *   readonly metadataFactory: unknown,
 *   readonly now: () => string,
 *   readonly nowMs: () => number,
 *   readonly platform: PlatformInput | undefined,
 *   readonly routeTemplate: string | undefined,
 *   readonly routeTemplateFactory: unknown,
 *   readonly screen: string | undefined,
 *   readonly sessionId: string | undefined,
 *   readonly trace: TraceInput,
 *   readonly tracePropagationTargets: readonly TracePropagationTarget[]
 * }} XhrInstallOptions
 * @typedef {{ readonly open: Callable, readonly send: Callable }} XhrWrappers
 */

const HEADERS_RECEIVED = 2;
const DONE = 4;
const OPEN_LENGTH = 2;
const SEND_LENGTH = 1;

/**
 * @param {unknown} method
 * @returns {string}
 */
function normalizeXhrMethod(method) {
  return toText(method ?? "GET").toUpperCase();
}

/**
 * @param {unknown} url
 * @returns {unknown}
 */
function xhrUrl(url) {
  if (typeof url === "string") {
    return url;
  }
  try {
    const toStringMethod = readField(url, "toString");
    return isCallable(toStringMethod) ? Reflect.apply(toStringMethod, url, []) : toText(url);
  } catch {
    return toText(url);
  }
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {unknown}
 */
function readyState(value, fallback) {
  return typeof value === "number" ? value : fallback;
}

/**
 * @param {unknown} prototype
 * @returns {XhrMethods}
 */
function readXhrMethods(prototype) {
  const open = readField(prototype, "open");
  const send = readField(prototype, "send");
  const setRequestHeader = readField(prototype, "setRequestHeader");
  if (!isCallable(open) || !isCallable(send) || !isCallable(setRequestHeader)) {
    throw new SdkError("configuration_error", "instrumentGlobalXMLHttpRequest requires open, send, and setRequestHeader");
  }
  return { open, send, setRequestHeader };
}

/**
 * @param {unknown} xhrType
 * @returns {unknown}
 */
function xhrPrototype(xhrType) {
  const prototype = isCallable(xhrType) ? readField(xhrType, "prototype") : undefined;
  const hasPrototype = Boolean(prototype);
  if (!isCallable(xhrType) || !hasPrototype) {
    throw new SdkError("configuration_error", "instrumentGlobalXMLHttpRequest requires globalObject.XMLHttpRequest");
  }
  return prototype;
}

/**
 * @param {unknown} globalObject
 * @returns {{ readonly methods: XhrMethods, readonly prototype: Record<PropertyKey, unknown>, readonly xhrType: unknown }}
 */
function requireXhrTarget(globalObject) {
  if (!isWritableRecord(globalObject)) {
    throw new SdkError("configuration_error", "instrumentGlobalXMLHttpRequest requires a globalObject");
  }
  const xhrType = globalObject["XMLHttpRequest"];
  const prototype = xhrPrototype(xhrType);
  const methods = readXhrMethods(prototype);
  if (!isWritableRecord(prototype)) {
    throw new SdkError("configuration_error", "instrumentGlobalXMLHttpRequest requires open, send, and setRequestHeader");
  }
  return { methods, prototype, xhrType };
}

/**
 * @param {LogBrewClient} client
 * @param {XhrInstallOptions} options
 * @param {unknown} xhrType
 * @returns {XhrWrapperSettings}
 */
function xhrWrapperSettings(client, options, xhrType) {
  return {
    capture: {
      appState: options.appState,
      client,
      doneState: readyState(readField(xhrType, "DONE"), DONE),
      headersReceivedState: readyState(readField(xhrType, "HEADERS_RECEIVED"), HEADERS_RECEIVED),
      measureXhrResponseBodySize: options.measureXhrResponseBodySize,
      metadata: options.metadata,
      metadataFactory: options.metadataFactory,
      nowMs: options.nowMs,
      platform: options.platform,
      routeTemplate: options.routeTemplate,
      routeTemplateFactory: isCallable(options.routeTemplateFactory) ? options.routeTemplateFactory : defaultRouteTemplateFactory,
      screen: options.screen,
      sessionId: options.sessionId,
      status: undefined,
      trace: options.trace
    },
    now: options.now,
    tracePropagationTargets: options.tracePropagationTargets
  };
}

/**
 * @param {XhrMethods} methods
 * @param {XhrWrapperSettings} settings
 * @returns {XhrWrappers}
 */
function createXhrWrappers(methods, settings) {
  const contextKey = Symbol("logbrew.xhr");
  /**
   * @this {unknown}
   * @param {readonly unknown[]} args
   * @returns {unknown}
   */
  function wrappedOpen(...args) {
    const [method, url] = args;
    const context = new XhrRequestState(normalizeXhrMethod(method), xhrUrl(url));
    if (!isWritableRecord(this)) {
      throw new TypeError("XMLHttpRequest.open requires an XMLHttpRequest");
    }
    this[contextKey] = context;
    return Reflect.apply(methods.open, this, args);
  }
  /**
   * @this {unknown}
   * @param {readonly unknown[]} args
   * @returns {unknown}
   */
  function wrappedSend(...args) {
    const context = readField(this, contextKey);
    if (!(context instanceof XhrRequestState)) {
      return Reflect.apply(methods.send, this, args);
    }
    return context.send(this, { args, methods, settings });
  }
  Object.defineProperty(wrappedOpen, "length", { value: OPEN_LENGTH });
  Object.defineProperty(wrappedSend, "length", { value: SEND_LENGTH });
  return { open: wrappedOpen, send: wrappedSend };
}

/**
 * @param {unknown} prototype
 * @param {XhrWrappers} wrappers
 * @returns {void}
 */
function requirePatched(prototype, wrappers) {
  if (readField(prototype, "open") !== wrappers.open || readField(prototype, "send") !== wrappers.send) {
    throw new SdkError("configuration_error", "instrumentGlobalXMLHttpRequest could not patch XMLHttpRequest");
  }
}

/**
 * @param {LogBrewClient} client
 * @param {XhrInstallOptions} options
 * @returns {Readonly<{ remove: () => void, stop: () => void }>}
 */
function installGlobalXMLHttpRequestInstrumentation(client, options) {
  const { methods, prototype, xhrType } = requireXhrTarget(options.globalObject);
  const wrappers = createXhrWrappers(methods, xhrWrapperSettings(client, options, xhrType));
  prototype["open"] = wrappers.open;
  prototype["send"] = wrappers.send;
  requirePatched(prototype, wrappers);
  let removed = false;
  const { remove } = {
    remove: () => {
      if (removed) {
        return;
      }
      removed = true;
      if (prototype["open"] === wrappers.open) {
        prototype["open"] = methods.open;
      }
      if (prototype["send"] === wrappers.send) {
        prototype["send"] = methods.send;
      }
    }
  };
  return Object.freeze({
    remove,
    stop: remove
  });
}

module.exports = { installGlobalXMLHttpRequestInstrumentation };
