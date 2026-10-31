"use strict";

const { once } = require("node:events");
const { createCell, nowMs, readField, runWithTrace } = require("./internal.cjs");
const { createObserverList, notifyLifecycleFailure, notifyLifecycleFlush } = require("./observers.cjs");
const { createRequestEvent, createRequestMetricEvent, getRequestTraceContext } = require("./events.cjs");

/**
 * @import { Request, Response } from "express"
 * @import { LogBrewTraceContext } from "@logbrew/node"
 * @import { LogBrewClient, Transport, TransportResponse } from "@logbrew/sdk"
 * @import { LogBrewExpressOptions, LogBrewExpressRuntimeContext, LogBrewExpressSharedOptions } from "./index.cjs"
 * @import { Cell } from "./internal.cjs"
 * @import { ObserverList } from "./observers.cjs"
 */

/**
 * @typedef {{
 *   readonly captureOptions: LogBrewExpressOptions | undefined,
 *   readonly client: LogBrewClient,
 *   readonly observers: readonly LogBrewExpressSharedOptions[],
 *   readonly req: Request,
 *   readonly res: Response,
 *   readonly startedAt: number,
 *   readonly transport: Transport
 * }} LifecycleInit
 * @typedef {{
 *   readonly activeHandlers: Cell<number>,
 *   readonly captureOptions: LogBrewExpressOptions | undefined,
 *   readonly client: LogBrewClient,
 *   readonly deferredShutdown: Cell<boolean>,
 *   readonly deliverySettled: Cell<() => Promise<unknown>>,
 *   readonly finalized: Cell<boolean>,
 *   readonly finalizersAttached: Cell<boolean>,
 *   readonly listener: () => void,
 *   readonly observers: ObserverList,
 *   readonly released: Cell<boolean>,
 *   readonly req: Request,
 *   readonly res: Response,
 *   readonly shutdownScheduled: Cell<boolean>,
 *   readonly startedAt: number,
 *   readonly transport: Transport,
 *   readonly wrapped: Cell<boolean>
 * }} RequestLifecycle
 * @typedef {{ readonly durationMs: number, readonly trace: Readonly<LogBrewTraceContext> | undefined }} Measurement
 */

const SETTLED = "settled";
const NO_HANDLERS = 0;
const HANDLER_STEP = 1;
const NO_DURATION = 0;
const NO_EVENTS = 0;

/** @type {WeakMap<Request, RequestLifecycle>} */
const requestLifecycles = new WeakMap();

/**
 * @returns {Promise<unknown>}
 */
async function settledDelivery() {
  return undefined;
}

/**
 * @param {RequestLifecycle} lifecycle
 * @returns {LogBrewExpressRuntimeContext}
 */
function runtimeContext(lifecycle) {
  const { client, req, res } = lifecycle;
  return { client, req, res, trace: getRequestTraceContext(req) };
}

/**
 * @param {RequestLifecycle} lifecycle
 * @returns {void}
 */
function releaseRequestLifecycle(lifecycle) {
  lifecycle.released.set(true);
  if (requestLifecycles.get(lifecycle.req) === lifecycle) {
    requestLifecycles.delete(lifecycle.req);
  }
}

/**
 * @param {RequestLifecycle} lifecycle
 * @returns {Promise<void>}
 */
async function shutdownReleasedLifecycle(lifecycle) {
  const context = runtimeContext(lifecycle);
  try {
    const hasTail = lifecycle.client.pendingEvents() > NO_EVENTS;
    const response = await lifecycle.client.shutdown(lifecycle.transport);
    if (hasTail) {
      await notifyLifecycleFlush([...lifecycle.observers.items()], { context, response });
    }
  } catch (error) {
    await notifyLifecycleFailure([...lifecycle.observers.items()], { context, error });
  }
}

/**
 * @param {RequestLifecycle} lifecycle
 * @returns {Promise<void>}
 */
async function shutdownWrappedLifecycle(lifecycle) {
  const waitForDelivery = lifecycle.deliverySettled.get();
  await waitForDelivery();
  if (lifecycle.activeHandlers.get() > NO_HANDLERS) {
    lifecycle.shutdownScheduled.set(false);
    return;
  }
  releaseRequestLifecycle(lifecycle);
  await shutdownReleasedLifecycle(lifecycle);
}

/**
 * @param {RequestLifecycle} lifecycle
 * @returns {void}
 */
