"use strict";

const { addApplicationLogCloseHook, installFastifyApplicationLogCapture } = require("./application-logs.cjs");
const { readEnvApiKey, readEnvServerApiKey, readField } = require("./internal.cjs");
const {
  createErrorEvent,
  createRequestEvent,
  createRequestMetricEvent,
  createRequestTraceContext,
  getRequestTraceContext
} = require("./events.cjs");
const {
  createLogBrewNodeClient,
  createNodeFetchTransport,
  enterWithLogBrewTrace,
  getActiveLogBrewTrace
} = require("@logbrew/node");
const { SdkError } = require("@logbrew/sdk");
const fp = require("fastify-plugin");

/**
 * @import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { LogBrewClient, Transport, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   CreateLogBrewFastifyClientConfig,
 *   LogBrewFastifyContext,
 *   LogBrewFastifyOptions,
 *   LogBrewFastifyRuntimeContext,
 *   LogBrewRequestEvent,
 *   LogBrewRequestMetricEvent
 * } from "./index.cjs"
 * @import { TransportSource } from "./internal.cjs"
 */

/**
 * @typedef {{
 *   readonly capturesRequestFinish: boolean,
 *   readonly markStarted: (request: FastifyRequest) => void,
 *   readonly options: LogBrewFastifyOptions,
 *   readonly source: TransportSource,
 *   readonly startedAt: (request: FastifyRequest) => number
 * }} PluginState
 * @typedef {{ readonly error: unknown, readonly reply: FastifyReply, readonly request: FastifyRequest }} RequestFailure
 * @typedef {{
 *   readonly client: LogBrewClient,
 *   readonly durationMs: number,
 *   readonly reply: FastifyReply,
 *   readonly request: FastifyRequest,
 *   readonly trace: Readonly<LogBrewTraceContext> | undefined
 * }} FinishedRequest
 * @typedef {LogBrewFastifyRuntimeContext & { readonly transport: Transport }} FailureTarget
 */

const DEFAULT_SDK_NAME = "logbrew-fastify";
const DEFAULT_SDK_VERSION = "0.1.8";
const DEFAULT_MAX_RETRIES = 2;
const MIN_DURATION_MS = 0;

/**
 * @param {CreateLogBrewFastifyClientConfig} [config]
 * @returns {LogBrewClient}
 */
function createLogBrewFastifyClient({
  apiKey,
  captureRuntimeContext = true,
  context,
  maxRetries = DEFAULT_MAX_RETRIES,
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  serverApiKey
} = {}) {
  const authKey = serverApiKey ?? apiKey ?? readEnvServerApiKey() ?? readEnvApiKey();
  if (authKey === undefined || authKey === "") {
    throw new SdkError(
      "configuration_error",
      "createLogBrewFastifyClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
    );
  }
  return createLogBrewNodeClient({
    serverApiKey: authKey,

    automaticDelivery: false,
    captureRuntimeContext,
    ...(context === undefined ? {} : { context }),
    sdkName,
    sdkVersion,

    maxRetries
  });
}

/**
 * @param {LogBrewFastifyOptions} options
 * @returns {number}
 */
function nowMs(options) {
  if (typeof options.nowMs === "function") {
    return options.nowMs();
  }
  return performance.now();
}

/**
 * @param {FastifyInstance} fastify
 * @returns {void}
 */
function ensureRequestDecorator(fastify) {
  if (typeof fastify.hasRequestDecorator === "function" && fastify.hasRequestDecorator("logbrew")) {
    return;
  }
  try {
    fastify.decorateRequest("logbrew", undefined);
  } catch (error) {
    if (readField(error, "code") !== "FST_ERR_DEC_ALREADY_PRESENT") {
      throw error;
    }
  }
}

/**
 * @param {LogBrewFastifyOptions} options
 * @returns {TransportSource}
 */
function createTransportSource(options) {
  const { transport } = options;
  if (typeof transport === "function") {
    return { factory: transport };
  }
  return { transport: transport ?? createNodeFetchTransport(options) };
}

