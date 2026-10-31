"use strict";

const { createRequire } = require("node:module");
const path = require("node:path");
const {
  configurationError,
  field,
  isCallable,
  isDevelopmentGraph,
  isRecord,
  prependDebugIdModule,
  productionResult
} = require("./metro-debug-id.cjs");
const { createDefaultMetroSerializer } = require("./metro-serializer.cjs");

/**
 * @typedef {(this: unknown, ...args: readonly unknown[]) => unknown} Callable
 * @typedef {(entryPoint: unknown, preModules: unknown, graph: unknown, options: unknown) => Promise<unknown>} MetroSerializer
 * @typedef {Readonly<Record<string, unknown>> & { readonly enabled?: boolean }} LogBrewMetroOptions
 * @typedef {LogBrewMetroOptions & {
 *   readonly getDefaultConfig?: Callable,
 *   readonly unstable_beforeAssetSerializationPlugins?: readonly Callable[]
 * }} LogBrewExpoOptions
 */

const DEBUG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WRAPPED_SERIALIZER = Symbol.for("@logbrew/react-native/metro-serializer");

/**
 * @param {unknown} options
 * @returns {asserts options is LogBrewMetroOptions}
 */
function requireOptions(options) {
  if (!isRecord(options) || Array.isArray(options)) {
    throw configurationError("LogBrew Metro options must be an object");
  }
  if (options["enabled"] !== undefined && typeof options["enabled"] !== "boolean") {
    throw configurationError("LogBrew Metro option enabled must be a boolean");
  }
}

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isArray(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFunctionArray(value) {
  return Array.isArray(value) && value.every((plugin) => typeof plugin === "function");
}

/**
 * @param {unknown} options
 * @returns {asserts options is LogBrewExpoOptions}
 */
function requireExpoPluginOptions(options) {
  requireOptions(options);
  if (
    options["unstable_beforeAssetSerializationPlugins"] !== undefined &&
    !isFunctionArray(options["unstable_beforeAssetSerializationPlugins"])
  ) {
    throw configurationError(
      "LogBrew Expo option unstable_beforeAssetSerializationPlugins must be an array of functions"
    );
  }
  if (options["getDefaultConfig"] !== undefined && typeof options["getDefaultConfig"] !== "function") {
    throw configurationError("LogBrew Expo option getDefaultConfig must be a function");
  }
}

/**
 * @param {unknown} input
 * @returns {readonly unknown[]}
 */
function expoPreModules(input) {
  if (!isRecord(input) || Array.isArray(input)) {
    throw configurationError("LogBrew Expo Debug ID plugin requires a serialization input object");
  }
  const preModules = input["premodules"];
  if (!isArray(preModules)) {
    throw configurationError("LogBrew Expo Debug ID plugin expected premodules to be an array");
  }
  return preModules;
}

/**
 * @param {unknown} [options]
 * @returns {(input: unknown) => unknown}
 */
function createLogBrewExpoDebugIdPlugin(options = {}) {
  requireOptions(options);
  return (input) => {
    const preModules = expoPreModules(input);
    const debugId = field(input, "debugId");
    if (options.enabled === false || debugId === undefined || debugId === null) {
      return preModules;
    }
    if (typeof debugId !== "string" || !DEBUG_ID_RE.test(debugId)) {
      throw configurationError("LogBrew Expo Debug ID plugin requires a valid Expo Debug ID");
    }
    return prependDebugIdModule(preModules, debugId.toLowerCase());
  };
}

/**
 * @param {string} projectRoot
 * @returns {unknown}
 */
function requireExpoMetroConfig(projectRoot) {
  try {
    const projectRequire = createRequire(path.join(projectRoot, "package.json"));
    /** @type {unknown} */
    const expoMetroConfig = projectRequire("expo/metro-config");
    return expoMetroConfig;
  } catch (error) {
    throw configurationError(
      "LogBrew could not load expo/metro-config from the app; install a supported Expo SDK or pass getDefaultConfig",
      { cause: error }
    );
  }
}

/**
 * @param {string} projectRoot
 * @returns {Callable}
 */
function loadExpoGetDefaultConfig(projectRoot) {
  const getDefaultConfig = field(requireExpoMetroConfig(projectRoot), "getDefaultConfig");
  if (!isCallable(getDefaultConfig)) {
    throw configurationError("LogBrew could not resolve getDefaultConfig from expo/metro-config");
  }
  return getDefaultConfig;
}

/**
 * @param {unknown} projectRoot
 * @param {unknown} [options]
 * @returns {unknown}
 */
function getLogBrewExpoConfig(projectRoot, options = {}) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw configurationError("getLogBrewExpoConfig requires a non-empty Expo project root");
  }
  requireExpoPluginOptions(options);
  const root = path.resolve(projectRoot);
  const {
    enabled = true,
    getDefaultConfig = loadExpoGetDefaultConfig(root),
    unstable_beforeAssetSerializationPlugins = [],
    ...expoOptions
  } = options;
  const plugins = enabled
    ? [...unstable_beforeAssetSerializationPlugins, createLogBrewExpoDebugIdPlugin()]
    : [...unstable_beforeAssetSerializationPlugins];
  return getDefaultConfig(root, {
    ...expoOptions,
    unstable_beforeAssetSerializationPlugins: plugins
  });
}

