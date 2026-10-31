"use strict";

const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");

/**
 * @typedef {(this: unknown, ...args: readonly unknown[]) => unknown} Callable
 * @typedef {Error & { code: string }} ConfigurationError
 */

const DEBUG_ID_PLACEHOLDER = "__LOGBREW_REACT_NATIVE_DEBUG_ID__";
const DEBUG_ID_MODULE_PATH = "__logbrew_debug_id__";
const DEBUG_ID_REGISTRY_NAME = "@logbrew/react-native/debug-ids";
const RUNTIME_DEBUG_ID_MARKER = "/*logbrew-runtime-debug-id*/";
const DEBUG_ID_KEYS = ["debug_id", "debugId", "debugID", "x_debug_id"];
const DEBUG_ID_COMMENT_RE = /(?:\/\/[#@]|\/\*[#@])\s*debugId=[^\r\n]*/iu;
const SOURCE_MAPPING_COMMENT_RE = /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=[^\r\n]*/giu;
const NO_LINES = 0;
const NO_MATCHES = 0;
const LAST = -1;
const FIRST = 0;
const SECOND = 1;
const PLACEHOLDER_PARTS = 2;
const DEBUG_ID_BYTES = 16;
const VERSION_BYTE = 6;
const VARIANT_BYTE = 8;
const LOW_NIBBLE = 16;
const VERSION_FIVE = 80;
const VARIANT_BITS = 64;
const RFC_4122_VARIANT = 128;
const TIME_LOW_END = 8;
const TIME_MID_END = 12;
const TIME_HIGH_END = 16;
const CLOCK_SEQ_END = 20;

/**
 * @param {unknown} value
 * @param {PropertyKey} key
 * @returns {unknown}
 */
function field(value, key) {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is Callable}
 */
function isCallable(value) {
  return typeof value === "function";
}

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isArray(value) {
  return Array.isArray(value);
}

/**
 * @param {string} message
 * @param {Readonly<ErrorOptions>} [options]
 * @returns {ConfigurationError}
 */
function configurationError(message, options) {
  return Object.assign(new Error(message, options), { code: "configuration_error" });
}

/**
 * @param {string} debugId
 * @returns {string}
 */
function runtimeDebugIdSnippet(debugId) {
  const embedded = `${RUNTIME_DEBUG_ID_MARKER}//# debugId=${debugId}`;
  return `;(()=>{try{const d=${JSON.stringify(embedded)}.slice(-36),k=Symbol.for(${JSON.stringify(DEBUG_ID_REGISTRY_NAME)}),g=globalThis,r=g[k]||(g[k]=Object.create(null)),s=(new Error).stack;if(s){r[s]=d;const e=Object.keys(r);if(e.length>64)delete r[e[0]]}}catch{}})();`;
}

/**
 * @param {string} source
 * @returns {number}
 */
function countLines(source) {
  return source === "" ? NO_LINES : source.split("\n").length;
}

/**
 * @param {string} [debugId]
 * @returns {Readonly<Record<string, unknown>>}
 */
function createDebugIdModule(debugId = DEBUG_ID_PLACEHOLDER) {
  const code = runtimeDebugIdSnippet(debugId);
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
          map: []
        }
      }
    ]
  };
}

/**
 * @param {unknown} preModules
 * @param {string} [debugId]
 * @returns {readonly unknown[]}
 */
function prependDebugIdModule(preModules, debugId = DEBUG_ID_PLACEHOLDER) {
  if (!isArray(preModules)) {
    throw configurationError("LogBrew Metro serializer expected preModules to be an array");
  }
  if (preModules.some((candidate) => field(candidate, "path") === DEBUG_ID_MODULE_PATH)) {
    return preModules;
  }
  const debugIdModule = createDebugIdModule(debugId);
  if (field(preModules[FIRST], "path") === "__prelude__") {
    return [preModules[FIRST], debugIdModule, ...preModules.slice(SECOND)];
  }
  return [debugIdModule, ...preModules];
}

/**
 * @param {unknown} graph
 * @returns {boolean}
 */
function isDevelopmentGraph(graph) {
  const transformOptions = field(graph, "transformOptions");
  return field(transformOptions, "hot") === true || field(transformOptions, "dev") === true;
}

/**
 * @param {string} value
 * @returns {unknown}
 */
