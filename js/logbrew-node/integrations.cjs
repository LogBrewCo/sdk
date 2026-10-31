"use strict";

const { installLogBrewPinoInstrumentation: installPinoInstrumentation } = require("./pino.cjs");
const { installLogBrewProcessErrorCapture: installProcessErrorCapture } = require("./process-errors.cjs");
const { addLogBrewBreadcrumb: addScopedBreadcrumb } = require("./breadcrumbs.cjs");
const { instrumentLogBrewMongoCollection: instrumentMongoCollection } = require("./mongo.cjs");
const { instrumentLogBrewMongooseModel: instrumentMongooseModel } = require("./mongoose.cjs");
const { instrumentLogBrewPgClient: instrumentPgClient } = require("./pg.cjs");
const { instrumentLogBrewRedisClient: instrumentRedisClient } = require("./redis.cjs");
const { installLogBrewUndiciInstrumentation: installUndiciInstrumentation } = require("./undici.cjs");
const { applyFunction } = require("./internal.cjs");
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

/**
 * @param {unknown} options
 * @returns {unknown}
 */
function installLogBrewProcessErrorCapture(options) {
  return installProcessErrorCapture(options, getActiveLogBrewTrace);
}

module.exports = {
  addLogBrewBreadcrumb,
  installLogBrewPinoInstrumentation,
  installLogBrewProcessErrorCapture,
  installLogBrewUndiciInstrumentation,
  instrumentLogBrewMongoCollection,
  instrumentLogBrewMongooseModel,
  instrumentLogBrewPgClient,
  instrumentLogBrewRedisClient
};
