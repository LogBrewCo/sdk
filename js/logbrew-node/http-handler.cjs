"use strict";

const { STATUS_CODES } = require("node:http");
const { RecordingTransport, SdkError } = require("@logbrew/sdk");
const { applyFunction, callMethod, readMember } = require("./internal.cjs");
const { runWithLogBrewTrace, setLogBrewUser } = require("./active-trace.cjs");
const { createHttpErrorEvent, createHttpRequestEvent, createRequestTraceContext } = require("./http-events.cjs");
const { durationSince, notifyFailure, nowMs } = require("./span-support.cjs");

/**
 * @import { IncomingMessage, ServerResponse } from "node:http"
 * @import { LogBrewClient, Transport, TransportResponse } from "@logbrew/sdk"
 * @import { LogBrewNodeContext, LogBrewNodeOptions, LogBrewTraceContext } from "./index.cjs"
 */

/**
 * @typedef {(config: Readonly<Record<string, unknown>>) => LogBrewClient} CreateClient
 * @typedef {Readonly<{
 *   client: LogBrewClient,
 *   req: IncomingMessage,
 *   res: ServerResponse,
 *   trace: LogBrewTraceContext | undefined
 * }>} HookContext
 * @typedef {Readonly<{
 *   client: LogBrewClient,
 *   options: LogBrewNodeOptions,
 *   req: IncomingMessage,
 *   res: ServerResponse,
 *   startedAt: number,
 *   trace: LogBrewTraceContext,
 *   transport: Transport
 * }>} HandledRequest
 * @typedef {{
 *   errorCaptured: boolean,
 *   finalized: boolean,
 *   handlerSettled: boolean,
 *   requestFlush: Promise<boolean> | undefined,
 *   requestShutdown: boolean
 * }} HandlerState
 */

const NO_EVENTS = 0;
const CLIENT_ERROR_STATUS = 400;
const SERVER_ERROR_STATUS = 500;

/**
 * @param {HookContext} context
 * @returns {HookContext}
 */
function hookContext({ client, req, res, trace }) {
  return {
    req,
    res,

    client,
    trace
  };
}

/**
 * @param {LogBrewNodeOptions} options
 * @param {Readonly<TransportResponse>} response
 * @param {HookContext} context
 * @returns {Promise<void>}
 */
async function notifyFlush(options, response, context) {
  if (typeof options.onFlush === "function") {
    await options.onFlush(response, hookContext(context));
  }
}

/**
 * @param {() => unknown} operation
 * @returns {Promise<boolean>}
 */
