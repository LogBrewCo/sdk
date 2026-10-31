"use strict";

const { SdkError } = require("@logbrew/sdk");
const {
  defaultRouteTemplateFactory,
  elapsedMs,
  errorName,
  indexRuntime,
  isCallable,
  metadataRuntime,
  readField,
  toText,
  urlConstructor
} = require("./instrumentation-values.cjs");
const { createReactNativeGraphQLMetadataFactory } = require("./resource-fetch-graphql.cjs");
const { responseSizeBytesFromResponse } = require("./resource-fetch-size.cjs");

/**
 * @import { LogBrewClient, Metadata } from "@logbrew/sdk"
 * @import { TracePropagationTarget } from "./index.cjs"
 * @import { AppStateInput, Callable, PlatformInput, RandomValues, TraceInput } from "./instrumentation-values.cjs"
 * @import { ResourceFetchOptions } from "./instrumentation-runtime.cjs"
 */

/**
 * @typedef {{
 *   readonly appState: AppStateInput | undefined,
 *   readonly client: LogBrewClient,
 *   readonly fetchImpl: unknown,
 *   readonly measureResponseBodySize: boolean,
 *   readonly metadata: Readonly<Metadata>,
 *   readonly metadataFactory: unknown,
 *   readonly now: () => string,
 *   readonly nowMs: () => number,
 *   readonly platform: PlatformInput | undefined,
 *   readonly randomValues: RandomValues | undefined,
 *   readonly routeTemplate: string | undefined,
 *   readonly routeTemplateFactory: Callable,
 *   readonly screen: string | undefined,
 *   readonly sessionId: string | undefined,
 *   readonly trace: TraceInput | undefined,
 *   readonly traceFlags: string,
 *   readonly tracePropagationTargets: readonly TracePropagationTarget[]
 * }} ResourceFetchSettings
 * @typedef {{
 *   readonly init: unknown,
 *   readonly input: unknown,
 *   readonly method: string,
 *   readonly routeTemplate: unknown,
 *   readonly startedAtMs: number,
 *   readonly timestamp: string,
 *   readonly trace: TraceInput,
 *   readonly url: string
 * }} ResourceRequest
 */

/**
 * @param {unknown} input
 * @param {unknown} init
 * @returns {string}
 */
function requestMethod(input, init) {
  return toText(readField(init, "method") ?? readField(input, "method") ?? "GET").toUpperCase();
}

/**
 * @param {unknown} input
 * @returns {string}
 */
function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  const URLConstructor = urlConstructor();
  if (URLConstructor !== undefined && input instanceof URLConstructor) {
    return input.toString();
  }
  const url = readField(input, "url");
  if (typeof url === "string") {
    return url;
  }
  return toText(input);
}

/**
 * @param {ResourceFetchSettings} settings
 * @returns {TraceInput}
 */
function resourceTraceContext({ randomValues, trace, traceFlags }) {
  if (typeof trace === "string") {
    return indexRuntime.createReactNativeTraceContext({ randomValues, traceFlags, traceparent: trace });
  }
  return trace ?? indexRuntime.getActiveLogBrewTrace() ?? indexRuntime.createReactNativeTraceContext({ randomValues, traceFlags });
}

/**
 * @param {unknown} response
 * @returns {number | undefined}
 */
