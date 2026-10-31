"use strict";

const { SdkError } = require("@logbrew/sdk");
const { callHttpClientRequest } = require("./http-client-span.cjs");
const { hasClient } = require("./span-support.cjs");
const { fetchTargetMatcherValues, normalizeFetchTargetMatchers } = require("./target-matchers.cjs");

/**
 * @import { LogBrewTraceContext } from "./index.cjs"
 * @import { HttpClientCallOptions } from "./http-client-span.cjs"
 * @import { ClientSpanOptions } from "./span-support.cjs"
 */

/**
 * @typedef {{ get: unknown, request: unknown }} HttpClientModule
 * @typedef {Readonly<{
 *   get: unknown,
 *   moduleValue: HttpClientModule,
 *   originalGet: unknown,
 *   originalRequest: unknown,
 *   request: unknown
 * }>} InstalledModule
 * @typedef {Readonly<{ isInstalled: () => boolean, uninstall: () => void }>} HttpClientHandle
 * @typedef {Readonly<{
 *   captureTargets?: unknown,
 *   client?: unknown,
 *   modules?: unknown,
 *   routeTemplate?: unknown,
 *   routeTemplateFactory?: unknown,
 *   trace?: LogBrewTraceContext | undefined,
 *   tracePropagationTargets?: unknown
 * }>} HttpClientInstrumentationConfig
 * @typedef {Omit<HttpClientCallOptions, "defaultProtocol" | "endRequest" | "framework" | "moduleName">} ModuleOptions
 */

const LOGBREW_HTTP_CLIENT_INSTRUMENTATION = Symbol("@logbrew/node.httpClientInstrumentation");
const NO_VALUES = 0;
/** @type {WeakMap<object, HttpClientHandle>} */
const httpClientInstrumentationHandles = new WeakMap();

/**
 * @param {unknown} value
 * @returns {value is HttpClientModule}
 */
