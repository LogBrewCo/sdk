import { LogBrewClient, RecordingTransport, SdkError } from "@logbrew/sdk";
import { createRandomTraceparent, createTracedFetch, shouldPropagateTraceparent as shouldPropagate } from "./trace-fetch.js";
import { inject } from "vue";

/**
 * @import { App, ComponentPublicInstance, InjectionKey } from "vue"
 * @import { Transport, TransportResponse } from "@logbrew/sdk"
 * @import {
 *   CreateLogBrewVueClientConfig,
 *   LogBrewViewEvent,
 *   LogBrewVueContext,
 *   LogBrewVueErrorContext,
 *   LogBrewVueErrorEvent,
 *   LogBrewVueErrorEventOptions,
 *   LogBrewVueOptions,
 *   LogBrewVuePlugin,
 *   LogBrewVueViewEventOptions,
 *   TraceparentFetchConfig,
 *   TraceparentFetchLike,
 *   TracePropagationTarget,
 *   VueTraceparentConfig
 * } from "./index.js"
 * @typedef {(error: unknown, instance: ComponentPublicInstance | null, info: string) => void} VueErrorHandler
 */

const DEFAULT_SDK_NAME = "logbrew-vue";
const DEFAULT_SDK_VERSION = "0.1.1";
const DEFAULT_MAX_RETRIES = 2;

/** @type {InjectionKey<LogBrewVueContext>} */
const LOG_BREW_VUE_KEY = Symbol.for("logbrew.vue");

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
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "") || "event";
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
 * @param {CreateLogBrewVueClientConfig} [config]
 * @returns {LogBrewClient}
 */
