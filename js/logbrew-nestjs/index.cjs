"use strict";

const {
  createErrorEvent,
  createRequestEvent,
  createRequestMetricEvent,
  createRequestTraceContext
} = require("./events.cjs");
const { readEnvApiKey, readEnvServerApiKey } = require("./internal.cjs");
const { createNestLogger } = require("./logger.cjs");
const {
  createLogBrewNodeClient,
  createNodeFetchTransport,
  getActiveLogBrewTrace,
  runWithLogBrewTrace,
  setLogBrewUser
} = require("@logbrew/node");
const { SdkError } = require("@logbrew/sdk");
const rxjs = require("rxjs");

/**
 * @import { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common"
 * @import { Request, Response } from "express"
 * @import { Observable } from "rxjs"
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { LogBrewClient, Transport, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   CreateLogBrewNestClientConfig,
 *   LogBrewNestContext,
 *   LogBrewNestLogger,
 *   LogBrewNestLoggerOptions,
 *   LogBrewNestOptions,
 *   LogBrewNestRuntimeContext,
 *   LogBrewRequestEvent,
 *   LogBrewRequestMetricEvent
 * } from "./index.cjs"
 */

/**
 * @typedef {{
 *   readonly client: LogBrewClient,
 *   readonly executionContext: ExecutionContext,
 *   readonly request: Request,
 *   readonly response: Response,
 *   readonly shutdownClient: boolean,
 *   readonly trace: Readonly<LogBrewTraceContext>,
 *   readonly transport: Transport
 * }} InterceptedRequest
 * @typedef {InterceptedRequest & { readonly startedAt: number }} TimedRequest
 */

const DEFAULT_SDK_NAME = "logbrew-nestjs";
const DEFAULT_SDK_VERSION = "0.1.9";
const DEFAULT_MAX_RETRIES = 2;
const MIN_DURATION_MS = 0;

/**
 * @param {CreateLogBrewNestClientConfig} [config]
 * @returns {LogBrewClient}
 */
