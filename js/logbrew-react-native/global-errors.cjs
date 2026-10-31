"use strict";

const { createFatalController } = require("./fatal-replay.cjs");
const { GlobalErrorCapture, activeInstallation, inactiveInstallation } = require("./global-errors-capture.cjs");
const { createAutomaticErrorEvent, isSafeErrorName } = require("./global-errors-event.cjs");
const { DiagnosticGate, emitDiagnostic, isFunction, isObjectLike, safeFunction } = require("./global-errors-support.cjs");
const {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativePromiseRejectionTracker
} = require("./promise-rejections.cjs");

/**
 * @import { UnknownFunction } from "./global-errors-support.cjs"
 * @import { LogBrewReactNativeGlobalErrorHandlerInstallation } from "./global-errors.cjs"
 * @typedef {Readonly<{
 *   client: object,
 *   errorUtils: object,
 *   fatalStore: unknown,
 *   getGlobalHandler: UnknownFunction,
 *   issue: UnknownFunction,
 *   onDiagnostic: unknown,
 *   previousHandler: UnknownFunction,
 *   setGlobalHandler: UnknownFunction
 * }>} InstallationInput
 * @typedef {Readonly<{ client?: unknown, errorUtils?: unknown, fatalStore?: unknown, onDiagnostic?: unknown }>} InstallOptions
 */

const AUTOMATIC_ERROR_MESSAGE = "React Native global JavaScript report";

/**
 * @param {UnknownFunction} getGlobalHandler
 * @param {object} errorUtils
 * @returns {UnknownFunction | undefined}
 */
function readPreviousHandler(getGlobalHandler, errorUtils) {
  try {
    const previousHandler = getGlobalHandler.call(errorUtils);
    return isFunction(previousHandler) ? previousHandler : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {InstallationInput} input
 * @returns {LogBrewReactNativeGlobalErrorHandlerInstallation}
 */
function startCapture(input) {
  const { client, fatalStore, issue, onDiagnostic } = input;
  const diagnostics = new DiagnosticGate(onDiagnostic);
  /**
   * @param {Readonly<{ code: string }>} diagnostic
   * @returns {void}
   */
  function forwardDiagnostic(diagnostic) {
    diagnostics.emit(diagnostic.code);
  }
  const fatal = createFatalController({
    client,
    createEvent: (error) => createAutomaticErrorEvent(error, client, true),
    eventMessage: AUTOMATIC_ERROR_MESSAGE,
    fatalStore,
    isErrorName: isSafeErrorName,
    issue,
    onDiagnostic: forwardDiagnostic
  });
  return new GlobalErrorCapture({ ...input, diagnostics, fatal }).install();
}

/**
 * @param {Omit<InstallationInput, "previousHandler">} input
 * @returns {LogBrewReactNativeGlobalErrorHandlerInstallation}
 */
function installHandler(input) {
  const previousHandler = readPreviousHandler(input.getGlobalHandler, input.errorUtils);
  if (!previousHandler) {
    emitDiagnostic(input.onDiagnostic, "handler_unavailable");
    return inactiveInstallation();
  }
  return startCapture({ ...input, previousHandler });
}

/**
 * @param {InstallOptions} [options]
 * @returns {LogBrewReactNativeGlobalErrorHandlerInstallation}
 */
function installLogBrewReactNativeGlobalErrorHandler({
  client,
  errorUtils = Reflect.get(globalThis, "ErrorUtils"),
  fatalStore,
  onDiagnostic
} = {}) {
  const issue = safeFunction(client, "issue");
  const getGlobalHandler = safeFunction(errorUtils, "getGlobalHandler");
  const setGlobalHandler = safeFunction(errorUtils, "setGlobalHandler");
  if (!issue || !getGlobalHandler || !setGlobalHandler || !isObjectLike(errorUtils) || !isObjectLike(client)) {
    emitDiagnostic(onDiagnostic, "handler_unavailable");
    return inactiveInstallation();
  }
  return activeInstallation(errorUtils)
    ?? installHandler({ client, errorUtils, fatalStore, getGlobalHandler, issue, onDiagnostic, setGlobalHandler });
}

const defaultExport = {
  createLogBrewReactNativePromiseRejectionHandlers,
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
};

module.exports = { ...defaultExport, default: defaultExport };