function scheduleWrappedShutdown(lifecycle) {
  if (
    !lifecycle.finalized.get() ||
    !lifecycle.deferredShutdown.get() ||
    lifecycle.activeHandlers.get() !== NO_HANDLERS ||
    lifecycle.shutdownScheduled.get()
  ) {
    return;
  }
  lifecycle.shutdownScheduled.set(true);
  void runWithTrace(getRequestTraceContext(lifecycle.req), async () => shutdownWrappedLifecycle(lifecycle));
}

/**
 * @param {LogBrewExpressOptions} options
 * @param {RequestLifecycle} lifecycle
 * @param {Measurement} measurement
 * @returns {void}
 */
function captureRequestSpan(options, lifecycle, measurement) {
  const { client, req, res } = lifecycle;
  const { durationMs, trace } = measurement;
  const event =
    typeof options.requestEvent === "function"
      ? options.requestEvent(req, res, { client, durationMs, trace })
      : createRequestEvent(req, res, { ...options, durationMs, trace });
  if (event.type === "span") {
    client.span(event.id, event.timestamp, event.attributes);
    return;
  }
  client.log(event.id, event.timestamp, event.attributes);
}

/**
 * @param {LogBrewExpressOptions} options
 * @param {RequestLifecycle} lifecycle
 * @param {Measurement} measurement
 * @returns {void}
 */
function captureRequestMetric(options, lifecycle, measurement) {
  const { client, req, res } = lifecycle;
  const { durationMs, trace } = measurement;
  const event =
    typeof options.requestMetricEvent === "function"
      ? options.requestMetricEvent(req, res, { client, durationMs, trace })
      : createRequestMetricEvent(req, res, { ...options, durationMs, idFactory: options.metricIdFactory });
  client.metric(event.id, event.timestamp, event.attributes);
}

/**
 * @param {LogBrewExpressOptions} options
 * @param {RequestLifecycle} lifecycle
 * @param {Readonly<LogBrewTraceContext> | undefined} trace
 * @returns {void}
 */
function captureRequestTelemetry(options, lifecycle, trace) {
  const measurement = {
    durationMs: Math.max(NO_DURATION, Math.round(nowMs(options) - lifecycle.startedAt)),
    trace
  };
  if (options.captureRequests !== false) {
    captureRequestSpan(options, lifecycle, measurement);
  }
  if (options.captureRequestMetrics === true) {
    captureRequestMetric(options, lifecycle, measurement);
  }
}

/**
 * @param {RequestLifecycle} lifecycle
 * @param {Readonly<LogBrewTraceContext> | undefined} trace
 * @returns {unknown}
 */
