"use strict";

const { assertCompatibleFastifyPino, readField, shouldCaptureFastifyApplicationLog } = require("./internal.cjs");
const { createLogBrewNodeClient, getActiveLogBrewTrace, installLogBrewPinoInstrumentation } = require("@logbrew/node");
const { SdkError } = require("@logbrew/sdk");

/**
 * @import { FastifyInstance } from "fastify"
 * @import { LogBrewPinoInstrumentationHandle } from "@logbrew/node"
 * @import { LogBrewClient, Transport } from "@logbrew/sdk"
 * @import { LogBrewFastifyApplicationLogContext, LogBrewFastifyOptions } from "./index.cjs"
 * @import { TransportSource } from "./internal.cjs"
 */

/**
 * @typedef {{ readonly sdkName: string, readonly sdkVersion: string }} SdkIdentity
 * @typedef {{
 *   readonly identity: SdkIdentity,
 *   readonly options: LogBrewFastifyOptions,
 *   readonly source: TransportSource
 * }} ApplicationLogSetup
 * @typedef {LogBrewPinoInstrumentationHandle & {
 *   readonly client: LogBrewClient,
 *   readonly transport: Transport | undefined
 * }} ApplicationLogCapture
 * @typedef {{
 *   readonly client: LogBrewClient,
 *   readonly transport: Transport | undefined,
 *   readonly uninstall: () => void
 * }} ClosableCapture
 */

/**
 * @param {LogBrewFastifyOptions} options
 * @param {unknown} error
 * @param {LogBrewFastifyApplicationLogContext} context
 * @returns {Promise<boolean>}
 */
async function notifyApplicationLogFailure(options, error, context) {
  if (typeof options.onApplicationLogCaptureError !== "function") {
    return false;
  }
  try {
    await options.onApplicationLogCaptureError(error, context);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {LogBrewFastifyOptions} options
 * @returns {void}
 */
function assertApplicationLogOptions(options) {
  if (options.captureApplicationLogs !== undefined && typeof options.captureApplicationLogs !== "boolean") {
    throw new SdkError("configuration_error", "captureApplicationLogs must be a boolean");
  }
  if (
    options.onApplicationLogCaptureError !== undefined &&
    typeof options.onApplicationLogCaptureError !== "function"
  ) {
    throw new SdkError("configuration_error", "onApplicationLogCaptureError must be a function");
  }
}

/**
 * @param {ApplicationLogSetup} setup
 * @param {Transport | undefined} transport
 * @returns {LogBrewClient}
 */
function createApplicationLogClient(setup, transport) {
  const { identity, options } = setup;
  const { transport: requestTransport, ...clientOptions } = options;
  return createLogBrewNodeClient({
    ...clientOptions,
    sdkName: options.sdkName ?? identity.sdkName,
    sdkVersion: options.sdkVersion ?? identity.sdkVersion,
    ...(transport === undefined ? {} : { transport })
  });
}

/**
 * @param {FastifyInstance} fastify
 * @param {ApplicationLogSetup} setup
 * @returns {ApplicationLogCapture | undefined}
 */
function installFastifyApplicationLogCapture(fastify, setup) {
  const { options, source } = setup;
  assertApplicationLogOptions(options);
  if (options.captureApplicationLogs !== true) {
    return undefined;
  }
  assertCompatibleFastifyPino(readField(fastify.log, "version"));
  const transport = options.applicationLogTransport ?? ("transport" in source ? source.transport : undefined);
  const client = options.applicationLogClient ?? createApplicationLogClient(setup, transport);
  const capture = installLogBrewPinoInstrumentation({
    client,
    metadata: { framework: "fastify" },
    async onError(error) {
      await notifyApplicationLogFailure(options, error, { client });
    },
    shouldCapture: shouldCaptureFastifyApplicationLog,
    traceProvider: getActiveLogBrewTrace,
    ...(transport === undefined ? {} : { transport })
  });
  return { ...capture, client, transport };
}

/**
 * @param {FastifyInstance} fastify
 * @param {LogBrewFastifyOptions} options
 * @param {ClosableCapture} capture
 * @returns {void}
 */
function addApplicationLogCloseHook(fastify, options, capture) {
  fastify.addHook("onClose", async () => {
    capture.uninstall();
    try {
      await capture.client.shutdown(capture.transport);
    } catch (error) {
      await notifyApplicationLogFailure(options, error, { client: capture.client });
    }
  });
}

module.exports = { addApplicationLogCloseHook, installFastifyApplicationLogCapture };
