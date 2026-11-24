"use strict";

const {
  installLogBrewBrowser,
  installLogBrewBrowserFetchInstrumentation,
  installLogBrewBrowserXhrInstrumentation
} = require("@logbrew/browser");

/**
 * @import { LogBrewBrowserContext, LogBrewBrowserOptions } from "@logbrew/browser"
 * @import { LogBrewAngularOptions, TracePropagationTarget } from "./index.cjs"
 * @typedef {{ readonly context: LogBrewBrowserContext, readonly uninstall: () => void }} BrowserCapture
 * @typedef {Pick<LogBrewBrowserOptions, "client" | "clientKey" | "sdkName" | "sdkVersion" | "transport">} BrowserDelivery
 * @typedef {{
 *   readonly captureTargets: TracePropagationTarget[],
 *   readonly flushOnCapture: boolean,
 *   readonly tracePropagationTargets: TracePropagationTarget[]
 * }} RequestSpanOptions
 */

const DEFAULT_ENDPOINT = "https://api.logbrew.co/v1/events";

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {boolean}
 */
function hasMethod(value, key) {
  /** @type {unknown} */
  const field = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return typeof field === "function";
}

/**
 * @param {unknown} value
 * @returns {value is Window}
 */
function isBrowserWindow(value) {
  return hasMethod(value, "addEventListener");
}

/**
 * @param {Window | undefined} browserWindow
 * @returns {Window | undefined}
 */
function findBrowserWindow(browserWindow) {
  /** @type {unknown} */
  const candidate = browserWindow ?? Reflect.get(globalThis, "window");
  return isBrowserWindow(candidate) ? candidate : undefined;
}

/**
 * @param {string} endpoint
 * @returns {TracePropagationTarget}
 */
function outsideEndpoint(endpoint) {
  return (url) => !url.startsWith(endpoint);
}

/**
 * @param {LogBrewAngularOptions} options
 * @returns {RequestSpanOptions | undefined}
 */
function requestSpanOptions(options) {
  if (options.captureRequests === false) {
    return undefined;
  }
  return {
    captureTargets: options.captureTargets ?? [outsideEndpoint(options.endpoint ?? DEFAULT_ENDPOINT)],
    flushOnCapture: false,
    tracePropagationTargets: options.tracePropagationTargets ?? []
  };
}

/**
 * @param {LogBrewAngularOptions} options
 * @param {Window} browserWindow
 * @param {BrowserDelivery} delivery
 * @returns {BrowserCapture}
 */
function startBrowserCapture(options, browserWindow, delivery) {
  const {
    captureErrors: _captureErrors,
    client: _client,
    component: _component,
    delegateErrorHandler: _delegateErrorHandler,
    errorEvent: _errorEvent,
    idFactory: _idFactory,
    info: _info,
    onCaptureError: _onCaptureError,
    onFlush: _onFlush,
    path: _path,
    route: _route,
    transport: _transport,
    ...browserOptions
  } = options;
  const context = installLogBrewBrowser({ ...browserOptions, ...delivery, browserWindow });
  const spanOptions = requestSpanOptions(options);
  const instrumentations = spanOptions === undefined ? [] : [
    ...(hasMethod(browserWindow, "fetch") ? [installLogBrewBrowserFetchInstrumentation(context, spanOptions)] : []),
    ...(hasMethod(browserWindow, "XMLHttpRequest") ? [installLogBrewBrowserXhrInstrumentation(context, spanOptions)] : [])
  ];
  return {
    context,
    uninstall() {
      for (const instrumentation of instrumentations) {
        instrumentation.uninstall();
      }
      context.uninstall();
    }
  };
}

module.exports = { findBrowserWindow, startBrowserCapture };