function captureFinishedRequest(lifecycle, trace) {
  const options = lifecycle.captureOptions;
  if (options === undefined) {
    return undefined;
  }
  try {
    captureRequestTelemetry(options, lifecycle, trace);
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * @param {RequestLifecycle} lifecycle
 * @returns {Promise<TransportResponse>}
 */
async function deliverRequestEvents(lifecycle) {
  return lifecycle.deferredShutdown.get()
    ? lifecycle.client.flush(lifecycle.transport)
    : lifecycle.client.shutdown(lifecycle.transport);
}

/**
 * @param {RequestLifecycle} lifecycle
 * @returns {void}
 */
function detachFinalizers(lifecycle) {
  lifecycle.res.removeListener("finish", lifecycle.listener);
  lifecycle.res.removeListener("close", lifecycle.listener);
  lifecycle.req.removeListener("aborted", lifecycle.listener);
}

/**
 * @param {RequestLifecycle} lifecycle
 * @returns {() => void}
 */
function beginFinalize(lifecycle) {
  lifecycle.finalized.set(true);
  lifecycle.deferredShutdown.set(lifecycle.activeHandlers.get() > NO_HANDLERS);
  if (!lifecycle.deferredShutdown.get()) {
    releaseRequestLifecycle(lifecycle);
  }
  const delivery = new EventTarget();
  const settled = once(delivery, SETTLED);
  lifecycle.deliverySettled.set(async () => settled);
  detachFinalizers(lifecycle);
  return () => {
    delivery.dispatchEvent(new Event(SETTLED));
  };
}

/**
 * @param {RequestLifecycle} lifecycle
 * @param {LogBrewExpressRuntimeContext} context
 * @param {() => void} settle
 * @returns {Promise<void>}
 */
async function deliverAndNotify(lifecycle, context, settle) {
  try {
    const deliveryObservers = [...lifecycle.observers.items()];
    const response = await deliverRequestEvents(lifecycle);
    settle();
    scheduleWrappedShutdown(lifecycle);
    await notifyLifecycleFlush(deliveryObservers, { context, response });
  } catch (error) {
    settle();
    scheduleWrappedShutdown(lifecycle);
    await notifyLifecycleFailure(lifecycle.observers.items(), { context, error });
  }
}

/**
 * @param {RequestLifecycle} lifecycle
 * @returns {Promise<void>}
 */
async function finalizeRequestLifecycle(lifecycle) {
  if (lifecycle.finalized.get()) {
    return;
  }
  const settle = beginFinalize(lifecycle);
  const context = runtimeContext(lifecycle);
  const captureError = captureFinishedRequest(lifecycle, context.trace);
  const captureFailed = Boolean(captureError);
  if (captureFailed) {
    await notifyLifecycleFailure(lifecycle.observers.items(), { context, error: captureError });
  }
  await deliverAndNotify(lifecycle, context, settle);
}

/**
 * @param {LifecycleInit} init
 * @returns {RequestLifecycle}
 */
function createRequestLifecycle(init) {
  /** @type {RequestLifecycle} */
  const lifecycle = {
    activeHandlers: createCell(NO_HANDLERS),
    captureOptions: init.captureOptions,
    client: init.client,
    deferredShutdown: createCell(false),
    deliverySettled: createCell(settledDelivery),
    finalized: createCell(false),
    finalizersAttached: createCell(false),
    listener: () => {
      void runWithTrace(getRequestTraceContext(lifecycle.req), async () => finalizeRequestLifecycle(lifecycle));
    },
    observers: createObserverList(init.observers),
    released: createCell(false),
    req: init.req,
    res: init.res,
    shutdownScheduled: createCell(false),
    startedAt: init.startedAt,
    transport: init.transport,
    wrapped: createCell(false)
  };
  requestLifecycles.set(init.req, lifecycle);
  return lifecycle;
}

/**
 * @param {RequestLifecycle} lifecycle
 * @returns {void}
 */
function attachFinalizers(lifecycle) {
  if (lifecycle.finalizersAttached.get()) {
    return;
  }
  lifecycle.finalizersAttached.set(true);
  lifecycle.res.once("finish", lifecycle.listener);
  lifecycle.res.once("close", lifecycle.listener);
  lifecycle.req.once("aborted", lifecycle.listener);
}

/**
 * @param {Request} req
 * @returns {RequestLifecycle | undefined}
 */
function claimRequestLifecycle(req) {
  const lifecycle = requestLifecycles.get(req);
  if (lifecycle === undefined || lifecycle.released.get()) {
    return undefined;
  }
  lifecycle.wrapped.set(true);
  lifecycle.activeHandlers.set(lifecycle.activeHandlers.get() + HANDLER_STEP);
  return lifecycle;
}

/**
 * @param {RequestLifecycle | undefined} lifecycle
 * @returns {void}
 */
function settleWrappedHandler(lifecycle) {
  if (lifecycle === undefined) {
    return;
  }
  lifecycle.activeHandlers.set(lifecycle.activeHandlers.get() - HANDLER_STEP);
  scheduleWrappedShutdown(lifecycle);
}

/**
 * @param {Request} req
 * @param {LogBrewClient} client
 * @param {Transport} transport
 * @returns {RequestLifecycle | undefined}
 */
function findDeliveringLifecycle(req, client, transport) {
  const lifecycle = requestLifecycles.get(req);
  if (
    lifecycle === undefined ||
    lifecycle.released.get() ||
    lifecycle.client !== client ||
    lifecycle.transport !== transport
  ) {
    return undefined;
  }
  return lifecycle;
}

/**
 * @param {RequestLifecycle} lifecycle
 * @param {LogBrewExpressSharedOptions} options
 * @returns {void}
 */
function adoptErrorObserver(lifecycle, options) {
  lifecycle.observers.add(options);
  attachFinalizers(lifecycle);
  const { req, res } = lifecycle;
  if (lifecycle.wrapped.get() && (readField(req, "aborted") === true || res.destroyed || res.writableFinished)) {
    void finalizeRequestLifecycle(lifecycle);
  }
}

module.exports = {
  adoptErrorObserver,
  attachFinalizers,
  claimRequestLifecycle,
  createRequestLifecycle,
  findDeliveringLifecycle,
  settleWrappedHandler
};
