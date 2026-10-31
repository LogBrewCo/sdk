"use strict";

const { LogBrewClient, SdkError } = require("@logbrew/sdk");
const { captureSvelteError, createSvelteErrorEvent, currentTime, isLogBrewSvelteContext, readField, slugify } = require("./capture.cjs");
const { createBrowserTraceparent, createFetchTransport, createTraceparentFetch, shouldPropagateTraceparent } = require("@logbrew/browser");
const { getContext, hasContext, setContext } = require("svelte");
const { createLogBrewSvelteKitHooks } = require("./sveltekit.cjs");

/**
 * @import { Transport } from "@logbrew/sdk"
 * @import {
 *   CreateLogBrewSvelteClientConfig,
 *   LogBrewSvelteContext,
 *   LogBrewSvelteOptions,
 *   LogBrewSvelteViewEvent,
 *   LogBrewSvelteViewEventOptions
 * } from "./index.cjs"
 */

const DEFAULT_SDK_NAME = "logbrew-svelte";
const DEFAULT_SDK_VERSION = "0.1.6";
const DEFAULT_MAX_RETRIES = 2;

const LOG_BREW_SVELTE_KEY = Symbol.for("logbrew.svelte");
const createSvelteTraceparent = createBrowserTraceparent;

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function readEnv(name) {
  const value = readField(readField(readField(globalThis, "process"), "env"), name);
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {CreateLogBrewSvelteClientConfig} [config]
 * @returns {LogBrewClient}
 */
function createLogBrewSvelteClient(config = {}) {
  const {
    apiKey = readEnv("LOGBREW_API_KEY"),
    clientKey = readEnv("LOGBREW_CLIENT_KEY"),
    context,
    maxRetries = DEFAULT_MAX_RETRIES,
    sdkName = DEFAULT_SDK_NAME,
    sdkVersion = DEFAULT_SDK_VERSION,
    serverApiKey = readEnv("LOGBREW_SERVER_API_KEY")
  } = config;
  const authKey = clientKey ?? serverApiKey ?? apiKey;
  const hasAuthKey = Boolean(authKey);
  if (authKey === undefined || !hasAuthKey) {
    throw new SdkError(
      "configuration_error",
      "createLogBrewSvelteClient requires a browser client key or server API key"
    );
  }
  return LogBrewClient.create({ apiKey: authKey, maxRetries, sdkName, sdkVersion, ...(context === undefined ? {} : { context }) });
}

/**
 * @param {LogBrewSvelteOptions} options
 * @returns {LogBrewClient}
 */
function resolveClient(options) {
  if (typeof options.client === "function") {
    return options.client();
  }
  return options.client ?? createLogBrewSvelteClient(options);
}

/**
 * @param {LogBrewSvelteOptions} options
 * @param {LogBrewClient} client
 * @returns {Transport}
 */
function resolveTransport(options, client) {
  if (typeof options.transport === "function") {
    return options.transport({ client });
  }
  return options.transport ?? createFetchTransport(options);
}

/**
 * @param {LogBrewSvelteOptions} [options]
 * @returns {LogBrewSvelteContext}
 */
function createLogBrewSvelteContext(options = {}) {
  const client = resolveClient(options);
  const transport = resolveTransport(options, client);
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
 * @param {LogBrewSvelteOptions | LogBrewSvelteContext} [options]
 * @returns {LogBrewSvelteContext}
 */
function setLogBrewContext(options = {}) {
  const context = isLogBrewSvelteContext(options) ? options : createLogBrewSvelteContext(options);
  setContext(LOG_BREW_SVELTE_KEY, context);
  return context;
}

/**
 * @returns {LogBrewSvelteContext}
 */
function useLogBrew() {
  if (!hasContext(LOG_BREW_SVELTE_KEY)) {
    throw new SdkError(
      "configuration_error",
      "useLogBrew requires setLogBrewContext to run in a parent Svelte component"
    );
  }
  return getContext(LOG_BREW_SVELTE_KEY);
}

const getLogBrewContext = useLogBrew;

/**
 * @param {string} name
 * @param {string} path
 * @returns {string}
 */
function defaultViewEventId(name, path) {
  return `evt_svelte_view_${slugify(`${name}_${path}`)}`;
}

/**
 * @param {string} name
 * @param {LogBrewSvelteViewEventOptions} [options]
 * @returns {LogBrewSvelteViewEvent}
 */
function createSvelteViewEvent(name, options = {}) {
  const { idFactory = defaultViewEventId, metadata = {}, now: timestamp = currentTime, path = "" } = options;
  return {
    id: idFactory(name, path),
    timestamp: timestamp(),

    attributes: {
      message: path ? `Svelte view ${name} at ${path}` : `Svelte view ${name}`,

      level: "info",
      logger: "svelte",
      metadata: { ...metadata, name, path }
    }
  };
}

const defaultExport = {
  captureSvelteError,
  createLogBrewSvelteClient,
  createLogBrewSvelteContext,
  createLogBrewSvelteKitHooks,
  createSvelteErrorEvent,
  createSvelteTraceparent,
  createSvelteViewEvent,
  createTraceparentFetch,
  getLogBrewContext,

  LOG_BREW_SVELTE_KEY,
  setLogBrewContext,
  shouldPropagateTraceparent,
  useLogBrew
};

module.exports = { ...defaultExport, default: defaultExport };
