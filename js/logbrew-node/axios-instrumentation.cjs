"use strict";

const { SdkError } = require("@logbrew/sdk");
const { callMethod, readMember, readOptionalMember } = require("./internal.cjs");
const {
  createChildTraceContext,
  getActiveLogBrewTrace,
  traceparentFor
} = require("./active-trace.cjs");
const {
  captureAxiosSpan,
  defaultAxiosSpanId,
  getAxiosMethod,
  getAxiosUrl,
  normalizeAxiosRequestConfig,
  withAxiosTraceparent
} = require("./axios-span.cjs");
const { durationSince, hasClient, isRecord, nowMs, pathOnly } = require("./span-support.cjs");
const { matchesFetchTarget, normalizeFetchTargetMatchers, resolveRouteTemplate } = require("./target-matchers.cjs");

/**
 * @import { LogBrewTraceContext } from "./index.cjs"
 * @import { AxiosConfig, AxiosSpanOptions } from "./axios-span.cjs"
 * @import { ClientSpanOptions } from "./span-support.cjs"
 */

/**
 * @typedef {AxiosSpanOptions & Readonly<{ captureTargets?: unknown, tracePropagationTargets?: unknown }>} AxiosInstrumentationOptions
 * @typedef {AxiosInstrumentationOptions & ClientSpanOptions} CheckedAxiosOptions
 * @typedef {Readonly<{ capture: readonly unknown[], options: CheckedAxiosOptions, propagation: readonly unknown[] }>} AxiosPlan
 * @typedef {Readonly<{
 *   captureSpan: boolean,
 *   id: unknown,
 *   method: string,
 *   path: string,
 *   startedAt: number,
 *   trace: LogBrewTraceContext
 * }>} AxiosState
 * @typedef {{ isInstalled: () => boolean, uninstall: () => void }} AxiosHandle
 * @typedef {Readonly<{ config: AxiosConfig, method: string, path: string, routeTemplate: string, url: string }>} AxiosInstrumentationContext
 */

const LOGBREW_AXIOS_STATE = Symbol("@logbrew/node.axiosState");
const NO_MATCHERS = 0;
/** @type {WeakMap<object, AxiosHandle>} */
const axiosInstrumentationHandles = new WeakMap();

/**
 * @param {AxiosConfig} config
 * @param {CheckedAxiosOptions} options
 * @returns {AxiosInstrumentationContext}
 */
function createAxiosInstrumentationContext(config, options) {
  const method = getAxiosMethod(config);
  const url = getAxiosUrl(config);
  const path = pathOnly(pathOnly(url));
  return {
    config,
    method,
    path,
    url,

    routeTemplate: resolveRouteTemplate(options, { config, method, path, url })
  };
}

/**
 * @param {CheckedAxiosOptions} options
 * @param {Readonly<{ captureSpan: boolean, context: AxiosInstrumentationContext, trace: LogBrewTraceContext }>} request
 * @returns {AxiosState}
 */
function createAxiosState(options, { captureSpan, context, trace }) {
  return {
    captureSpan,
    id: options.id ?? defaultAxiosSpanId({ method: context.method, path: context.routeTemplate }),
    method: context.method,
    path: pathOnly(context.routeTemplate),
    startedAt: nowMs(options),
    trace
  };
}

/**
 * @param {AxiosInstrumentationContext} context
 * @param {AxiosPlan} plan
 * @returns {Readonly<{ captureSpan: boolean, propagateTrace: boolean }>}
 */
function axiosTargets(context, plan) {
  return {
    captureSpan: plan.capture.length === NO_MATCHERS || matchesFetchTarget(context, plan.capture),
    propagateTrace: plan.propagation.length === NO_MATCHERS || matchesFetchTarget(context, plan.propagation)
  };
}

/**
 * @param {unknown} config
 * @param {AxiosPlan} plan
 * @returns {AxiosConfig}
 */
function prepareAxiosRequestConfig(config, plan) {
  const requestConfig = normalizeAxiosRequestConfig(config);
  const context = createAxiosInstrumentationContext(requestConfig, plan.options);
  const { captureSpan, propagateTrace } = axiosTargets(context, plan);
  if (!captureSpan && !propagateTrace) {
    return requestConfig;
  }
  const trace = createChildTraceContext("instrumentLogBrewAxiosInstance", plan.options.trace ?? getActiveLogBrewTrace(), plan.options);
  const nextConfig = propagateTrace ? withAxiosTraceparent(requestConfig, traceparentFor(trace)) : requestConfig;
  const state = createAxiosState(plan.options, { captureSpan, context, trace });
  Object.defineProperty(nextConfig, LOGBREW_AXIOS_STATE, { configurable: true, enumerable: false, value: state });
  return nextConfig;
}

/**
 * @param {unknown} value
 * @returns {value is AxiosState}
 */
function isCapturingState(value) {
  return isRecord(value) && Boolean(value["captureSpan"]);
}