/**
 * @param {unknown} result
 * @param {MetroSerializer} fallbackSerializer
 * @param {readonly [unknown, unknown, unknown, unknown]} args
 * @returns {Promise<Record<string, unknown>>}
 */
async function stringSerializerResult(result, fallbackSerializer, args) {
  const fallbackResult = await fallbackSerializer(...args);
  if (typeof fallbackResult === "string" || field(fallbackResult, "code") !== result) {
    throw configurationError(
      "LogBrew Metro string-returning custom serializer changed bundle code; return { code, map } to preserve source-map accuracy"
    );
  }
  return productionResult(fallbackResult);
}

/**
 * @param {unknown} customSerializer
 * @returns {Callable}
 */
function createLogBrewMetroSerializer(customSerializer) {
  if (customSerializer !== undefined && customSerializer !== null && !isCallable(customSerializer)) {
    throw configurationError("LogBrew Metro custom serializer must be a function");
  }
  if (isCallable(customSerializer) && field(customSerializer, WRAPPED_SERIALIZER) === true) {
    return customSerializer;
  }
  /** @type {Callable | undefined} */
  let serializerSource = customSerializer ?? undefined;
  /** @type {MetroSerializer | undefined} */
  let fallbackSerializer = undefined;

  /**
   * @param {unknown} entryPoint
   * @param {unknown} preModules
   * @param {unknown} graph
   * @param {unknown} options
   * @returns {Promise<unknown>}
   */
  async function serializer(entryPoint, preModules, graph, options) {
    serializerSource ??= createDefaultMetroSerializer();
    const source = serializerSource;
    if (isDevelopmentGraph(graph)) {
      return source(entryPoint, preModules, graph, options);
    }
    const releaseModules = prependDebugIdModule(preModules);
    const result = await source(entryPoint, releaseModules, graph, options);
    if (typeof result === "string") {
      fallbackSerializer ??= createDefaultMetroSerializer();
      return stringSerializerResult(result, fallbackSerializer, [entryPoint, releaseModules, graph, options]);
    }
    return productionResult(result);
  }
  Object.defineProperty(serializer, WRAPPED_SERIALIZER, { value: true });
  return serializer;
}

/**
 * @param {Readonly<Record<string, unknown>>} config
 * @returns {Readonly<Record<string, unknown>>}
 */
function requireSerializerConfig(config) {
  const serializerConfig = config["serializer"] ?? {};
  if (!isRecord(serializerConfig) || Array.isArray(serializerConfig)) {
    throw configurationError("withLogBrewMetroConfig requires config.serializer to be an object");
  }
  return serializerConfig;
}

/**
 * @param {unknown} config
 * @param {unknown} [options]
 * @returns {unknown}
 */
function withLogBrewMetroConfig(config, options = {}) {
  requireOptions(options);
  if (!isRecord(config) || Array.isArray(config)) {
    throw configurationError("withLogBrewMetroConfig requires a Metro config object");
  }
  if (options.enabled === false) {
    return config;
  }
  const serializerConfig = requireSerializerConfig(config);
  if (field(serializerConfig["customSerializer"], WRAPPED_SERIALIZER) === true) {
    return config;
  }
  return {
    ...config,
    serializer: {
      ...serializerConfig,
      customSerializer: createLogBrewMetroSerializer(serializerConfig["customSerializer"])
    }
  };
}

module.exports = {
  createLogBrewMetroSerializer,
  getLogBrewExpoConfig,
  withLogBrewMetroConfig,

  default: withLogBrewMetroConfig
};
