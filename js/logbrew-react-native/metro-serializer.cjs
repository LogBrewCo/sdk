"use strict";

const { createRequire } = require("node:module");
const { configurationError, field, isCallable, isDevelopmentGraph } = require("./metro-debug-id.cjs");

/**
 * @typedef {(this: unknown, ...args: readonly unknown[]) => unknown} Callable
 * @typedef {(entryPoint: unknown, preModules: unknown, graph: unknown, options: unknown) => Promise<unknown>} MetroSerializer
 */

/**
 * @param {string} privatePath
 * @param {string} sourcePath
 * @returns {unknown}
 */
function requireMetroModule(privatePath, sourcePath) {
  try {
    return require(privatePath);
  } catch (privateError) {
    try {
      return require(sourcePath);
    } catch {
      throw configurationError(
        `LogBrew Metro could not load ${privatePath}; install a supported React Native Metro package`,
        { cause: privateError }
      );
    }
  }
}

/**
 * @param {unknown} moduleValue
 * @param {readonly string[]} names
 * @param {string} label
 * @returns {Callable}
 */
function moduleFunction(moduleValue, names, label) {
  if (isCallable(moduleValue)) {
    return moduleValue;
  }
  for (const name of names) {
    const candidate = field(moduleValue, name);
    if (isCallable(candidate)) {
      return candidate;
    }
  }
  throw configurationError(`LogBrew Metro could not resolve ${label} from the installed Metro package`);
}

/**
 * @param {unknown} value
 * @returns {value is Iterable<unknown>}
 */
function isIterable(value) {
  return typeof value === "string" || isCallable(field(value, Symbol.iterator));
}

/**
 * @param {unknown} values
 * @returns {Iterable<unknown>}
 */
function requireIterable(values) {
  if (!isIterable(values)) {
    throw new TypeError("Spread syntax requires ...iterable[Symbol.iterator] to be a function");
  }
  return values;
}

/**
 * @param {unknown} graph
 * @returns {unknown}
 */
function graphDependencyValues(graph) {
  const dependencies = field(graph, "dependencies");
  const values = field(dependencies, "values");
  if (values === undefined || values === null) {
    return [];
  }
  if (!isCallable(values)) {
    throw new TypeError("graph?.dependencies?.values is not a function");
  }
  return values.call(dependencies) ?? [];
}

/**
 * @param {unknown} graph
 * @param {unknown} options
 * @returns {unknown[]}
 */
function sortedModules(graph, options) {
  const modules = [...requireIterable(graphDependencyValues(graph))];
  const createModuleId = field(options, "createModuleId");
  if (!isCallable(createModuleId)) {
    return modules;
  }
  modules.sort((left, right) => (
    Number(createModuleId.call(options, field(left, "path"))) - Number(createModuleId.call(options, field(right, "path")))
  ));
  return modules;
}

/**
 * @template {Callable | null} Fallback
 * @param {unknown} options
 * @param {string} name
 * @param {Fallback} fallback
 * @returns {Callable | Fallback}
 */
function optionFunction(options, name, fallback) {
  const value = field(options, name);
  return isCallable(value) ? value : fallback;
}

/**
 * @returns {{ readonly fromRawMappings: Callable, readonly getSourceMapInfo: Callable, readonly isJsModule: Callable }}
 */
function loadSourceMapHelpers() {
  const getSourceMapInfo = moduleFunction(
    requireMetroModule(
      "metro/private/DeltaBundler/Serializers/helpers/getSourceMapInfo",
      "metro/src/DeltaBundler/Serializers/helpers/getSourceMapInfo"
    ),
    ["default"],
    "getSourceMapInfo"
  );
  const isJsModule = moduleFunction(
    requireMetroModule(
      "metro/private/DeltaBundler/Serializers/helpers/js",
      "metro/src/DeltaBundler/Serializers/helpers/js"
    ),
    ["isJsModule"],
    "isJsModule"
  );
  const metroRequire = createRequire(require.resolve("metro/package.json"));
  /** @type {unknown} */
  const sourceMapModule = metroRequire("metro-source-map");
  const fromRawMappings = moduleFunction(sourceMapModule, ["fromRawMappings"], "fromRawMappings");
  return { fromRawMappings, getSourceMapInfo, isJsModule };
}

/**
 * @param {unknown} generator
 * @param {unknown} sourceMapOptions
 * @returns {unknown}
 */
function sourceMapString(generator, sourceMapOptions) {
  const toString = field(generator, "toString");
  if (!isCallable(toString)) {
    throw new TypeError("fromRawMappings(...).toString is not a function");
  }
  return toString.call(generator, undefined, sourceMapOptions);
}

/**
 * @returns {(preModules: unknown, graph: unknown, options: unknown) => unknown}
 */
function createMetroSourceMapSerializer() {
  const { fromRawMappings, getSourceMapInfo, isJsModule } = loadSourceMapHelpers();
  return (preModules, graph, options) => {
    const sourceMapOptions = {
      excludeSource: field(options, "excludeSource") === true,
      getSourceUrl: optionFunction(options, "getSourceUrl", null),
      processModuleFilter: optionFunction(options, "processModuleFilter", () => true),
      shouldAddToIgnoreList: optionFunction(options, "shouldAddToIgnoreList", () => false)
    };
    const modules = [...requireIterable(preModules), ...sortedModules(graph, options)]
      .filter(
        /**
         * @param {unknown} module
         * @param {number} index
         * @param {readonly unknown[]} array
         * @returns {boolean}
         */
        (module, index, array) => Boolean(isJsModule(module, index, array))
      )
      .filter(
        /**
         * @param {unknown} module
         * @param {number} index
         * @param {readonly unknown[]} array
         * @returns {boolean}
         */
        (module, index, array) => Boolean(sourceMapOptions.processModuleFilter(module, index, array))
      )
      .map((module) => getSourceMapInfo(module, sourceMapOptions));
    return sourceMapString(fromRawMappings(modules), sourceMapOptions);
  };
}

/**
 * @returns {MetroSerializer}
 */
function createDefaultMetroSerializer() {
  const baseJSBundle = moduleFunction(
    requireMetroModule(
      "metro/private/DeltaBundler/Serializers/baseJSBundle",
      "metro/src/DeltaBundler/Serializers/baseJSBundle"
    ),
    ["baseJSBundle", "default"],
    "baseJSBundle"
  );
  const bundleToString = moduleFunction(
    requireMetroModule("metro/private/lib/bundleToString", "metro/src/lib/bundleToString"),
    ["bundleToString", "default"],
    "bundleToString"
  );
  const serializeSourceMap = createMetroSourceMapSerializer();

  return async (entryPoint, preModules, graph, options) => {
    const code = field(bundleToString(baseJSBundle(entryPoint, preModules, graph, options)), "code");
    if (isDevelopmentGraph(graph)) {
      return code;
    }
    const map = await serializeSourceMap(preModules, graph, options);
    return { code, map };
  };
}

module.exports = { createDefaultMetroSerializer };
