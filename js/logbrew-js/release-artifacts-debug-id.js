import { SOURCE_MAP_DEBUG_ID_KEYS, stableJson } from "./release-artifacts-common.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/** @import { JsonObject } from "./release-artifacts-common.js" */

const DEBUG_ID_NAMESPACE = "16f4a837-7e0b-4d7c-97d9-8a7af1fd2768";
const DEBUG_ID_RE = /(?:\/\/#|\/\*#)\s*debugId=(?<debugId>[A-Za-z0-9._:-]+)/giu;
const DEBUG_ID_REGISTRY_NAME = "logbrew.release-artifact.debug-ids";
const DEBUG_ID_REGISTRY_EXPRESSION = `Symbol.for(${JSON.stringify(DEBUG_ID_REGISTRY_NAME)})`;
const HERMES_RUNTIME_DEBUG_ID_RE =
  /\/\*logbrew-runtime-debug-id\*\/\/\/# debugId=(?<debugId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/iu;
const RUNTIME_DEBUG_ID_MARKER = "/*logbrew-runtime-debug-id*/";
const SOURCE_MAPPING_COMMENT_RE = /(?:\/\/#|\/\*#)\s*sourceMappingURL=[^\r\n]*/giu;
const SOURCE_MAPPING_RE = /(?:\/\/#|\/\*#)\s*sourceMappingURL=(?<url>[^\s*]+)/iu;
const SHEBANG_LINE_RE = /^#![^\r\n]*(?:\r?\n|$)/u;
const LEADING_TRIVIA_RE = /^(?:\s|\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/u;
const UUID_BYTE_LENGTH = 16;
const UUID_TIME_LOW_LENGTH = 8;
const UUID_SHORT_GROUP_LENGTH = 4;
const UUID_NODE_LENGTH = 12;
const UUID_GROUP_LENGTHS = [
  UUID_TIME_LOW_LENGTH,
  UUID_SHORT_GROUP_LENGTH,
  UUID_SHORT_GROUP_LENGTH,
  UUID_SHORT_GROUP_LENGTH,
  UUID_NODE_LENGTH
];
const UUID_VERSION_BYTE = 6;
const UUID_VARIANT_BYTE = 8;
const UUID_VERSION_MODULUS = 16;
const UUID_VERSION_5_BITS = 80;
const UUID_VARIANT_MODULUS = 64;
const UUID_RFC_4122_VARIANT_BITS = 128;
const UUID_START = 0;
const LAST_INDEX = -1;

/**
 * @param {string} source
 * @returns {string | undefined}
 */
function findDebugId(source) {
  const runtimeDebugId = HERMES_RUNTIME_DEBUG_ID_RE.exec(source)?.groups?.["debugId"];
  if (runtimeDebugId !== undefined) {
    return runtimeDebugId;
  }
  return [...source.matchAll(DEBUG_ID_RE)].at(LAST_INDEX)?.groups?.["debugId"]?.trim();
}

/**
 * @param {string} source
 * @returns {string | undefined}
 */
function findSourceMappingUrl(source) {
  return SOURCE_MAPPING_RE.exec(source)?.groups?.["url"]?.trim();
}

/**
 * @param {string} hex
 * @returns {string}
 */
function formatUuid(hex) {
  /** @type {string[]} */
  const groups = [];
  let offset = UUID_START;
  for (const length of UUID_GROUP_LENGTHS) {
    groups.push(hex.slice(offset, offset + length));
    offset += length;
  }
  return groups.join("-");
}

/**
 * @param {string} namespace
 * @param {string} name
 * @returns {string}
 */
function uuidV5(namespace, name) {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(UUID_START, UUID_BYTE_LENGTH);
  bytes.writeUInt8((bytes.readUInt8(UUID_VERSION_BYTE) % UUID_VERSION_MODULUS) + UUID_VERSION_5_BITS, UUID_VERSION_BYTE);
  bytes.writeUInt8(
    (bytes.readUInt8(UUID_VARIANT_BYTE) % UUID_VARIANT_MODULUS) + UUID_RFC_4122_VARIANT_BITS,
    UUID_VARIANT_BYTE
  );
  return formatUuid(bytes.toString("hex"));
}

/**
 * @param {JsonObject} payload
 * @returns {string}
 */
function canonicalSourceMapWithoutDebugId(payload) {
  const keys = Object.keys(payload).filter((key) => !SOURCE_MAP_DEBUG_ID_KEYS.includes(key));
  return stableJson(Object.fromEntries(keys.map((key) => [key, payload[key]])));
}

/**
 * @param {string} relativeJsPath
 * @param {string} jsSource
 * @param {JsonObject} sourceMapPayload
 * @returns {string}
 */
function generateDebugId(relativeJsPath, jsSource, sourceMapPayload) {
  const digest = createHash("sha256");
  digest.update(relativeJsPath);
  digest.update("\0");
  digest.update(jsSource.replaceAll(DEBUG_ID_RE, ""));
  digest.update("\0");
  digest.update(canonicalSourceMapWithoutDebugId(sourceMapPayload));
  return uuidV5(DEBUG_ID_NAMESPACE, digest.digest("hex"));
}

/**
 * @param {string} source
 * @returns {string}
 */
function executableShebang(source) {
  return source.startsWith("#!") ? (SHEBANG_LINE_RE.exec(source)?.[UUID_START] ?? "") : "";
}

/**
 * @param {string} source
 * @returns {boolean}
 */
function sourceStartsWithDirective(source) {
  const body = source.slice(executableShebang(source).length).replace(LEADING_TRIVIA_RE, "");
  return body.startsWith("\"") || body.startsWith("'");
}

/**
 * @param {string} source
 * @param {string} debugId
 * @param {string} relativePath
 * @returns {string}
 */
function sourceWithRuntimeDebugId(source, debugId, relativePath) {
  if (source.includes(RUNTIME_DEBUG_ID_MARKER)) {
    return source;
  }
  const registryLine = `;try{${RUNTIME_DEBUG_ID_MARKER}(function(){var g=globalThis,s=${DEBUG_ID_REGISTRY_EXPRESSION},r=g[s];if(!r||typeof r!=="object")r=g[s]=Object.create(null);r[${JSON.stringify(relativePath)}]=${JSON.stringify(debugId)}})()}catch(_){}\n`;
  const shebang = executableShebang(source);
  const separator = shebang === source && shebang !== "" ? "\n" : "";
  return `${shebang}${separator}${registryLine}${source.slice(shebang.length)}`;
}

/**
 * @param {string} source
 * @param {string} debugId
 * @param {string} relativePath
 * @returns {string}
 */
function sourceWithDebugId(source, debugId, relativePath) {
  const prepared = sourceWithRuntimeDebugId(source, debugId, relativePath);
  if (findDebugId(prepared) !== undefined) {
    return prepared;
  }
  const debugLine = `//# debugId=${debugId}\n`;
  const last = [...prepared.matchAll(SOURCE_MAPPING_COMMENT_RE)].at(LAST_INDEX);
  if (last === undefined) {
    return `${prepared}${prepared.endsWith("\n") ? "" : "\n"}${debugLine}`;
  }
  const prefix = prepared.slice(UUID_START, last.index);
  const separator = prefix.endsWith("\n") || prefix.endsWith("\r") ? "" : "\n";
  return `${prefix}${separator}${debugLine}${prepared.slice(last.index)}`;
}

export {
  RUNTIME_DEBUG_ID_MARKER,
  findDebugId,
  findSourceMappingUrl,
  generateDebugId,
  sourceStartsWithDirective,
  sourceWithDebugId
};