function parseSourceMapJson(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw configurationError(`LogBrew Metro production serializer returned invalid source map JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function parseSourceMap(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw configurationError("LogBrew Metro production serializer must return a non-empty source map string");
  }
  const sourceMap = parseSourceMapJson(value);
  if (!isRecord(sourceMap) || Array.isArray(sourceMap)) {
    throw configurationError("LogBrew Metro production serializer source map must be an object");
  }
  return { ...sourceMap };
}

/**
 * @param {Readonly<Record<string, unknown>>} sourceMap
 * @returns {string}
 */
function canonicalSourceMap(sourceMap) {
  const copy = { ...sourceMap };
  for (const key of DEBUG_ID_KEYS) {
    Reflect.deleteProperty(copy, key);
  }
  return JSON.stringify(copy);
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function formatDebugId(bytes) {
  const value = Buffer.from(bytes.subarray(FIRST, DEBUG_ID_BYTES));
  value.writeUInt8((value.readUInt8(VERSION_BYTE) % LOW_NIBBLE) + VERSION_FIVE, VERSION_BYTE);
  value.writeUInt8((value.readUInt8(VARIANT_BYTE) % VARIANT_BITS) + RFC_4122_VARIANT, VARIANT_BYTE);
  const hex = value.toString("hex");
  return `${hex.slice(FIRST, TIME_LOW_END)}-${hex.slice(TIME_LOW_END, TIME_MID_END)}-${hex.slice(TIME_MID_END, TIME_HIGH_END)}-${hex.slice(TIME_HIGH_END, CLOCK_SEQ_END)}-${hex.slice(CLOCK_SEQ_END)}`;
}

/**
 * @param {string} code
 * @param {Readonly<Record<string, unknown>>} sourceMap
 * @returns {string}
 */
function createDebugId(code, sourceMap) {
  const digest = crypto
    .createHash("sha256")
    .update(code.split(DEBUG_ID_PLACEHOLDER).join(""))
    .update("\0")
    .update(canonicalSourceMap(sourceMap))
    .digest();
  return formatDebugId(digest);
}

/**
 * @param {string} source
 * @param {string} debugId
 * @returns {string}
 */
function sourceWithDebugId(source, debugId) {
  const replaced = source.split(DEBUG_ID_PLACEHOLDER).join(debugId);
  const debugLine = `//# debugId=${debugId}\n`;
  const matches = [...replaced.matchAll(SOURCE_MAPPING_COMMENT_RE)];
  const last = matches.at(LAST);
  if (matches.length === NO_MATCHES || last === undefined) {
    return `${replaced}${replaced.endsWith("\n") ? "" : "\n"}${debugLine}`;
  }
  const prefix = replaced.slice(FIRST, last.index);
  const separator = prefix.endsWith("\n") || prefix.endsWith("\r") ? "" : "\n";
  return `${prefix}${separator}${debugLine}${replaced.slice(last.index)}`;
}

/**
 * @param {unknown} result
 * @returns {Readonly<Record<string, unknown>>}
 */
function requireResultObject(result) {
  if (Array.isArray(result)) {
    throw configurationError(
      "LogBrew Metro received Expo static assets; use getLogBrewExpoConfig instead of withLogBrewMetroConfig for Expo projects"
    );
  }
  if (!isRecord(result)) {
    throw configurationError("LogBrew Metro production serializer must return { code, map }");
  }
  return result;
}

/**
 * @param {Readonly<Record<string, unknown>>} result
 * @returns {string}
 */
function requireProductionCode(result) {
  const { code } = result;
  if (typeof code !== "string") {
    throw configurationError("LogBrew Metro production serializer code must be a string");
  }
  if (code.split(DEBUG_ID_PLACEHOLDER).length !== PLACEHOLDER_PARTS) {
    throw configurationError("LogBrew Metro production serializer must include the injected Debug ID module exactly once");
  }
  if (DEBUG_ID_COMMENT_RE.test(code.replace(`${RUNTIME_DEBUG_ID_MARKER}//# debugId=${DEBUG_ID_PLACEHOLDER}`, ""))) {
    throw configurationError("LogBrew Metro production serializer already contains Debug ID metadata");
  }
  return code;
}

/**
 * @param {unknown} result
 * @returns {Record<string, unknown>}
 */
function productionResult(result) {
  const checked = requireResultObject(result);
  const code = requireProductionCode(checked);
  const sourceMap = parseSourceMap(checked["map"]);
  if (DEBUG_ID_KEYS.some((key) => Object.hasOwn(sourceMap, key))) {
    throw configurationError("LogBrew Metro production serializer already contains Debug ID metadata");
  }
  const debugId = createDebugId(code, sourceMap);
  sourceMap["debug_id"] = debugId;
  sourceMap["debugId"] = debugId;
  return {
    ...checked,
    code: sourceWithDebugId(code, debugId),
    map: JSON.stringify(sourceMap)
  };
}

module.exports = {
  configurationError,
  field,
  isCallable,
  isDevelopmentGraph,
  isRecord,
  prependDebugIdModule,
  productionResult
};