function responseStatusCode(response) {
  const status = readField(response, "status");
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

/**
 * @param {ResourceFetchSettings} settings
 * @param {ResourceRequest} request
 * @param {unknown} response
 * @returns {Promise<void>}
 */
async function captureResourceResponse(settings, request, response) {
  const responseStartDurationMs = elapsedMs(request.startedAtMs, settings.nowMs);
  const statusCode = responseStatusCode(response);
  const responseSizeBytes = await responseSizeBytesFromResponse(response, settings.measureResponseBodySize);
  const durationMs = elapsedMs(request.startedAtMs, settings.nowMs);
  indexRuntime.captureReactNativeResourceSpan(settings.client, {
    appState: settings.appState,
    durationMs,
    metadata: {
      ...metadataRuntime.createSafeReactNativeMetadata(settings.metadata, settings.metadataFactory, {
        durationMs,
        init: request.init,
        input: request.input,
        method: request.method,
        response,
        responseSizeBytes,
        responseStartDurationMs,
        routeTemplate: request.routeTemplate,
        statusCode,
        url: request.url
      }),
      responseStartDurationMs
    },
    method: request.method,
    platform: settings.platform,
    responseSizeBytes,
    routeTemplate: request.routeTemplate,
    screen: settings.screen,
    sessionId: settings.sessionId,
    statusCode,
    timestamp: request.timestamp,
    trace: request.trace
  });
}

/**
 * @param {ResourceFetchSettings} settings
 * @param {ResourceRequest} request
 * @param {unknown} error
 * @returns {void}
 */
function captureResourceFailure(settings, request, error) {
  const durationMs = elapsedMs(request.startedAtMs, settings.nowMs);
  indexRuntime.captureReactNativeResourceSpan(settings.client, {
    appState: settings.appState,
    durationMs,
    metadata: {
      ...metadataRuntime.createSafeReactNativeMetadata(settings.metadata, settings.metadataFactory, {
        durationMs,
        error,
        init: request.init,
        input: request.input,
        method: request.method,
        routeTemplate: request.routeTemplate,
        status: "error",
        url: request.url
      }),
      fetchErrorName: errorName(error),
      fetchErrorValueType: typeof error
    },
    method: request.method,
    platform: settings.platform,
    routeTemplate: request.routeTemplate,
    screen: settings.screen,
    sessionId: settings.sessionId,
    status: "error",
    timestamp: request.timestamp,
    trace: request.trace
  });
}

/**
 * @param {ResourceFetchSettings} settings
 * @param {unknown} input
 * @param {unknown} init
 * @returns {{ readonly request: ResourceRequest, readonly tracedFetch: (input: unknown, init?: unknown) => unknown }}
 */
function prepareResourceRequest(settings, input, init) {
  const startedAtMs = settings.nowMs();
  const timestamp = settings.now();
  const trace = resourceTraceContext(settings);
  const tracedFetch = indexRuntime.createTraceparentFetch({
    fetchImpl: settings.fetchImpl,
    trace,
    tracePropagationTargets: settings.tracePropagationTargets
  });
  const method = requestMethod(input, init);
  const url = requestUrl(input);
  const routeTemplate = settings.routeTemplate ?? settings.routeTemplateFactory({
    input,

    init,
    url
  });
  return { request: { init, input, method, routeTemplate, startedAtMs, timestamp, trace, url }, tracedFetch };
}

/**
 * @param {ResourceFetchSettings} settings
 * @param {unknown} input
 * @param {unknown} init
 * @returns {Promise<unknown>}
 */
async function runResourceFetch(settings, input, init) {
  const { request, tracedFetch } = prepareResourceRequest(settings, input, init);
  try {
    const response = await tracedFetch(input, init);
    await captureResourceResponse(settings, request, response);
    return response;
  } catch (error) {
    captureResourceFailure(settings, request, error);
    throw error;
  }
}

/**
 * @param {LogBrewClient} client
 * @param {ResourceFetchOptions} [options]
 * @returns {(input: unknown, init?: unknown) => Promise<unknown>}
 */
function createReactNativeResourceFetch(client, {
  appState,
  fetchImpl,
  metadata = {},
  metadataFactory,
  measureResponseBodySize = false,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  platform,
  randomValues,
  routeTemplate,
  routeTemplateFactory = defaultRouteTemplateFactory,
  screen,
  sessionId,
  trace,
  traceFlags = "01",
  tracePropagationTargets = []
} = {}) {
  if (!isCallable(routeTemplateFactory)) {
    throw new SdkError("configuration_error", "routeTemplateFactory must be a function");
  }
  if (metadataFactory !== undefined && typeof metadataFactory !== "function") {
    throw new SdkError("configuration_error", "metadataFactory must be a function");
  }
  /** @type {ResourceFetchSettings} */
  const settings = {
    appState, client, fetchImpl, measureResponseBodySize, metadata, metadataFactory, now, nowMs, platform,
    randomValues, routeTemplate, routeTemplateFactory, screen, sessionId, trace, traceFlags, tracePropagationTargets
  };
  return async function logBrewResourceFetch(input, init) {
    return runResourceFetch(settings, input, init);
  };
}

module.exports = {
  createReactNativeGraphQLMetadataFactory,
  createReactNativeResourceFetch
};