async function quietly(operation) {
  try {
    await operation();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {LogBrewClient} client
 * @param {Transport} transport
 * @param {LogBrewTraceContext} [trace]
 * @returns {LogBrewNodeContext}
 */
function createLogBrewNodeContext(client, transport, trace) {
  return {
    client,
    logbrew: client,
    ...(trace ? { trace } : {}),
    setUser: (id, options = {}) => setLogBrewUser(id, { ...options, trace }),
    transport,

    previewJson: () => client.previewJson(),

    flush: async () => client.flush(transport),
    shutdown: async () => client.shutdown(transport)
  };
}

/**
 * @param {LogBrewClient} client
 * @param {unknown} event
 * @returns {void}
 */
function captureRequestEvent(client, event) {
  if (readMember(event, "type") === "span") {
    callMethod(client, "span", [readMember(event, "id"), readMember(event, "timestamp"), readMember(event, "attributes")]);
    return;
  }
  callMethod(client, "log", [readMember(event, "id"), readMember(event, "timestamp"), readMember(event, "attributes")]);
}

/**
 * @param {unknown} error
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {LogBrewNodeContext} context
 * @param {LogBrewNodeOptions} [options]
 * @returns {Promise<TransportResponse>}
 */
async function captureHttpError(error, req, res, context, options = {}) {
  const runtime = { client: context.client, req, res, trace: context.trace };
  const event = typeof options.errorEvent === "function"
    ? options.errorEvent(error, hookContext(runtime))
    : createHttpErrorEvent(error, req, { ...options, trace: context.trace });
  try {
    callMethod(context.client, "issue", [readMember(event, "id"), readMember(event, "timestamp"), readMember(event, "attributes")]);
    const response = await releaseClient(context.client, context.transport);
    await notifyFlush(options, response, runtime);
    return response;
  } catch (captureError) {
    await notifyFailure(options, captureError, hookContext(runtime));
    throw captureError;
  }
}

/**
 * @param {unknown} error
 * @returns {number | undefined}
 */
function clientErrorStatus(error) {
  const status = readMember(error, "status") ?? readMember(error, "statusCode");
  return typeof status === "number" && Number.isInteger(status) && status >= CLIENT_ERROR_STATUS && status < SERVER_ERROR_STATUS
    ? status
    : undefined;
}

/**
 * @param {ServerResponse} res
 * @param {unknown} error
 * @returns {void}
 */
function endFailedResponse(res, error) {
  if (!res.headersSent) {
    const status = clientErrorStatus(error) ?? SERVER_ERROR_STATUS;
    res.statusCode = status;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(STATUS_CODES[status] ?? "Error");
    return;
  }
  if (!res.writableEnded) {
    res.end();
  }
}

/**
 * @param {LogBrewNodeOptions} options
 * @param {Readonly<{ context: LogBrewNodeContext, error: unknown, req: IncomingMessage, res: ServerResponse }>} failure
 * @param {boolean} reported
 * @returns {Promise<void>}
 */
async function handleHttpHandlerError(options, { error, req, res, context }, reported) {
  if (reported) {
    await quietly(async () => captureHttpError(error, req, res, context, options));
  }
  if (typeof options.onError === "function") {
    await options.onError(error, hookContext({ client: context.client, req, res, trace: context.trace }));
    return;
  }
  endFailedResponse(res, error);
}

/**
 * @param {HandledRequest} request
 * @param {boolean} shutdown
 * @returns {Promise<void>}
 */
async function captureHttpRequestFinish({ client, options, req, res, startedAt, transport }, shutdown) {
  const trace = req.logbrew?.trace;
  try {
    const durationMs = durationSince(options, startedAt);
    const event = typeof options.requestEvent === "function"
      ? options.requestEvent(req, res, { client, durationMs, trace })
      : createHttpRequestEvent(req, res, { ...options, durationMs, trace });
    captureRequestEvent(client, event);
    const response = await (shutdown ? releaseClient(client, transport) : client.flush(transport));
    await notifyFlush(options, response, { client, req, res, trace });
  } catch (error) {
    await notifyFailure(options, error, hookContext({ client, req, res, trace }));
  }
}

/** @type {WeakSet<LogBrewClient>} */
const handlerClients = new WeakSet();

/**
 * @param {LogBrewClient} client
 * @returns {LogBrewClient}
 */
function ownClient(client) {
  handlerClients.add(client);
  return client;
}

/**
 * @param {LogBrewClient} client
 * @param {Transport} transport
 * @returns {Promise<TransportResponse>}
 */
async function releaseClient(client, transport) {
  return handlerClients.has(client) ? client.shutdown(transport) : client.flush(transport);
}

/**
 * @param {LogBrewNodeOptions} options
 * @param {Readonly<{ req: IncomingMessage, res: ServerResponse }>} runtime
 * @param {CreateClient} createClient
 * @returns {LogBrewClient}
 */
function resolveClient(options, runtime, createClient) {
  if (typeof options.client === "function") {
    return ownClient(options.client(runtime));
  }
  if (options.client) {
    return options.client;
  }
  const transport = typeof options.transport === "function"
    ? undefined
    : options.transport ?? RecordingTransport.alwaysAccept();
  return ownClient(createClient({ ...options, automaticDelivery: false, transport }));
}


/**
 * @param {LogBrewNodeOptions} options
 * @param {Readonly<{ client: LogBrewClient, req: IncomingMessage, res: ServerResponse }>} runtime
 * @returns {Transport}
 */
function resolveTransport(options, runtime) {
  if (typeof options.transport === "function") {
    return options.transport({
      req: runtime.req,
      res: runtime.res,

      client: runtime.client
    });
  }
  return options.transport ?? RecordingTransport.alwaysAccept();
}

/**
 * @param {HandledRequest} request
 * @returns {Promise<void>}
 */
async function shutdownAfterHandler({ client, options, req, res, trace, transport }) {
  try {
    const hasTail = client.pendingEvents() > NO_EVENTS;
    const response = await releaseClient(client, transport);
    if (hasTail) {
      await notifyFlush(options, response, { client, req, res, trace });
    }
  } catch (error) {
    await notifyFailure(options, error, hookContext({ client, req, res, trace }));
  }
}

/**
 * @param {HandledRequest} request
 * @param {HandlerState} state
 * @returns {Promise<void>}
 */
async function settleHandler(request, state) {
  state.handlerSettled = true;
  if (!state.finalized || state.requestShutdown || state.errorCaptured) {
    return;
  }
  await state.requestFlush;
  await shutdownAfterHandler(request);
}


/**
 * @param {HandledRequest} request
 * @param {HandlerState} state
 * @returns {void}
 */
function watchRequestEnd(request, state) {
  const { req, res, trace } = request;
  /** @returns {void} */
  function finalize() {
    if (state.finalized) {
      return;
    }
    state.finalized = true;
    res.removeListener("finish", finalize);
    res.removeListener("close", finalize);
    req.removeListener("aborted", finalize);
    if (!state.errorCaptured) {
      state.requestShutdown = state.handlerSettled;
      const shutdown = state.requestShutdown;
      state.requestFlush = runWithLogBrewTrace(trace, async () => quietly(async () => captureHttpRequestFinish(request, shutdown)));
    }
  }
  res.once("finish", finalize);
  res.once("close", finalize);
  req.once("aborted", finalize);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPromiseLike(value) {
  return value !== null && typeof value === "object" && typeof readMember(value, "then") === "function";
}

/**
 * @param {unknown} result
 * @param {Readonly<{ reject: (error: unknown) => Promise<void>, settle: () => Promise<void> }>} outcome
 * @returns {Promise<void>}
 */
async function followHandlerResult(result, { reject, settle }) {
  try {
    await result;
  } catch (error) {
    await reject(error);
    return;
  }
  await settle();
}

/**
 * @param {LogBrewNodeOptions} options
 * @param {Readonly<{ req: IncomingMessage, res: ServerResponse }>} runtime
 * @param {CreateClient} createClient
 * @returns {Readonly<{ client: LogBrewClient, startedAt: number, transport: Transport }>}
 */
function prepareHandledRequest(options, { req, res }, createClient) {
  const client = resolveClient(options, { req, res }, createClient);
  const transport = resolveTransport(options, { client, req, res });
  return { client, startedAt: nowMs(options), transport };
}

/**
 * @param {unknown} handler
 * @param {Readonly<{ context: LogBrewNodeContext, request: HandledRequest, state: HandlerState }>} invocation
 * @returns {void}
 */
function invokeHandler(handler, { context, request, state }) {
  const { options, req, res, trace } = request;
  /** @returns {Promise<void>} */
  async function settle() {
    return settleHandler(request, state);
  }
  /**
   * @param {unknown} error
   * @returns {Promise<void>}
   */
  async function reject(error) {
    state.handlerSettled = true;
    // A 4xx describes the request, so it stays on the request span unless the app opts in.
    const reported = options.captureClientErrors === true || clientErrorStatus(error) === undefined;
    state.errorCaptured = reported;
    await handleHttpHandlerError(options, { context, error, req, res }, reported);
    if (!reported) {
      await settle();
    }
  }
  runWithLogBrewTrace(trace, () => {
    try {
      const result = applyFunction(handler, undefined, [req, res, context]);
      if (isPromiseLike(result)) {
        void quietly(async () => followHandlerResult(result, { reject, settle }));
      } else {
        void quietly(settle);
      }
    } catch (error) {
      void quietly(async () => reject(error));
    }
  });
}

/**
 * @param {unknown} handler
 * @param {LogBrewNodeOptions} options
 * @param {CreateClient} createClient
 * @returns {(req: IncomingMessage, res: ServerResponse) => void}
 */
function createHttpHandler(handler, options, createClient) {
  if (typeof handler !== "function") {
    throw new SdkError("configuration_error", "withLogBrewHttpHandler requires a handler function");
  }
  return function logBrewHttpHandler(req, res) {
    const { client, startedAt, transport } = prepareHandledRequest(options, { req, res }, createClient);
    const trace = createRequestTraceContext(req, res, options);
    const context = createLogBrewNodeContext(client, transport, trace);
    const request = { client, options, req, res, startedAt, trace, transport };
    /** @type {HandlerState} */
    const state = { errorCaptured: false, finalized: false, handlerSettled: false, requestFlush: undefined, requestShutdown: false };
    req.logbrew = context;
    if (options.captureRequests !== false) {
      watchRequestEnd(request, state);
    }
    invokeHandler(handler, { context, request, state });
  };
}

module.exports = { captureHttpError, createHttpHandler, createLogBrewNodeContext };