/**
 * @param {TransportSource} source
 * @param {LogBrewFastifyRuntimeContext} runtime
 * @returns {Transport}
 */
function resolveTransport(source, runtime) {
  return "factory" in source ? source.factory(runtime) : source.transport;
}

/**
 * @param {LogBrewFastifyOptions} options
 * @param {FastifyRequest} request
 * @param {FastifyReply} reply
 * @returns {LogBrewClient}
 */
function resolveClient(options, request, reply) {
  if (typeof options.client === "function") {
    return options.client({ reply, request });
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewFastifyClient(options);
}

/**
 * @param {LogBrewClient} client
 * @param {Transport} transport
 * @param {Readonly<LogBrewTraceContext>} trace
 * @returns {LogBrewFastifyContext}
 */
function createRequestContext(client, transport, trace) {
  return {
    client,
    flush: async () => client.flush(transport),
    logbrew: client,
    previewJson: () => client.previewJson(),
    shutdown: async () => client.shutdown(transport),
    trace,
    transport
  };
}

/**
 * @param {FastifyRequest} request
 * @returns {void}
 */
function enterRequestTraceContext(request) {
  const trace = getRequestTraceContext(request);
  if (trace) {
    enterWithLogBrewTrace(trace);
  }
}

/**
 * @param {LogBrewFastifyOptions} options
 * @param {Readonly<TransportResponse>} response
 * @param {LogBrewFastifyRuntimeContext} context
 * @returns {Promise<void>}
 */
async function notifyFlush(options, response, context) {
  if (typeof options.onFlush === "function") {
    await options.onFlush(response, context);
  }
}

/**
 * @param {LogBrewFastifyOptions} options
 * @param {unknown} error
 * @param {LogBrewFastifyRuntimeContext} context
 * @returns {Promise<void>}
 */
async function notifyFailure(options, error, context) {
  if (typeof options.onCaptureError === "function") {
    await options.onCaptureError(error, context);
  }
}

/**
 * @param {LogBrewFastifyOptions} options
 * @param {FinishedRequest} finished
 * @returns {void}
 */
function captureFinishedRequest(options, finished) {
  const { client, durationMs, reply, request, trace } = finished;
  if (options.captureRequests !== false) {
    /** @type {LogBrewRequestEvent} */
    const event =
      typeof options.requestEvent === "function"
        ? options.requestEvent(request, reply, { client, durationMs, trace })
        : createRequestEvent(request, reply, { ...options, durationMs, trace });
    if (event.type === "span") {
      client.span(event.id, event.timestamp, event.attributes);
    } else {
      client.log(event.id, event.timestamp, event.attributes);
    }
  }
  if (options.captureRequestMetrics === true) {
    /** @type {LogBrewRequestMetricEvent} */
    const metricEvent =
      typeof options.requestMetricEvent === "function"
        ? options.requestMetricEvent(request, reply, { client, durationMs, trace })
        : createRequestMetricEvent(request, reply, { ...options, durationMs, idFactory: options.metricIdFactory });
    client.metric(metricEvent.id, metricEvent.timestamp, metricEvent.attributes);
  }
}

/**
 * @param {PluginState} state
 * @param {FastifyRequest} request
 * @param {FastifyReply} reply
 * @returns {Promise<void>}
 */
async function captureRequestFinish(state, request, reply) {
  const startedAt = state.startedAt(request);
  const existing = request.logbrew;
  if (!existing) {
    return;
  }
  const { client, trace } = existing;
  try {
    const durationMs = Math.max(MIN_DURATION_MS, Math.round(nowMs(state.options) - startedAt));
    captureFinishedRequest(state.options, { client, durationMs, reply, request, trace });
    await notifyFlush(state.options, await client.shutdown(existing.transport), { client, reply, request, trace });
  } catch (error) {
    await notifyFailure(state.options, error, { client, reply, request, trace });
  }
}

/**
 * @param {PluginState} state
 * @param {RequestFailure} failure
 * @returns {FailureTarget}
 */
function resolveFailureTarget(state, failure) {
  const { reply, request } = failure;
  const existing = request.logbrew;
  const client = existing?.client ?? resolveClient(state.options, request, reply);
  const transport = existing?.transport ?? resolveTransport(state.source, { client, reply, request });
  return { client, reply, request, trace: existing?.trace ?? getActiveLogBrewTrace(), transport };
}

/**
 * @param {PluginState} state
 * @param {RequestFailure} failure
 * @returns {Promise<void>}
 */
async function captureRequestError(state, failure) {
  const { options } = state;
  const { transport, ...runtime } = resolveFailureTarget(state, failure);
  const event =
    typeof options.errorEvent === "function"
      ? options.errorEvent(failure.error, runtime)
      : createErrorEvent(failure.error, runtime.request, { now: options.now, trace: runtime.trace });
  try {
    runtime.client.issue(event.id, event.timestamp, event.attributes);
    if (!state.capturesRequestFinish) {
      await notifyFlush(options, await runtime.client.shutdown(transport), runtime);
    }
  } catch (captureError) {
    await notifyFailure(options, captureError, runtime);
  }
}

/**
 * @param {FastifyInstance} fastify
 * @param {PluginState} state
 * @returns {void}
 */
function addRequestHooks(fastify, state) {
  const { options } = state;
  fastify.addHook("onRequest", async (request, reply) => {
    const client = resolveClient(options, request, reply);
    const transport = resolveTransport(state.source, { client, reply, request });
    const trace = createRequestTraceContext(request, reply, options);
    state.markStarted(request);
    request.logbrew = createRequestContext(client, transport, trace);
    enterRequestTraceContext(request);
  });
  fastify.addHook("preHandler", async (request) => {
    enterRequestTraceContext(request);
  });
  if (state.capturesRequestFinish) {
    fastify.addHook("onResponse", async (request, reply) => {
      enterRequestTraceContext(request);
      await captureRequestFinish(state, request, reply);
    });
  }
  fastify.addHook("onError", async (request, reply, error) => {
    enterRequestTraceContext(request);
    await captureRequestError(state, { error, reply, request });
  });
}

/**
 * @param {LogBrewFastifyOptions} options
 * @returns {Pick<PluginState, "markStarted" | "startedAt">}
 */
function createRequestTiming(options) {
  /** @type {WeakMap<FastifyRequest, number>} */
  const startedAtByRequest = new WeakMap();
  return {
    markStarted: (request) => {
      startedAtByRequest.set(request, nowMs(options));
    },
    startedAt: (request) => startedAtByRequest.get(request) ?? nowMs(options)
  };
}

/**
 * @param {FastifyInstance} fastify
 * @param {LogBrewFastifyOptions} options
 * @returns {Promise<void>}
 */
async function logbrewFastifyPluginImpl(fastify, options = {}) {
  ensureRequestDecorator(fastify);
  const source = createTransportSource(options);
  const applicationLogCapture = installFastifyApplicationLogCapture(fastify, {
    identity: { sdkName: DEFAULT_SDK_NAME, sdkVersion: DEFAULT_SDK_VERSION },
    options,
    source
  });
  if (applicationLogCapture) {
    addApplicationLogCloseHook(fastify, options, applicationLogCapture);
  }
  addRequestHooks(fastify, {
    ...createRequestTiming(options),
    capturesRequestFinish: options.captureRequests !== false || options.captureRequestMetrics === true,
    options,
    source
  });
}

const logbrewFastifyPlugin = fp(logbrewFastifyPluginImpl, {
  fastify: ">=4",
  name: "logbrew-fastify"
});
const logbrewPlugin = logbrewFastifyPlugin;

module.exports = {
  createErrorEvent,
  createLogBrewFastifyClient,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,

  default: {
    createErrorEvent,
    createLogBrewFastifyClient,
    createRequestEvent,
    createRequestMetricEvent,
    getActiveLogBrewTrace,
    logbrewFastifyPlugin,
    logbrewPlugin
  },
  logbrewFastifyPlugin,
  logbrewPlugin
};