function createLogBrewVueClient(config = {}) {
  const {
    apiKey = readEnv("LOGBREW_API_KEY"),
    clientKey = readEnv("LOGBREW_CLIENT_KEY"),
    context,
    maxRetries = DEFAULT_MAX_RETRIES,
    sdkName = DEFAULT_SDK_NAME,
    sdkVersion = DEFAULT_SDK_VERSION
  } = config;
  const authKey = clientKey ?? apiKey;
  const hasAuthKey = Boolean(authKey);
  if (authKey === undefined || !hasAuthKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewVueClient requires clientKey, apiKey, LOGBREW_CLIENT_KEY, or LOGBREW_API_KEY"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, maxRetries, sdkName, sdkVersion, ...(context === undefined ? {} : { context }) });
}

/**
 * @param {VueTraceparentConfig} [config]
 * @returns {string}
 */
function createVueTraceparent(config = {}) {
  return createRandomTraceparent(config, "createVueTraceparent");
}

/**
 * @param {TraceparentFetchConfig} [config]
 * @returns {TraceparentFetchLike}
 */
function createTraceparentFetch(config = {}) {
  return createTracedFetch(config, createVueTraceparent);
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
 * @returns {LogBrewVueContext}
 */
function createVueContext(client, transport) {
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
 * @param {ComponentPublicInstance | null} instance
 * @returns {string}
 */
function getComponentName(instance) {
  const type = readField(instance, "type");
  const name = readField(type, "name") ?? readField(type, "__name") ?? readField(readField(instance, "$options"), "name") ?? "";
  return typeof name === "string" ? name : "";
}

/**
 * @param {string} name
 * @param {string} path
 * @returns {string}
 */
function defaultViewEventId(name, path) {
  return `evt_vue_view_${slugify(`${name}_${path}`)}`;
}

/**
 * @param {unknown} error
 * @param {ComponentPublicInstance | null} instance
 * @param {string} info
 * @returns {string}
 */
function defaultErrorEventId(error, instance, info) {
  return `evt_vue_error_${slugify(`${getComponentName(instance)}_${info}_${errorMessage(error)}`)}`;
}

/**
 * @param {string} name
 * @param {LogBrewVueViewEventOptions} [options]
 * @returns {LogBrewViewEvent}
 */
function createVueViewEvent(name, options = {}) {
  const { idFactory = defaultViewEventId, metadata = {}, now = currentTime, path = "" } = options;
  return {
    id: idFactory(name, path),
    timestamp: now(),

    attributes: {
      message: path ? `Vue view ${name} at ${path}` : `Vue view ${name}`,

      level: "info",
      logger: "vue",
      metadata: { ...metadata, name, path }
    }
  };
}

/**
 * @param {unknown} error
 * @param {ComponentPublicInstance | null} instance
 * @param {string} info
 * @param {LogBrewVueErrorEventOptions} [options]
 * @returns {LogBrewVueErrorEvent}
 */
function createVueErrorEvent(error, instance, info, options = {}) {
  const { idFactory = defaultErrorEventId, now = currentTime } = options;
  const message = errorMessage(error);
  const component = getComponentName(instance);
  return {
    id: idFactory(error, instance, info),
    timestamp: now(),

    attributes: {
      title: component ? `${component} failed` : "Vue component failed",

      level: "error",
      message,
      metadata: { component, info }
    }
  };
}

/**
 * @param {LogBrewVueOptions} options
 * @param {Readonly<TransportResponse>} response
 * @param {LogBrewVueErrorContext} context
 * @returns {Promise<void>}
 */
async function notifyFlush(options, response, context) {
  if (options.onFlush !== undefined && isFunction(options.onFlush)) {
    await options.onFlush(response, context);
  }
}

/**
 * @param {LogBrewVueOptions} options
 * @param {unknown} error
 * @param {LogBrewVueErrorContext} context
 * @returns {Promise<void>}
 */
async function notifyFailure(options, error, context) {
  if (options.onCaptureError !== undefined && isFunction(options.onCaptureError)) {
    await options.onCaptureError(error, context);
  }
}

/**
 * @param {unknown} error
 * @param {LogBrewVueErrorContext} errorContext
 * @param {LogBrewVueOptions} options
 * @returns {Promise<TransportResponse>}
 */
async function captureWithContext(error, errorContext, options) {
  const { context, info, instance } = errorContext;
  const event = options.errorEvent !== undefined && isFunction(options.errorEvent)
    ? options.errorEvent(error, errorContext)
    : createVueErrorEvent(error, instance, info, options);
  try {
    context.client.issue(event.id, event.timestamp, event.attributes);
    const response = await context.client.flush(context.transport);
    await notifyFlush(options, response, errorContext);
    return response;
  } catch (captureError) {
    await notifyFailure(options, captureError, errorContext);
    throw captureError;
  }
}

/**
 * @param {unknown} error
 * @param {ComponentPublicInstance | null} instance
 * @param {string} info
 * @param {LogBrewVueContext} context
 * @param {LogBrewVueOptions} [options]
 * @returns {Promise<TransportResponse>}
 */
async function captureVueError(error, instance, info, context, options = {}) {
  return captureWithContext(error, { context, info, instance }, options);
}

/**
 * @param {unknown} error
 * @param {LogBrewVueErrorContext} errorContext
 * @param {LogBrewVueOptions} options
 * @returns {Promise<TransportResponse | undefined>}
 */
async function captureQuietly(error, errorContext, options) {
  try {
    return await captureWithContext(error, errorContext, options);
  } catch {
    return undefined;
  }
}

/**
 * @param {LogBrewVueOptions} options
 * @param {App} app
 * @returns {LogBrewClient}
 */
function resolveClient(options, app) {
  if (typeof options.client === "function") {
    return options.client({ app });
  }
  return options.client ?? createLogBrewVueClient(options);
}

/**
 * @param {LogBrewVueOptions} options
 * @param {App} app
 * @param {LogBrewClient} client
 * @returns {Transport}
 */
function resolveTransport(options, app, client) {
  if (typeof options.transport === "function") {
    return options.transport({ app, client });
  }
  return options.transport ?? RecordingTransport.alwaysAccept();
}

/**
 * @param {LogBrewVueContext} context
 * @param {LogBrewVueOptions} options
 * @param {VueErrorHandler | undefined} previousErrorHandler
 * @returns {VueErrorHandler}
 */
function createErrorHandler(context, options, previousErrorHandler) {
  return (error, instance, info) => {
    void captureQuietly(error, { context, info, instance }, options);
    if (previousErrorHandler !== undefined && isFunction(previousErrorHandler)) {
      return previousErrorHandler(error, instance, info);
    }
    return undefined;
  };
}

/**
 * @param {LogBrewVueOptions} [options]
 * @returns {LogBrewVuePlugin}
 */
function createLogBrewVuePlugin(options = {}) {
  return {
    install(app) {
      const client = resolveClient(options, app);
      const context = createVueContext(client, resolveTransport(options, app, client));
      app.provide(LOG_BREW_VUE_KEY, context);
      app.config.globalProperties.$logbrew = context;
      if (options.captureErrors !== false) {
        app.config.errorHandler = createErrorHandler(context, options, app.config.errorHandler);
      }
    }
  };
}

/**
 * @returns {LogBrewVueContext}
 */
function useLogBrew() {
  const context = inject(LOG_BREW_VUE_KEY, undefined);
  if (context === undefined) {
    throw new SdkError(
      "configuration_error",
      "useLogBrew requires createLogBrewVuePlugin to be installed on the Vue app"
    );
  }
  return context;
}

const defaultExport = {
  captureVueError,
  createLogBrewVueClient,
  createLogBrewVuePlugin,
  createTraceparentFetch,
  createVueErrorEvent,
  createVueTraceparent,
  createVueViewEvent,

  LOG_BREW_VUE_KEY,
  shouldPropagateTraceparent,
  useLogBrew
};

export {
  LOG_BREW_VUE_KEY,
  captureVueError,
  createLogBrewVueClient,
  createLogBrewVuePlugin,
  createTraceparentFetch,
  createVueErrorEvent,
  createVueTraceparent,
  createVueViewEvent,
  shouldPropagateTraceparent,
  useLogBrew
};
export default defaultExport;
