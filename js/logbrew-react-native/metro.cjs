"use strict";

const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");

const DEBUG_ID_PLACEHOLDER = "__LOGBREW_REACT_NATIVE_DEBUG_ID__";
const DEBUG_ID_MODULE_PATH = "__logbrew_debug_id__";
const DEBUG_ID_REGISTRY_NAME = "@logbrew/react-native/debug-ids";
const DEBUG_ID_KEYS = ["debug_id", "debugId", "debugID", "x_debug_id"];
const DEBUG_ID_COMMENT_RE = /(?:\/\/[#@]|\/\*[#@])\s*debugId=[^\r\n]*/iu;
const SOURCE_MAPPING_COMMENT_RE = /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=[^\r\n]*/giu;
const WRAPPED_SERIALIZER = Symbol.for("@logbrew/react-native/metro-serializer");

function configurationError(message, options) {
  const error = new Error(message, options);
  error.code = "configuration_error";
  return error;
}

function requireOptions(options) {
  if (!options || Array.isArray(options) || typeof options !== "object") {
    throw configurationError("LogBrew Metro options must be an object");
  }
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") {
    throw configurationError("LogBrew Metro option enabled must be a boolean");
  }
  return options;
}

function runtimeDebugIdSnippet(debugId) {
  return `;(()=>{try{const k=Symbol.for(${JSON.stringify(DEBUG_ID_REGISTRY_NAME)}),g=globalThis,r=g[k]||(g[k]=Object.create(null)),s=(new Error).stack;if(s){r[s]=${JSON.stringify(debugId)};const e=Object.keys(r);if(e.length>64)delete r[e[0]]}}catch{}})();`;
}

function countLines(source) {
  return source === "" ? 0 : source.split("\n").length;
}

function createDebugIdModule() {
  const code = runtimeDebugIdSnippet(DEBUG_ID_PLACEHOLDER);
  return {
    dependencies: new Map(),
    getSource: () => Buffer.from(code),
    inverseDependencies: new Set(),
    path: DEBUG_ID_MODULE_PATH,
    output: [
      {
        type: "js/script/virtual",
        data: {
          code,
          lineCount: countLines(code),
          map: [],
        },
      },
    ],
  };
}

function prependDebugIdModule(preModules) {
  if (!Array.isArray(preModules)) {
    throw configurationError("LogBrew Metro serializer expected preModules to be an array");
  }
  if (preModules.some((module) => module?.path === DEBUG_ID_MODULE_PATH)) {
    return preModules;
  }
  const debugIdModule = createDebugIdModule();
  if (preModules[0]?.path === "__prelude__") {
    return [preModules[0], debugIdModule, ...preModules.slice(1)];
  }
  return [debugIdModule, ...preModules];
}

function isDevelopmentGraph(graph) {
  const transformOptions = graph?.transformOptions;
  return transformOptions?.hot === true || transformOptions?.dev === true;
}

function parseSourceMap(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw configurationError("LogBrew Metro production serializer must return a non-empty source map string");
  }
  let sourceMap;
  try {
    sourceMap = JSON.parse(value);
  } catch (error) {
    throw configurationError(`LogBrew Metro production serializer returned invalid source map JSON: ${error.message}`);
  }
  if (!sourceMap || Array.isArray(sourceMap) || typeof sourceMap !== "object") {
    throw configurationError("LogBrew Metro production serializer source map must be an object");
  }
  return sourceMap;
}

function canonicalSourceMap(sourceMap) {
  const copy = { ...sourceMap };
  for (const key of DEBUG_ID_KEYS) {
    delete copy[key];
  }
  return JSON.stringify(copy);
}

