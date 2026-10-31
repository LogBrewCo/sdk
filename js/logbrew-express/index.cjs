"use strict";

const {
  addErrorBreadcrumb,
  createErrorEvent,
  createRequestEvent,
  createRequestMetricEvent,
  createRequestTraceContext,
  getRequestTraceContext
} = require("./events.cjs");
const {
  adoptErrorObserver,
  attachFinalizers,
  claimRequestLifecycle,
  createRequestLifecycle,
  findDeliveringLifecycle,
  settleWrappedHandler
} = require("./lifecycle.cjs");
const { notifyFlush, notifyLifecycleFailure } = require("./observers.cjs");
const {
  isClientError,
  isRequestHandler,
  isThenable,
  nowMs,
  readEnvApiKey,
  readEnvServerApiKey,
  runWithTrace
} = require("./internal.cjs");
const {
  createLogBrewNodeClient,
  createNodeFetchTransport,
  getActiveLogBrewTrace,
  runWithLogBrewTrace,
  setLogBrewUser
} = require("@logbrew/node");
const { SdkError } = require("@logbrew/sdk");

/**
 * @import { NextFunction, Request, Response } from "express"
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { LogBrewClient, Transport } from "@logbrew/sdk"
 * @import {
 *   CreateLogBrewExpressClientConfig,
 *   LogBrewExpressContext,
 *   LogBrewExpressErrorHandlerOptions,
 *   LogBrewExpressHandler,
 *   LogBrewExpressOptions,
 *   LogBrewExpressRuntimeContext,
 *   LogBrewExpressSharedOptions
 * } from "./index.cjs"
 * @import { RequestLifecycle } from "./lifecycle.cjs"
 */

/**
 * @typedef {{ readonly context: LogBrewExpressRuntimeContext, readonly transport: Transport }} ErrorDelivery
 */

const DEFAULT_SDK_NAME = "logbrew-express";
const DEFAULT_SDK_VERSION = "0.1.10";
const DEFAULT_MAX_RETRIES = 2;
const NO_EVENTS = 0;

/**
 * @param {CreateLogBrewExpressClientConfig} [config]
 * @returns {LogBrewClient}
 */
