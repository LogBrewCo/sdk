"use strict";

const { installLogBrewPinoInstrumentation: installPinoInstrumentation } = require("./pino.cjs");
const { installLogBrewProcessErrorCapture: installProcessErrorCapture } = require("./process-errors.cjs");
const { addLogBrewBreadcrumb: addScopedBreadcrumb } = require("./breadcrumbs.cjs");
const { instrumentLogBrewMongoCollection: instrumentMongoCollection } = require("./mongo.cjs");
const { instrumentLogBrewMongooseModel: instrumentMongooseModel } = require("./mongoose.cjs");
const { instrumentLogBrewPgClient: instrumentPgClient } = require("./pg.cjs");
const { instrumentLogBrewRedisClient: instrumentRedisClient } = require("./redis.cjs");
const { installLogBrewUndiciInstrumentation: installUndiciInstrumentation } = require("./undici.cjs");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");
const { applyFunction, attempt, boundedText, isObjectLike, readMember } = require("./internal.cjs");
const { getActiveLogBrewTrace, runWithLogBrewTrace } = require("./active-trace.cjs");

/**
 * @typedef {Readonly<Record<string, unknown>>} IntegrationOptions
 */

/**
 * @param {unknown} pgClient
 * @param {IntegrationOptions} [options]
 * @returns {unknown}
 */
function instrumentLogBrewPgClient(pgClient, options = {}) {
  /** @type {unknown} */
  const instrumented = instrumentPgClient(pgClient, { ...options, activeTraceProvider: getActiveLogBrewTrace, runWithTrace: runWithLogBrewTrace });
  return instrumented;
}

/**
 * @param {unknown} redisClient
 * @param {IntegrationOptions} [options]
 * @returns {unknown}
 */
function instrumentLogBrewRedisClient(redisClient, options = {}) {
  /** @type {unknown} */
  const instrumented = instrumentRedisClient(redisClient, { ...options, activeTraceProvider: getActiveLogBrewTrace, runWithTrace: runWithLogBrewTrace });
  return instrumented;
}

/**
 * @param {unknown} mongoCollection
 * @param {IntegrationOptions} [options]
 * @returns {unknown}
 */
function instrumentLogBrewMongoCollection(mongoCollection, options = {}) {
  /** @type {unknown} */
  const instrumented = instrumentMongoCollection(mongoCollection, { ...options, activeTraceProvider: getActiveLogBrewTrace, runWithTrace: runWithLogBrewTrace });
  return instrumented;
}

/**
 * @param {unknown} mongooseModel
 * @param {IntegrationOptions} [options]
 * @returns {unknown}
 */
function instrumentLogBrewMongooseModel(mongooseModel, options = {}) {
  /** @type {unknown} */
  const instrumented = instrumentMongooseModel(mongooseModel, { ...options, activeTraceProvider: getActiveLogBrewTrace, runWithTrace: runWithLogBrewTrace });
  return instrumented;
}

/**
 * @param {IntegrationOptions} [options]
 * @returns {unknown}
 */
function installLogBrewUndiciInstrumentation(options = {}) {
  return applyFunction(installUndiciInstrumentation, undefined, [{ ...options, activeTraceProvider: getActiveLogBrewTrace }]);
}

/**
 * @param {IntegrationOptions} [options]
 * @returns {unknown}
 */
function installLogBrewPinoInstrumentation(options = {}) {
  return installPinoInstrumentation({ ...options, traceProvider: options["traceProvider"] ?? getActiveLogBrewTrace });
}

/**
 * @param {unknown} breadcrumb
 * @returns {void}
 */
function addLogBrewBreadcrumb(breadcrumb) {
  addScopedBreadcrumb(breadcrumb, getActiveLogBrewTrace);
}

const MAX_LOG_MESSAGE_LENGTH = 2048;
const MAX_BREADCRUMB_MESSAGE_LENGTH = 512;
const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "warning", "error", "fatal", "critical"]);

/**
 * Sends one line from a framework's own logger as a log on the active trace, and keeps it as a breadcrumb for the
 * next issue in that trace. Capture never throws into the logger that called it.
 * @param {unknown} client
 * @param {unknown} record
 * @returns {void}
 */
function captureLogBrewLog(client, record) {
  if (!isObjectLike(client) || !isObjectLike(record)) {
    return;
  }
  const message = boundedText(readMember(record, "message") ?? "", MAX_LOG_MESSAGE_LENGTH);
  const level = readMember(record, "level");
  const logger = readMember(record, "logger");
  const metadata = readMember(record, "metadata");
  if (message === "" || typeof readMember(client, "log") !== "function") {
    return;
  }
  const attributes = {
    message,
    level: typeof level === "string" && LOG_LEVELS.has(level) ? level : "info",
    ...(typeof logger === "string" && logger !== "" ? { logger } : {}),
    ...(isObjectLike(metadata) ? { metadata } : {})
  };
  attempt(() => {
    Reflect.apply(readMember(client, "log"), client, [createAutomaticEventId("evt_node_log", attributes.logger ?? "app"), new Date().toISOString(), attributes]);
  });
  addLogBrewBreadcrumb({
    type: "debug",
    category: `log.${attributes.logger ?? "app"}`,
    level: attributes.level,
    message: boundedText(message, MAX_BREADCRUMB_MESSAGE_LENGTH)
  });
}

/**
 * @param {unknown} options
 * @returns {unknown}
 */
function installLogBrewProcessErrorCapture(options) {
  return installProcessErrorCapture(options, getActiveLogBrewTrace);
}

module.exports = {
  addLogBrewBreadcrumb,
  captureLogBrewLog,
  installLogBrewPinoInstrumentation,
  installLogBrewProcessErrorCapture,
  installLogBrewUndiciInstrumentation,
  instrumentLogBrewMongoCollection,
  instrumentLogBrewMongooseModel,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient
};