function formatDebugId(bytes) {
  const value = Buffer.from(bytes.subarray(0, 16));
  value[6] = (value[6] & 0x0f) | 0x50;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createDebugId(code, sourceMap) {
  const digest = crypto
    .createHash("sha256")
    .update(code.split(DEBUG_ID_PLACEHOLDER).join(""))
    .update("\0")
    .update(canonicalSourceMap(sourceMap))
    .digest();
  return formatDebugId(digest);
}

function sourceWithDebugId(source, debugId) {
  const replaced = source.split(DEBUG_ID_PLACEHOLDER).join(debugId);
  const debugLine = `//# debugId=${debugId}\n`;
  const matches = [...replaced.matchAll(SOURCE_MAPPING_COMMENT_RE)];
  if (matches.length === 0) {
    return `${replaced}${replaced.endsWith("\n") ? "" : "\n"}${debugLine}`;
  }
  const last = matches.at(-1);
  const prefix = replaced.slice(0, last.index);
  const separator = prefix.endsWith("\n") || prefix.endsWith("\r") ? "" : "\n";
  return `${prefix}${separator}${debugLine}${replaced.slice(last.index)}`;
}

function productionResult(result) {
  if (!result || Array.isArray(result) || typeof result !== "object") {
    throw configurationError("LogBrew Metro production serializer must return { code, map }");
  }
  if (typeof result.code !== "string") {
    throw configurationError("LogBrew Metro production serializer code must be a string");
  }
  if (result.code.split(DEBUG_ID_PLACEHOLDER).length !== 2) {
    throw configurationError("LogBrew Metro production serializer must include the injected Debug ID module exactly once");
  }
  if (DEBUG_ID_COMMENT_RE.test(result.code)) {
    throw configurationError("LogBrew Metro production serializer already contains Debug ID metadata");
  }
  const sourceMap = parseSourceMap(result.map);
  if (DEBUG_ID_KEYS.some((key) => Object.prototype.hasOwnProperty.call(sourceMap, key))) {
    throw configurationError("LogBrew Metro production serializer already contains Debug ID metadata");
  }
  const debugId = createDebugId(result.code, sourceMap);
  sourceMap.debug_id = debugId;
  sourceMap.debugId = debugId;
  return {
    ...result,
    code: sourceWithDebugId(result.code, debugId),
    map: JSON.stringify(sourceMap),
  };
}

function requireMetroModule(privatePath, sourcePath) {
  try {
    return require(privatePath);
  } catch (privateError) {
    try {
      return require(sourcePath);
    } catch {
      throw configurationError(
        `LogBrew Metro could not load ${privatePath}; install a supported React Native Metro package`,
        { cause: privateError },
      );
    }
  }
}

function moduleFunction(moduleValue, names, label) {
  if (typeof moduleValue === "function") {
    return moduleValue;
  }
  for (const name of names) {
    if (typeof moduleValue?.[name] === "function") {
      return moduleValue[name];
    }
  }
  throw configurationError(`LogBrew Metro could not resolve ${label} from the installed Metro package`);
}

function sortedModules(graph, options) {
  const modules = [...(graph?.dependencies?.values?.() ?? [])];
  if (typeof options?.createModuleId !== "function") {
    return modules;
  }
  return modules.sort((left, right) => options.createModuleId(left.path) - options.createModuleId(right.path));
}

function createMetroSourceMapSerializer() {
  const sourceMapModule = requireMetroModule(
    "metro/private/DeltaBundler/Serializers/sourceMapString",
    "metro/src/DeltaBundler/Serializers/sourceMapString",
  );
  const sourceMapString = moduleFunction(
    sourceMapModule,
    ["sourceMapStringNonBlocking", "sourceMapString", "default"],
    "sourceMapString",
  );

  return (preModules, graph, options) =>
    sourceMapString([...preModules, ...sortedModules(graph, options)], {
      excludeSource: options?.excludeSource === true,
      getSourceUrl: typeof options?.getSourceUrl === "function" ? options.getSourceUrl : null,
      processModuleFilter: typeof options?.processModuleFilter === "function" ? options.processModuleFilter : () => true,
      shouldAddToIgnoreList:
        typeof options?.shouldAddToIgnoreList === "function" ? options.shouldAddToIgnoreList : () => false,
    });
}

function createDefaultMetroSerializer() {
  const baseJSBundle = moduleFunction(
    requireMetroModule(
      "metro/private/DeltaBundler/Serializers/baseJSBundle",
      "metro/src/DeltaBundler/Serializers/baseJSBundle",
    ),
    ["baseJSBundle", "default"],
    "baseJSBundle",
  );
  const bundleToString = moduleFunction(
    requireMetroModule("metro/private/lib/bundleToString", "metro/src/lib/bundleToString"),
    ["bundleToString", "default"],
    "bundleToString",
  );
  const serializeSourceMap = createMetroSourceMapSerializer();

  return async (entryPoint, preModules, graph, options) => {
    const code = bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code;
    if (isDevelopmentGraph(graph)) {
      return code;
    }
    const map = await serializeSourceMap(preModules, graph, options);
    return { code, map };
  };
}

function createLogBrewMetroSerializer(customSerializer) {
  if (customSerializer !== undefined && customSerializer !== null && typeof customSerializer !== "function") {
    throw configurationError("LogBrew Metro custom serializer must be a function");
  }
  if (customSerializer?.[WRAPPED_SERIALIZER] === true) {
    return customSerializer;
  }

  let serializerSource = customSerializer ?? undefined;
  let fallbackSerializer;
  const resolveSerializer = () => {
    serializerSource ??= createDefaultMetroSerializer();
    return serializerSource;
  };
  const resolveFallbackSerializer = () => {
    fallbackSerializer ??= createDefaultMetroSerializer();
    return fallbackSerializer;
  };

  const serializer = async (entryPoint, preModules, graph, options) => {
    const source = resolveSerializer();
    if (isDevelopmentGraph(graph)) {
      return source(entryPoint, preModules, graph, options);
    }
    const releaseModules = prependDebugIdModule(preModules);
    const result = await source(entryPoint, releaseModules, graph, options);
    if (typeof result === "string") {
      const fallbackResult = await resolveFallbackSerializer()(entryPoint, releaseModules, graph, options);
      if (typeof fallbackResult === "string" || fallbackResult.code !== result) {
        throw configurationError(
          "LogBrew Metro string-returning custom serializer changed bundle code; return { code, map } to preserve source-map accuracy",
        );
      }
      return productionResult(fallbackResult);
    }
    return productionResult(result);
  };
  Object.defineProperty(serializer, WRAPPED_SERIALIZER, { value: true });
  return serializer;
}

function withLogBrewMetroConfig(config, options = {}) {
  requireOptions(options);
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw configurationError("withLogBrewMetroConfig requires a Metro config object");
  }
  if (options.enabled === false) {
    return config;
  }
  const serializerConfig = config.serializer ?? {};
  if (!serializerConfig || Array.isArray(serializerConfig) || typeof serializerConfig !== "object") {
    throw configurationError("withLogBrewMetroConfig requires config.serializer to be an object");
  }
  if (serializerConfig.customSerializer?.[WRAPPED_SERIALIZER] === true) {
    return config;
  }
  return {
    ...config,
    serializer: {
      ...serializerConfig,
      customSerializer: createLogBrewMetroSerializer(serializerConfig.customSerializer),
    },
  };
}

module.exports = {
  createLogBrewMetroSerializer,
  withLogBrewMetroConfig,
  default: withLogBrewMetroConfig,
};
