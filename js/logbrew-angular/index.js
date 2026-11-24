import { DestroyRef, ErrorHandler, InjectionToken, Injector, inject } from "@angular/core";
import { LogBrewClient, SdkError, createIssueAttributesFromError } from "@logbrew/sdk";
import { createAutomaticBrowserEventId, createFetchTransport } from "@logbrew/browser";
import { createRandomTraceparent, createTracedFetch, shouldPropagateTraceparent as shouldPropagate } from "./trace-fetch.js";
import { findBrowserWindow, startBrowserCapture } from "./browser-capture.js";

/**
 * @import { FactoryProvider } from "@angular/core"
 * @import { Transport, TransportResponse } from "@logbrew/sdk"
 * @import { BrowserDelivery } from "./browser-capture.js"
 * @import {
 *   AngularTraceparentConfig,
 *   TracePropagationTarget,
 *   CreateLogBrewAngularClientConfig,
 *   LogBrewAngularCaptureContext,
 *   LogBrewAngularContext,
 *   LogBrewAngularErrorEvent,
 *   LogBrewAngularErrorEventOptions,
 *   LogBrewAngularErrorMetadata,
 *   LogBrewAngularOptions,
 *   LogBrewAngularViewEvent,
 *   LogBrewAngularViewEventOptions,
 *   TraceparentFetchConfig,
 *   TraceparentFetchLike
 * } from "./index.js"
 */

const DEFAULT_SDK_NAME = "logbrew-angular";
const DEFAULT_SDK_VERSION = "0.1.5";
const DEFAULT_MAX_RETRIES = 2;

/** @type {InjectionToken<LogBrewAngularContext>} */
const LOG_BREW_ANGULAR_CONTEXT = new InjectionToken("LogBrew Angular context");


