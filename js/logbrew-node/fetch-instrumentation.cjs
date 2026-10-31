"use strict";

const { SdkError } = require("@logbrew/sdk");
const { applyFunction, isTruthy } = require("./internal.cjs");
const { getActiveLogBrewTrace } = require("./active-trace.cjs");
const { fetchWithLogBrewSpan, getFetchMethod, getFetchUrl } = require("./fetch-span.cjs");
const { fetchInstrumentationMetadata, hasClient, pathOnly } = require("./span-support.cjs");
const { fetchTargetMatcherValues, matchesFetchTarget, normalizeFetchTargetMatchers } = require("./target-matchers.cjs");

/**
 * @import { LogBrewTraceContext } from "./index.cjs"
 * @import { ClientSpanOptions } from "./span-support.cjs"
 */

/**
 * @typedef {{ fetch?: unknown }} FetchHost
 * @typedef {Readonly<{
 *   captureTargets?: unknown,
 *   client?: unknown,
 *   globalObject?: unknown,
 *   metadata?: unknown,
 *   routeTemplate?: unknown,
 *   routeTemplateFactory?: unknown,
 *   trace?: LogBrewTraceContext | undefined,
 *   tracePropagationTargets?: unknown
 * }>} FetchInstrumentationConfig
 * @typedef {Readonly<{ isInstalled: () => boolean, uninstall: () => void }>} InstrumentationHandle
 * @typedef {Readonly<{ host: FetchHost, originalFetch: unknown }>} ValidatedFetchHost
 * @typedef {Readonly<{
 *   matchers: readonly unknown[],
 *   options: FetchInstrumentationConfig & ClientSpanOptions,
 *   routeTemplate: unknown,
 *   routeTemplateFactory: unknown
 * }>} InstrumentedFetchSettings
 */

const LOGBREW_FETCH_INSTRUMENTATION = Symbol.for("@logbrew/node.fetchInstrumentation");

/**
 * @param {Readonly<{ path: string }>} context
 * @returns {string}
 */
function defaultFetchRouteTemplateFactory({ path }) {
  return path;
}

/**
 * @param {unknown} value
 * @returns {value is FetchHost}
 */
function isFetchHost(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} globalObject
 * @param {unknown} routeTemplateFactory
 * @returns {ValidatedFetchHost}
 */
function validateFetchHost(globalObject, routeTemplateFactory) {
  if (!isFetchHost(globalObject)) {
    throw new SdkError("configuration_error", "installLogBrewFetchInstrumentation requires globalObject");
  }
  const originalFetch = globalObject.fetch;
  if (typeof originalFetch !== "function") {
    throw new SdkError("configuration_error", "installLogBrewFetchInstrumentation requires fetch");
  }
  if (isTruthy(Reflect.get(originalFetch, LOGBREW_FETCH_INSTRUMENTATION))) {
    throw new SdkError("configuration_error", "installLogBrewFetchInstrumentation requires uninstrumented fetch");
  }
  if (routeTemplateFactory !== undefined && typeof routeTemplateFactory !== "function") {
    throw new SdkError("configuration_error", "routeTemplateFactory must be a function");
  }
  return { host: globalObject, originalFetch };
}

/**
 * @param {unknown} factory
 * @param {Readonly<Record<string, unknown>>} context
 * @returns {unknown}
 */
function callRouteTemplateFactory(factory, context) {
  if (typeof factory !== "function") {
    throw new TypeError("routeTemplateFactory is not a function");
  }
  /** @type {unknown} */
  const routeTemplate = Reflect.apply(factory, undefined, [context]);
  return routeTemplate;
}

/**
 * @param {ValidatedFetchHost} validated
 * @param {InstrumentedFetchSettings} settings
 * @returns {(input: unknown, init: unknown) => unknown}
 */
function createInstrumentedFetch({ host, originalFetch }, { matchers, options, routeTemplate, routeTemplateFactory }) {
  /**
   * @param {unknown} input
   * @param {unknown} init
   * @returns {unknown}
   */
  function callOriginalFetch(input, init) {
    return applyFunction(originalFetch, host, [input, init]);
  }

  /**
   * @param {unknown} input
   * @param {unknown} init
   * @returns {unknown}
   */
  function logBrewInstrumentedFetch(input, init) {
    const url = getFetchUrl(input);
    const method = getFetchMethod(input, init);
    const path = pathOnly(url);
    if (!matchesFetchTarget({ init, input, method, path, url }, matchers)) {
      return callOriginalFetch(input, init);
    }
    return fetchWithLogBrewSpan(input, init, {
      ...options,
      fetchImpl: callOriginalFetch,
      includeErrorMessage: false,
      metadata: fetchInstrumentationMetadata(options.metadata),
      routeTemplate: routeTemplate ?? callRouteTemplateFactory(routeTemplateFactory, { init, input, method, path, url }),
      trace: options.trace ?? getActiveLogBrewTrace()
    });
  }
  return logBrewInstrumentedFetch;
}

/**
 * @param {ValidatedFetchHost} validated
 * @param {unknown} logBrewInstrumentedFetch
 * @returns {InstrumentationHandle}
 */
function createFetchHandle({ host, originalFetch }, logBrewInstrumentedFetch) {
  let installed = true;
  return Object.freeze({
    isInstalled() {
      return installed && host.fetch === logBrewInstrumentedFetch;
    },
    uninstall() {
      if (!installed) {
        return;
      }
      if (host.fetch === logBrewInstrumentedFetch) {
        host.fetch = originalFetch;
      }
      installed = false;
    }
  });
}

/**
 * @param {FetchInstrumentationConfig} [config]
 * @returns {InstrumentationHandle}
 */
function installLogBrewFetchInstrumentation({
  captureTargets,
  globalObject = globalThis,
  routeTemplate,
  routeTemplateFactory = defaultFetchRouteTemplateFactory,
  tracePropagationTargets = [],
  ...options
} = {}) {
  if (!hasClient(options)) {
    throw new SdkError("configuration_error", "installLogBrewFetchInstrumentation requires client");
  }
  const { host, originalFetch } = validateFetchHost(globalObject, routeTemplateFactory);
  const matchers = normalizeFetchTargetMatchers([
    ...fetchTargetMatcherValues(tracePropagationTargets),
    ...fetchTargetMatcherValues(captureTargets)
  ]);
  const logBrewInstrumentedFetch = createInstrumentedFetch({ host, originalFetch }, { matchers, options, routeTemplate, routeTemplateFactory });
  Object.defineProperty(logBrewInstrumentedFetch, LOGBREW_FETCH_INSTRUMENTATION, { value: true });
  host.fetch = logBrewInstrumentedFetch;
  return createFetchHandle({ host, originalFetch }, logBrewInstrumentedFetch);
}

module.exports = { installLogBrewFetchInstrumentation };