/**
 * @param {CheckedAxiosOptions} options
 * @param {unknown} state
 * @param {Readonly<{ error?: unknown, response: unknown }>} outcome
 * @returns {Promise<void>}
 */
async function captureAxiosInterceptorSpan(options, state, { error, response }) {
  if (!isCapturingState(state)) {
    return;
  }
  await captureAxiosSpan(options, {
    durationMs: durationSince(options, state.startedAt),
    error,
    id: state.id,
    method: state.method,
    path: state.path,
    response,
    trace: state.trace
  });
}

/**
 * @param {unknown} owner
 * @returns {unknown}
 */
function axiosState(owner) {
  return readOptionalMember(readOptionalMember(owner, "config"), LOGBREW_AXIOS_STATE);
}

/**
 * @param {unknown} axiosInstance
 * @returns {object}
 */
function validateAxiosInstance(axiosInstance) {
  if (typeof axiosInstance !== "function" && (typeof axiosInstance !== "object" || axiosInstance === null)) {
    throw new SdkError("configuration_error", "instrumentLogBrewAxiosInstance requires an Axios instance");
  }
  if (typeof readMember(axiosInstance, "request") !== "function") {
    throw new SdkError("configuration_error", "instrumentLogBrewAxiosInstance requires axios.request");
  }
  const interceptors = readOptionalMember(axiosInstance, "interceptors");
  const request = readOptionalMember(interceptors, "request");
  const response = readOptionalMember(interceptors, "response");
  if (
    typeof readOptionalMember(request, "use") !== "function" ||
    typeof readOptionalMember(response, "use") !== "function" ||
    typeof readOptionalMember(request, "eject") !== "function" ||
    typeof readOptionalMember(response, "eject") !== "function"
  ) {
    throw new SdkError("configuration_error", "instrumentLogBrewAxiosInstance requires Axios interceptors");
  }
  return axiosInstance;
}

/**
 * @param {object} axiosInstance
 * @param {"request" | "response"} kind
 * @returns {unknown}
 */
function interceptorsOf(axiosInstance, kind) {
  return readMember(readMember(axiosInstance, "interceptors"), kind);
}

/**
 * @param {object} axiosInstance
 * @param {AxiosPlan} plan
 * @returns {Readonly<{ requestId: unknown, responseId: unknown }>}
 */
function useInterceptors(axiosInstance, plan) {
  const { options } = plan;
  /**
   * @param {unknown} config
   * @returns {AxiosConfig}
   */
  function prepareRequest(config) {
    return prepareAxiosRequestConfig(config, plan);
  }
  /**
   * @param {unknown} response
   * @returns {Promise<unknown>}
   */
  async function captureResponse(response) {
    await captureAxiosInterceptorSpan(options, axiosState(response), { response });
    return response;
  }
  /**
   * @param {unknown} error
   * @returns {Promise<never>}
   */
  async function captureError(error) {
    const owner = readOptionalMember(error, "config") ?? readOptionalMember(readOptionalMember(error, "response"), "config");
    await captureAxiosInterceptorSpan(options, readOptionalMember(owner, LOGBREW_AXIOS_STATE), {
      error,
      response: readOptionalMember(error, "response")
    });
    throw error;
  }
  const requestId = callMethod(interceptorsOf(axiosInstance, "request"), "use", [prepareRequest]);
  const responseId = callMethod(interceptorsOf(axiosInstance, "response"), "use", [captureResponse, captureError]);
  return { requestId, responseId };
}

/**
 * @param {object} instance
 * @param {Readonly<{ requestId: unknown, responseId: unknown }>} ids
 * @returns {AxiosHandle}
 */
function createAxiosHandle(instance, { requestId, responseId }) {
  let installed = true;
  return {
    isInstalled() {
      return installed;
    },
    uninstall() {
      if (!installed) {
        return;
      }
      callMethod(interceptorsOf(instance, "request"), "eject", [requestId]);
      callMethod(interceptorsOf(instance, "response"), "eject", [responseId]);
      installed = false;
      axiosInstrumentationHandles.delete(instance);
    }
  };
}

/**
 * @param {unknown} axiosInstance
 * @param {AxiosInstrumentationOptions} [options]
 * @returns {AxiosHandle}
 */
function instrumentLogBrewAxiosInstance(axiosInstance, options = {}) {
  const instance = validateAxiosInstance(axiosInstance);
  if (!hasClient(options)) {
    throw new SdkError("configuration_error", "instrumentLogBrewAxiosInstance requires client");
  }
  const existing = axiosInstrumentationHandles.get(instance);
  if (existing?.isInstalled() === true) {
    return existing;
  }
  const plan = {
    capture: normalizeFetchTargetMatchers(options.captureTargets),
    options,
    propagation: normalizeFetchTargetMatchers(options.tracePropagationTargets)
  };
  const handle = createAxiosHandle(instance, useInterceptors(instance, plan));
  axiosInstrumentationHandles.set(instance, handle);
  return handle;
}

module.exports = { instrumentLogBrewAxiosInstance };