function isHttpClientModule(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {string} name
 * @param {unknown} moduleValue
 * @returns {HttpClientModule}
 */
function validateHttpClientModule(name, moduleValue) {
  if (!isHttpClientModule(moduleValue)) {
    throw new SdkError("configuration_error", `installLogBrewHttpClientInstrumentation requires ${name} module`);
  }
  if (typeof moduleValue.request !== "function" || typeof moduleValue.get !== "function") {
    throw new SdkError("configuration_error", `installLogBrewHttpClientInstrumentation requires ${name}.request and ${name}.get`);
  }
  if (httpClientInstrumentationHandles.get(moduleValue)?.isInstalled() === true) {
    throw new SdkError("configuration_error", `installLogBrewHttpClientInstrumentation requires uninstrumented ${name} module`);
  }
  if (Boolean(Reflect.get(moduleValue.request, LOGBREW_HTTP_CLIENT_INSTRUMENTATION)) || Boolean(Reflect.get(moduleValue.get, LOGBREW_HTTP_CLIENT_INSTRUMENTATION))) {
    throw new SdkError("configuration_error", `installLogBrewHttpClientInstrumentation requires uninstrumented ${name} module`);
  }
  return moduleValue;
}

/**
 * @param {string} name
 * @param {Readonly<{ moduleValue: HttpClientModule, originalGet: unknown, originalRequest: unknown }>} originals
 * @param {ModuleOptions} options
 * @returns {Readonly<{ get: (...args: readonly unknown[]) => unknown, request: (...args: readonly unknown[]) => unknown }>}
 */
function createModuleWrappers(name, { moduleValue, originalGet, originalRequest }, options) {
  const defaultProtocol = name === "https" ? "https:" : "http:";
  const framework = `node:${name}`;

  /**
   * @param {readonly unknown[]} args
   * @returns {unknown}
   */
  function request(...args) {
    return callHttpClientRequest({ fallback: originalRequest, request: originalRequest, target: moduleValue }, args, {
      ...options,
      defaultProtocol,
      endRequest: false,
      framework,
      moduleName: name
    });
  }

  /**
   * @param {readonly unknown[]} args
   * @returns {unknown}
   */
  function get(...args) {
    return callHttpClientRequest({ fallback: originalGet, request: originalRequest, target: moduleValue }, args, {
      ...options,
      defaultProtocol,
      endRequest: true,
      framework,
      moduleName: name
    });
  }
  return { get, request };
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {ModuleOptions} options
 * @returns {InstalledModule}
 */
function instrumentHttpClientModule(name, value, options) {
  const moduleValue = validateHttpClientModule(name, value);
  const originalRequest = moduleValue.request;
  const originalGet = moduleValue.get;
  const { get, request } = createModuleWrappers(name, { moduleValue, originalGet, originalRequest }, options);
  Object.defineProperty(request, LOGBREW_HTTP_CLIENT_INSTRUMENTATION, { value: true });
  Object.defineProperty(get, LOGBREW_HTTP_CLIENT_INSTRUMENTATION, { value: true });
  moduleValue.request = request;
  moduleValue.get = get;
  return { get, moduleValue, originalGet, originalRequest, request };
}


/**
 * @param {readonly InstalledModule[]} installedModules
 * @returns {void}
 */
function restoreModules(installedModules) {
  for (const { moduleValue, originalRequest, originalGet, request, get } of installedModules) {
    if (moduleValue.request === request) {
      moduleValue.request = originalRequest;
    }
    if (moduleValue.get === get) {
      moduleValue.get = originalGet;
    }
    httpClientInstrumentationHandles.delete(moduleValue);
  }
}

/**
 * @param {unknown} modules
 * @param {unknown} routeTemplateFactory
 * @returns {readonly (readonly [string, unknown])[]}
 */
function moduleEntriesOf(modules, routeTemplateFactory) {
  if (!isHttpClientModule(modules)) {
    throw new SdkError("configuration_error", "installLogBrewHttpClientInstrumentation requires modules");
  }
  /** @type {readonly (readonly [string, unknown])[]} */
  const entries = [
    ["http", Reflect.get(modules, "http")],
    ["https", Reflect.get(modules, "https")]
  ];
  const present = entries.filter(([, moduleValue]) => moduleValue !== undefined && moduleValue !== null);
  if (present.length === NO_VALUES) {
    throw new SdkError("configuration_error", "installLogBrewHttpClientInstrumentation requires at least one http or https module");
  }
  if (routeTemplateFactory !== undefined && typeof routeTemplateFactory !== "function") {
    throw new SdkError("configuration_error", "routeTemplateFactory must be a function");
  }
  return present;
}

/**
 * @param {readonly (readonly [string, unknown])[]} entries
 * @param {ModuleOptions} options
 * @returns {readonly InstalledModule[]}
 */
function instrumentModules(entries, options) {
  /** @type {InstalledModule[]} */
  const installedModules = [];
  try {
    for (const [name, moduleValue] of entries) {
      installedModules.push(instrumentHttpClientModule(name, moduleValue, options));
    }
  } catch (error) {
    restoreModules(installedModules);
    throw error;
  }
  return installedModules;
}

/**
 * @param {readonly InstalledModule[]} installedModules
 * @returns {HttpClientHandle}
 */
function createHttpClientHandle(installedModules) {
  let installed = true;
  return Object.freeze({
    isInstalled() {
      return installed && installedModules.every(({ moduleValue, request, get }) => moduleValue.request === request && moduleValue.get === get);
    },
    uninstall() {
      if (!installed) {
        return;
      }
      restoreModules(installedModules);
      installed = false;
    }
  });
}

/**
 * @param {unknown} captureTargets
 * @param {unknown} tracePropagationTargets
 * @returns {Readonly<{ captureMatchers: readonly unknown[], propagationMatchers: readonly unknown[] }>}
 */
function targetMatchers(captureTargets, tracePropagationTargets) {
  const captureValues = fetchTargetMatcherValues(captureTargets);
  const propagationValues = fetchTargetMatcherValues(tracePropagationTargets);
  return {
    captureMatchers: normalizeFetchTargetMatchers(captureValues.length > NO_VALUES ? captureValues : propagationValues),
    propagationMatchers: normalizeFetchTargetMatchers(propagationValues.length > NO_VALUES ? propagationValues : captureValues)
  };
}

/**
 * @param {HttpClientInstrumentationConfig} [config]
 * @returns {HttpClientHandle}
 */
function installLogBrewHttpClientInstrumentation({
  captureTargets,
  modules,
  routeTemplate,
  routeTemplateFactory,
  tracePropagationTargets,
  ...options
} = {}) {
  if (!hasClient(options)) {
    throw new SdkError("configuration_error", "installLogBrewHttpClientInstrumentation requires client");
  }
  const entries = moduleEntriesOf(modules, routeTemplateFactory);
  const matchers = targetMatchers(captureTargets, tracePropagationTargets);
  /** @type {ClientSpanOptions} */
  const spanOptions = options;
  const installedModules = instrumentModules(entries, { ...spanOptions, ...matchers, routeTemplate, routeTemplateFactory });
  const handle = createHttpClientHandle(installedModules);
  for (const { moduleValue } of installedModules) {
    httpClientInstrumentationHandles.set(moduleValue, handle);
  }
  return handle;
}

module.exports = { installLogBrewHttpClientInstrumentation };