/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function readField(value, key) {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;
}

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function readEnv(name) {
  const value = readField(readField(readField(globalThis, "process"), "env"), name);
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFunction(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @returns {string}
 */
function currentTime() {
  return new Date().toISOString();
}

/**
 * @param {CreateLogBrewAngularClientConfig} config
 * @returns {string}
 */
function requireAuthKey(config) {
  const { apiKey = readEnv("LOGBREW_API_KEY"), clientKey = readEnv("LOGBREW_CLIENT_KEY") } = config;
  const authKey = clientKey ?? apiKey;
  if (authKey === undefined || !authKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewAngularClient requires clientKey, apiKey, LOGBREW_CLIENT_KEY, or LOGBREW_API_KEY"
    );
  }
  return authKey;
}

/**
 * @param {CreateLogBrewAngularClientConfig} [config]
 * @returns {LogBrewClient}
 */
function createLogBrewAngularClient(config = {}) {
  const {
    context,
    maxRetries = DEFAULT_MAX_RETRIES,
    sdkName = DEFAULT_SDK_NAME,
    sdkVersion = DEFAULT_SDK_VERSION
  } = config;
  const apiKey = requireAuthKey(config);
  return LogBrewClient.create({ apiKey, maxRetries, sdkName, sdkVersion, ...(context === undefined ? {} : { context }) });
}

/**
 * @param {AngularTraceparentConfig} [config]
 * @returns {string}
 */
function createAngularTraceparent(config = {}) {
  return createRandomTraceparent(config, "createAngularTraceparent");
}

/**
 * @param {TraceparentFetchConfig} [config]
 * @returns {TraceparentFetchLike}
 */
function createTraceparentFetch(config = {}) {
  return createTracedFetch(config, createAngularTraceparent);
}

/**
 * @param {string} url
 * @param {readonly TracePropagationTarget[]} [tracePropagationTargets]
 * @returns {boolean}
 */
function shouldPropagateTraceparent(url, tracePropagationTargets) {
  return shouldPropagate(url, tracePropagationTargets);
}

/**
 * @param {LogBrewClient} client
 * @param {Transport} transport
 * @returns {LogBrewAngularContext}
 */
function createLogBrewAngularContext(client, transport) {
  return {
    client,
    logbrew: client,
    transport,

    previewJson: () => client.previewJson(),

    flush: async () => client.flush(transport),
    shutdown: async () => client.shutdown(transport)
  };
}

/**
 * @param {string} name
 * @param {string} path
 * @returns {string}
 */
function defaultViewEventId(name, path) {
  return createAutomaticBrowserEventId("evt_angular_view", `${name}_${path}`);
}

/**
 * @param {unknown} error
 * @param {LogBrewAngularErrorMetadata} context
 * @returns {string}
 */
function defaultErrorEventId(error, context) {
  return createAutomaticBrowserEventId("evt_angular_error", `${context.component ?? ""}_${context.route ?? ""}_${errorMessage(error)}`);
}

/**
 * @param {string} name
 * @param {LogBrewAngularViewEventOptions} [options]
 * @returns {LogBrewAngularViewEvent}
 */
function createAngularViewEvent(name, options = {}) {
  const { idFactory = defaultViewEventId, metadata = {}, now = currentTime, path = "", route = "" } = options;
  const viewPath = path || route;
  return {
    id: idFactory(name, viewPath),
    timestamp: now(),

    attributes: {
      message: viewPath ? `Angular view ${name} at ${viewPath}` : `Angular view ${name}`,

      level: "info",
      logger: "angular",
      metadata: { ...metadata, name, path: viewPath }
    }
  };
}

/**
 * @param {unknown} error
 * @param {LogBrewAngularErrorMetadata} [context]
 * @param {LogBrewAngularErrorEventOptions} [options]
 * @returns {LogBrewAngularErrorEvent}
 */
function createAngularErrorEvent(error, context = {}, options = {}) {
  const { handled = true, idFactory = defaultErrorEventId, now = currentTime, trace } = options;
  const component = context.component ?? "";
  const route = context.route ?? context.path ?? "";
  return {
    id: idFactory(error, context),
    timestamp: now(),

    attributes: createIssueAttributesFromError(error, {
      handled,
      mechanism: "angular.error_handler",
      metadata: { component, info: context.info ?? "", route },
      source: "angular.error",
      title: component ? `${component} failed` : "Angular error",
      ...(trace === undefined ? {} : { trace })
    })
  };
}

/**
 * @param {LogBrewAngularContext} context
 * @returns {string | undefined}
 */
function currentPath(context) {
  const path = readField(readField(readField(context, "browserWindow") ?? globalThis, "location"), "pathname");
  return typeof path === "string" ? path : undefined;
}

/**
 * @param {LogBrewAngularOptions} options
 * @param {Readonly<TransportResponse>} response
 * @param {LogBrewAngularCaptureContext} context
 * @returns {Promise<void>}
 */
async function notifyFlush(options, response, context) {
  if (options.onFlush !== undefined && isFunction(options.onFlush)) {
    await options.onFlush(response, context);
  }
}

/**
 * @param {LogBrewAngularOptions} options
 * @param {unknown} error
 * @param {LogBrewAngularCaptureContext} context
 * @returns {Promise<void>}
 */
async function notifyFailure(options, error, context) {
  if (options.onCaptureError !== undefined && isFunction(options.onCaptureError)) {
    await options.onCaptureError(error, context);
  }
}

/**
 * @param {unknown} error
 * @param {LogBrewAngularContext} context
 * @param {LogBrewAngularOptions} [options]
 * @returns {Promise<TransportResponse>}
 */
async function captureAngularError(error, context, options = {}) {
  const event = options.errorEvent !== undefined && isFunction(options.errorEvent)
    ? options.errorEvent(error, { context })
    : createAngularErrorEvent(
      error,
      { ...options, route: options.route ?? options.path ?? currentPath(context) },
      { ...options, trace: context.traceContext }
    );
  try {
    context.client.issue(event.id, event.timestamp, event.attributes);
    const response = await context.client.flush(context.transport);
    await notifyFlush(options, response, { context });
    return response;
  } catch (captureError) {
    await notifyFailure(options, captureError, { context });
    throw captureError;
  }
}

/**
 * @param {unknown} error
 * @param {LogBrewAngularContext} context
 * @param {LogBrewAngularOptions | undefined} options
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureQuietly(error, context, options) {
  try {
    return await captureAngularError(error, context, options);
  } catch {
    return undefined;
  }
}

/**
 * @implements {ErrorHandler}
 */
class LogBrewErrorHandler {
  /**
   * @param {LogBrewAngularContext} context
   * @param {LogBrewAngularOptions} [options]
   * @param {ErrorHandler | null} [delegate]
   */
  constructor(context, options, delegate) {
    this.context = context;
    this.options = options;
    this.delegate = delegate;
  }

  /**
   * @param {unknown} error
   * @returns {void}
   */
  handleError(error) {
    void captureQuietly(error, this.context, { ...this.options, handled: false });
    const { delegate } = this;
    if (delegate !== null && delegate !== undefined && isFunction(readField(delegate, "handleError"))) {
      delegate.handleError(error);
    }
  }
}

/**
 * @param {LogBrewAngularOptions} options
 * @param {Injector} injector
 * @returns {LogBrewClient}
 */
function resolveClient(options, injector) {
  if (typeof options.client === "function") {
    return options.client({ injector });
  }
  return options.client ?? createLogBrewAngularClient(options);
}

/**
 * @param {LogBrewAngularOptions} options
 * @param {Injector} injector
 * @param {LogBrewClient} client
 * @returns {Transport}
 */
function resolveTransport(options, injector, client) {
  if (typeof options.transport === "function") {
    return options.transport({ client, injector });
  }
  return options.transport ?? createFetchTransport(options);
}

/**
 * @param {LogBrewAngularOptions} options
 * @param {Injector} injector
 * @returns {BrowserDelivery}
 */
function browserDelivery(options, injector) {
  const { client, sdkName = DEFAULT_SDK_NAME, sdkVersion = DEFAULT_SDK_VERSION, transport } = options;
  if (client !== undefined || typeof transport === "function") {
    const resolved = resolveClient(options, injector);
    return { client: resolved, sdkName, sdkVersion, transport: resolveTransport(options, injector, resolved) };
  }
  return { clientKey: requireAuthKey(options), sdkName, sdkVersion, ...(transport === undefined ? {} : { transport }) };
}

/**
 * @param {LogBrewAngularOptions} options
 * @param {Injector} injector
 * @returns {LogBrewAngularContext}
 */
function createProvidedContext(options, injector) {
  const browserWindow = findBrowserWindow(options.browserWindow);
  if (browserWindow === undefined) {
    const client = resolveClient(options, injector);
    return createLogBrewAngularContext(client, resolveTransport(options, injector, client));
  }
  const capture = startBrowserCapture(options, browserWindow, browserDelivery(options, injector));
  inject(DestroyRef, { optional: true })?.onDestroy(() => {
    capture.uninstall();
  });
  return capture.context;
}

/**
 * @param {LogBrewAngularOptions} options
 * @returns {ErrorHandler | undefined}
 */
function resolveDelegateErrorHandler(options) {
  const { delegateErrorHandler } = options;
  if (typeof delegateErrorHandler === "function") {
    return { handleError: delegateErrorHandler };
  }
  return delegateErrorHandler;
}

/**
 * @param {LogBrewAngularOptions} [options]
 * @returns {FactoryProvider[]}
 */
function provideLogBrew(options = {}) {
  /** @type {FactoryProvider[]} */
  const providers = [
    {
      provide: LOG_BREW_ANGULAR_CONTEXT,
      useFactory: () => createProvidedContext(options, inject(Injector))
    }
  ];
  if (options.captureErrors !== false) {
    providers.push({
      provide: ErrorHandler,
      useFactory: () => new LogBrewErrorHandler(inject(LOG_BREW_ANGULAR_CONTEXT), options, resolveDelegateErrorHandler(options))
    });
  }
  return providers;
}

/**
 * @returns {LogBrewAngularContext}
 */
function injectLogBrew() {
  const context = inject(LOG_BREW_ANGULAR_CONTEXT, { optional: true });
  if (context === null) {
    throw new SdkError("configuration_error", "injectLogBrew requires provideLogBrew() in the Angular provider tree");
  }
  return context;
}

const defaultExport = {
  captureAngularError,
  createAngularErrorEvent,
  createAngularTraceparent,
  createAngularViewEvent,
  createLogBrewAngularClient,
  createLogBrewAngularContext,
  createTraceparentFetch,
  injectLogBrew,

  LogBrewErrorHandler,

  LOG_BREW_ANGULAR_CONTEXT,
  provideLogBrew,
  shouldPropagateTraceparent
};

export {
  LOG_BREW_ANGULAR_CONTEXT,
  LogBrewErrorHandler,
  captureAngularError,
  createAngularErrorEvent,
  createAngularTraceparent,
  createAngularViewEvent,
  createLogBrewAngularClient,
  createLogBrewAngularContext,
  createTraceparentFetch,
  injectLogBrew,
  provideLogBrew,
  shouldPropagateTraceparent
};
export default defaultExport;