function createLogBrewExpressClient({
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
      "createLogBrewExpressClient requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
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
 * @param {LogBrewExpressSharedOptions} options
 * @param {Omit<LogBrewExpressRuntimeContext, "client">} runtime
 * @returns {LogBrewClient}
 */
function resolveClient(options, runtime) {
  if (typeof options.client === "function") {
    return options.client(runtime);
  }
  if (options.client) {
    return options.client;
  }
  return createLogBrewExpressClient(options);
}

/**
 * @param {LogBrewExpressSharedOptions} options
 * @param {LogBrewExpressRuntimeContext} runtime
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
 * @param {Readonly<LogBrewTraceContext>} trace
 * @returns {(id: string, options?: Readonly<{ kind?: "user" | "anonymous" }>) => boolean}
 */
function createSetUser(trace) {
  return (id, options = {}) => setLogBrewUser(id, { ...options, trace });
}

/**
 * @param {LogBrewClient} client
 * @param {Transport} transport
 * @param {Readonly<LogBrewTraceContext>} trace
 * @returns {LogBrewExpressContext}
 */
function createRequestContext(client, transport, trace) {
  return {
    client,
    logbrew: client,

    trace,

    setUser: createSetUser(trace),
    transport,

    previewJson: () => client.previewJson(),

    flush: async () => client.flush(transport),
    shutdown: async () => client.shutdown(transport)
  };
}

/**
 * @param {LogBrewExpressOptions} [options]
 * @returns {(req: Request, res: Response, next: NextFunction) => void}
 */
function logbrewMiddleware(options = {}) {
  const defaultTransport = options.transport === undefined ? createNodeFetchTransport(options) : undefined;

  /**
   * @param {Request} req
   * @param {Response} res
   * @param {NextFunction} next
   * @returns {void}
   */
  function logBrewExpressMiddleware(req, res, next) {
    const client = resolveClient(options, { req, res });
    const transport = resolveTransport(options, { client, req, res }, defaultTransport);
    const startedAt = nowMs(options);
    const trace = createRequestTraceContext(req, res, options);
    const capturesOnFinish = options.captureRequests !== false || options.captureRequestMetrics === true;

    req.logbrew = createRequestContext(client, transport, trace);
    const lifecycle = createRequestLifecycle({
      captureOptions: capturesOnFinish ? options : undefined,
      client,
      observers: capturesOnFinish ? [options] : [],
      req,
      res,
      startedAt,
      transport
    });
    if (capturesOnFinish) {
      attachFinalizers(lifecycle);
    }
    runWithLogBrewTrace(trace, next);
  }

  return logBrewExpressMiddleware;
}

/**
 * @param {NextFunction} next
 * @param {unknown} error
 * @returns {void}
 */
function forwardRejection(next, error) {
  const rejected = Boolean(error);
  next(rejected ? error : new Error("Rejected promise"));
}

/**
 * @param {() => PromiseLike<unknown>} pending
 * @param {RequestLifecycle | undefined} lifecycle
 * @param {NextFunction} next
 * @returns {Promise<unknown>}
 */
async function awaitWrappedHandler(pending, lifecycle, next) {
  /**
   * @param {unknown} value
   * @returns {unknown}
   */
  function settleFulfilled(value) {
    settleWrappedHandler(lifecycle);
    return value;
  }

  /**
   * @param {unknown} error
   * @returns {undefined}
   */
  function settleRejected(error) {
    try {
      forwardRejection(next, error);
    } finally {
      settleWrappedHandler(lifecycle);
    }
    return undefined;
  }

  return Promise.resolve(pending()).then(settleFulfilled, settleRejected);
}

/**
 * @param {() => unknown} invoke
 * @param {RequestLifecycle | undefined} lifecycle
 * @param {NextFunction} next
 * @returns {unknown}
 */
function trackWrappedHandler(invoke, lifecycle, next) {
  try {
    const result = invoke();
    if (isThenable(result)) {
      return awaitWrappedHandler(() => result, lifecycle, next);
    }
    settleWrappedHandler(lifecycle);
    return result;
  } catch (error) {
    settleWrappedHandler(lifecycle);
    throw error;
  }
}

/**
 * @template Receiver, Result
 * @param {LogBrewExpressHandler<Result, Receiver>} handler
 * @returns {LogBrewExpressHandler<unknown, Receiver>}
 */
function withLogBrewExpressHandler(handler) {
  if (!isRequestHandler(handler)) {
    throw new SdkError("configuration_error", "withLogBrewExpressHandler requires a request handler");
  }

  /**
   * @this {Receiver}
   * @param {Request} req
   * @param {Response} res
   * @param {NextFunction} next
   * @returns {unknown}
   */
  function logBrewExpressHandler(req, res, next) {
    const lifecycle = claimRequestLifecycle(req);
    const trace = getRequestTraceContext(req) ?? getActiveLogBrewTrace();
    return runWithTrace(trace, () =>
      trackWrappedHandler(() => Reflect.apply(handler, this, [req, res, next]), lifecycle, next)
    );
  }

  return logBrewExpressHandler;
}

/**
 * @param {LogBrewExpressSharedOptions} options
 * @param {Transport} transport
 * @param {LogBrewExpressRuntimeContext} context
 * @returns {Promise<void>}
 */
async function shutdownErrorClient(options, transport, context) {
  try {
    const response = await context.client.shutdown(transport);
    await notifyFlush(options, { context, response });
  } catch (error) {
    await notifyLifecycleFailure([options], { context, error });
  }
}

/**
 * @param {LogBrewExpressErrorHandlerOptions} options
 * @param {unknown} error
 * @param {LogBrewExpressRuntimeContext} context
 * @returns {void}
 */
function recordRequestError(options, error, context) {
  const { client, req, trace } = context;
  const event =
    typeof options.errorEvent === "function"
      ? options.errorEvent(error, context)
      : createErrorEvent(error, req, { ...options, trace });
  addErrorBreadcrumb(client, req);
  client.issue(event.id, event.timestamp, event.attributes);
}

/**
 * @param {LogBrewExpressErrorHandlerOptions} options
 * @param {unknown} error
 * @param {ErrorDelivery} delivery
 * @returns {void}
 */
function captureRequestError(options, error, delivery) {
  const { context, transport } = delivery;
  const lifecycle = findDeliveringLifecycle(context.req, context.client, transport);
  try {
    recordRequestError(options, error, context);
    if (lifecycle === undefined) {
      void shutdownErrorClient(options, transport, context);
    } else {
      adoptErrorObserver(lifecycle, options);
    }
  } catch (captureError) {
    void notifyLifecycleFailure([options], { context, error: captureError });
    if (lifecycle === undefined && context.client.pendingEvents() > NO_EVENTS) {
      void shutdownErrorClient(options, transport, context);
    }
  }
}

/**
 * @param {LogBrewExpressErrorHandlerOptions} [options]
 * @returns {(error: unknown, req: Request, res: Response, next: NextFunction) => void}
 */
function logbrewErrorHandler(options = {}) {
  const defaultTransport = options.transport === undefined ? createNodeFetchTransport(options) : undefined;

  /**
   * @param {unknown} error
   * @param {Request} req
   * @param {Response} res
   * @param {NextFunction} next
   * @returns {void}
   */
  function logBrewExpressErrorHandler(error, req, res, next) {
    if (options.captureClientErrors !== true && isClientError(error)) {
      next(error);
      return;
    }
    const existing = req.logbrew;
    const client = existing?.client ?? resolveClient(options, { req, res });
    const transport = existing?.transport ?? resolveTransport(options, { client, req, res }, defaultTransport);
    const trace = existing?.trace ?? getActiveLogBrewTrace();
    const context = { client, req, res, trace };
    runWithTrace(trace, () => {
      captureRequestError(options, error, { context, transport });
      next(error);
    });
  }

  return logBrewExpressErrorHandler;
}

module.exports = {
  createErrorEvent,
  createLogBrewExpressClient,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware,
  withLogBrewExpressHandler,

  default: {
    createErrorEvent,
    createLogBrewExpressClient,
    createRequestEvent,
    createRequestMetricEvent,
    getActiveLogBrewTrace,
    logbrewErrorHandler,
    logbrewMiddleware,
    withLogBrewExpressHandler
  }
};