function createLogBrewNestClient({
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
      "createLogBrewNestClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
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
 * @param {LogBrewNestLoggerOptions} [options]
 * @returns {LogBrewNestLogger}
 */
function createLogBrewNestLogger(options = {}) {
  return createNestLogger(options, options.client ?? createLogBrewNestClient(options));
}

/**
 * @param {LogBrewNestOptions} options
 * @returns {number}
 */
function nowMs(options) {
  if (typeof options.nowMs === "function") {
    return options.nowMs();
  }
  return performance.now();
}

/**
 * @param {LogBrewNestOptions} options
 * @param {Omit<LogBrewNestRuntimeContext, "client">} runtime
 * @returns {LogBrewClient}
 */
function resolveClient(options, runtime) {
  if (typeof options.client === "function") {
    return options.client(runtime);
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewNestClient(options);
}

/**
 * @param {LogBrewNestOptions} options
 * @param {LogBrewNestRuntimeContext} runtime
 * @param {Transport | undefined} defaultTransport
 * @returns {Transport}
 */
function resolveTransport(options, runtime, defaultTransport) {
  if (typeof options.transport === "function") {
    return options.transport(runtime);
  }
  return options.transport ?? defaultTransport ?? createNodeFetchTransport(options);
}

/**
 * @param {LogBrewClient} client
 * @param {Transport} transport
 * @param {boolean} shutdownClient
 * @returns {Promise<TransportResponse>}
 */
async function flushCapturedClient(client, transport, shutdownClient) {
  return shutdownClient ? client.shutdown(transport) : client.flush(transport);
}

/**
 * @param {Readonly<LogBrewTraceContext>} trace
 * @returns {(id: string, options?: Readonly<{ kind?: "user" | "anonymous" }>) => boolean}
 */
function createSetUser(trace) {
  return (id, options = {}) => setLogBrewUser(id, { ...options, trace });
}

/**
 * @param {InterceptedRequest} intercepted
 * @returns {LogBrewNestContext}
 */
function createRequestContext(intercepted) {
  const { client, shutdownClient, trace, transport } = intercepted;
  return {
    client,
    logbrew: client,
    setUser: createSetUser(trace),
    trace,
    transport,

    previewJson: () => client.previewJson(),

    flush: async () => client.flush(transport),
    shutdown: async () => flushCapturedClient(client, transport, shutdownClient)
  };
}

/**
 * @param {LogBrewNestOptions} options
 * @param {Readonly<TransportResponse>} response
 * @param {LogBrewNestRuntimeContext} context
 * @returns {Promise<void>}
 */
async function notifyFlush(options, response, context) {
  if (typeof options.onFlush === "function") {
    await options.onFlush(response, context);
  }
}

/**
 * @param {LogBrewNestOptions} options
 * @param {unknown} error
 * @param {LogBrewNestRuntimeContext} context
 * @returns {Promise<void>}
 */
async function notifyFailure(options, error, context) {
  if (typeof options.onCaptureError === "function") {
    await options.onCaptureError(error, context);
  }
}

/**
 * @param {LogBrewNestOptions} options
 * @param {InterceptedRequest} intercepted
 * @param {number} durationMs
 * @returns {void}
 */
function recordFinishedRequest(options, intercepted, durationMs) {
  const { client, executionContext, request, response, trace } = intercepted;
  if (options.captureRequests !== false) {
    /** @type {LogBrewRequestEvent} */
    const event =
      typeof options.requestEvent === "function"
        ? options.requestEvent(request, response, { client, durationMs, executionContext, trace })
        : createRequestEvent(request, response, { ...options, durationMs, trace });
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
        ? options.requestMetricEvent(request, response, { client, durationMs, executionContext, trace })
        : createRequestMetricEvent(request, response, { ...options, durationMs, idFactory: options.metricIdFactory });
    client.metric(metricEvent.id, metricEvent.timestamp, metricEvent.attributes);
  }
}

/**
 * @param {LogBrewNestOptions} options
 * @param {TimedRequest} intercepted
 * @returns {Promise<void>}
 */
async function captureRequestFinish(options, intercepted) {
  const { client, executionContext, request, response, shutdownClient, startedAt, trace, transport } = intercepted;
  const runtime = { client, executionContext, request, response, trace };
  try {
    const durationMs = Math.max(MIN_DURATION_MS, Math.round(nowMs(options) - startedAt));
    recordFinishedRequest(options, intercepted, durationMs);
    await notifyFlush(options, await flushCapturedClient(client, transport, shutdownClient), runtime);
  } catch (error) {
    await notifyFailure(options, error, runtime);
  }
}

/**
 * @param {LogBrewNestOptions} options
 * @param {InterceptedRequest} intercepted
 * @param {unknown} error
 * @returns {Promise<void>}
 */
async function captureRequestError(options, intercepted, error) {
  const { client, executionContext, request, response, shutdownClient, transport } = intercepted;
  const runtime = { client, executionContext, request, response, trace: intercepted.trace };
  const event =
    typeof options.errorEvent === "function"
      ? options.errorEvent(error, runtime)
      : createErrorEvent(error, request, { now: options.now, trace: runtime.trace });
  try {
    client.issue(event.id, event.timestamp, event.attributes);
    await notifyFlush(options, await flushCapturedClient(client, transport, shutdownClient), runtime);
  } catch (captureError) {
    await notifyFailure(options, captureError, runtime);
  }
}

/**
 * @param {LogBrewNestOptions} options
 * @param {InterceptedRequest} intercepted
 * @returns {(error: unknown) => Observable<never>}
 */
function captureAndRethrow(options, intercepted) {
  return (error) => {
    void captureRequestError(options, intercepted, error);
    return rxjs.throwError(() => error);
  };
}

/**
 * @param {LogBrewNestOptions} options
 * @param {Transport | undefined} defaultTransport
 * @param {ExecutionContext} executionContext
 * @returns {InterceptedRequest}
 */
function interceptRequest(options, defaultTransport, executionContext) {
  const http = executionContext.switchToHttp();
  /** @type {Request} */
  const request = http.getRequest();
  /** @type {Response} */
  const response = http.getResponse();
  const client = resolveClient(options, { executionContext, request, response });
  const transport = resolveTransport(options, { client, executionContext, request, response }, defaultTransport);
  const trace = createRequestTraceContext(request, response, options);
  return { client, executionContext, request, response, shutdownClient: !options.client, trace, transport };
}

/**
 * @param {LogBrewNestOptions} options
 * @param {TimedRequest} intercepted
 * @param {CallHandler<unknown>} next
 * @returns {Observable<unknown>}
 */
function handleWithCapture(options, intercepted, next) {
  return next.handle().pipe(
    rxjs.tap({
      complete: () => {
        if (options.captureRequests !== false || options.captureRequestMetrics === true) {
          void captureRequestFinish(options, intercepted);
        }
      }
    }),
    rxjs.catchError(captureAndRethrow(options, intercepted))
  );
}

/** @implements {NestInterceptor} */
class LogBrewInterceptor {
  /**
   * @param {LogBrewNestOptions} [options]
   */
  constructor(options = {}) {
    /** @readonly */
    this.options = options;
    /** @readonly */
    this.defaultTransport = options.transport === undefined ? createNodeFetchTransport(options) : undefined;
  }

  /**
   * @param {ExecutionContext} executionContext
   * @param {CallHandler<unknown>} next
   * @returns {Observable<unknown>}
   */
  intercept(executionContext, next) {
    const { defaultTransport, options } = this;
    const intercepted = interceptRequest(options, defaultTransport, executionContext);
    const timed = { ...intercepted, startedAt: nowMs(options) };
    intercepted.request.logbrew = createRequestContext(intercepted);
    return new rxjs.Observable((subscriber) =>
      runWithLogBrewTrace(intercepted.trace, () => handleWithCapture(options, timed, next).subscribe(subscriber))
    );
  }
}

module.exports = {
  createErrorEvent,
  createLogBrewNestClient,
  createLogBrewNestLogger,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,

  default: {
    createErrorEvent,
    createLogBrewNestClient,
    createLogBrewNestLogger,
    createRequestEvent,
    createRequestMetricEvent,
    getActiveLogBrewTrace,

    LogBrewInterceptor
  },

  LogBrewInterceptor
};
