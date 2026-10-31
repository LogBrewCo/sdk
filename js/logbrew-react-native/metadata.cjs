"use strict";

const { NULL_VALUE } = require("./null-value.cjs");

/**
 * @import { IssueExceptionChain, IssueExceptionChainEntry, IssueStackFrame, Metadata, MetadataValue } from "@logbrew/sdk"
 * @typedef {(metadata: Readonly<Record<string, unknown>>) => Metadata} CompactMetadata
 */

const SENSITIVE_METADATA_FACTORY_KEY_RE = new RegExp([
  "body",
  "payload",
  "variable",
  "header",
  "authorization",
  "cookie",
  "token",
  "secret",
  "password"
].join("|"), "u");
const REACT_NATIVE_DEBUG_ID_REGISTRY = Symbol.for("@logbrew/react-native/debug-ids");
const SAFE_RELEASE_ARTIFACT_DEBUG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_REACT_NATIVE_DEBUG_ID_REGISTRY_ENTRIES = 64;
const MAX_REACT_NATIVE_DEBUG_ID_REGISTRY_FRAMES = 128;
const GENERIC_REACT_NATIVE_FRAME_FUNCTION = /^(?:<anonymous>|anonymous|apply|call|eval|global code|native|next)$/iu;
const GROUPING_KEY_RE = /^(?<kind>[^:]+):(?<scope>[^:]+):(?<location>.+)$/u;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/u;
const NO_ITEMS = 0;
const FIRST = 0;
const STEP = 1;
const AT_PREFIX_LENGTH = 3;
const MIN_LOCATION_PARTS = 3;
const NOT_FOUND = -1;
/** @type {readonly Readonly<IssueStackFrame>[]} */
const DEFAULT_STACK_FRAMES = Object.freeze([]);

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {value is (context: unknown) => unknown}
 */
function isMetadataFactory(value) {
  return typeof value === "function";
}

/**
 * @param {readonly Readonly<IssueStackFrame>[] | undefined} value
 * @returns {value is readonly Readonly<IssueStackFrame>[]}
 */
function isFrameList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is MetadataValue}
 */
function isMetadataValue(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isSensitiveMetadataKey(key) {
  return SENSITIVE_METADATA_FACTORY_KEY_RE.test(String(key).toLowerCase());
}

/**
 * @param {unknown} candidate
 * @returns {Metadata}
 */
function safeReactNativeMetadataFactoryResult(candidate) {
  if (!isRecord(candidate) || Array.isArray(candidate)) {
    return {};
  }
  /** @type {Metadata} */
  const metadata = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!isSensitiveMetadataKey(key) && isMetadataValue(value)) {
      metadata[key] = value;
    }
  }
  return metadata;
}

/**
 * @param {Readonly<Metadata> | undefined} metadata
 * @param {unknown} metadataFactory
 * @param {unknown} context
 * @returns {Readonly<Metadata> | undefined}
 */
function createSafeReactNativeMetadata(metadata, metadataFactory, context) {
  if (!isMetadataFactory(metadataFactory)) {
    return metadata;
  }
  return {
    ...metadata,
    ...safeReactNativeMetadataFactoryResult(metadataFactory(context))
  };
}

/**
 * @param {string} path
 * @returns {string}
 */
function stripQueryAndHash(path) {
  return (path.split(/[?#]/u, STEP)[FIRST] ?? "").replaceAll("\\", "/");
}

/**
 * @param {string} value
 * @returns {string}
 */
function urlPathname(value) {
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor !== "function") {
    return stripQueryAndHash(value);
  }
  try {
    return new URLConstructor(value).pathname || value;
  } catch {
    return stripQueryAndHash(value);
  }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function reactNativeCodePath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const path = urlPathname(value.trim());
  if (/^[A-Za-z]:\//u.test(path) || /^\/(?:Users|home|private|tmp|var)\//u.test(path)) {
    const trimmed = path.replace(/\/+$/u, "");
    return trimmed.slice(trimmed.lastIndexOf("/") + STEP) || undefined;
  }
  return path || undefined;
}

/**
 * @param {string | undefined} path
 * @param {readonly Readonly<IssueStackFrame>[]} [stackFrames]
 * @returns {string | undefined}
 */
function reactNativeGroupingIdentity(path, stackFrames = DEFAULT_STACK_FRAMES) {
  if (path !== "/" || stackFrames.length === NO_ITEMS) {
    return path;
  }
  const named = stackFrames.find(({ function: name }) => name !== undefined && name !== "" && !GENERIC_REACT_NATIVE_FRAME_FUNCTION.test(name));
  if (named) {
    return `function=${String(named.function)}`;
  }
  const frame = stackFrames[FIRST];
  return `position=${String(frame?.line)}:${String(frame?.column)}`;
}

/**
 * @param {Readonly<Metadata> | undefined} metadata
 * @param {CompactMetadata} compactMetadata
 * @param {readonly Readonly<IssueStackFrame>[] | undefined} stackFrames
 * @returns {Metadata}
 */
function sanitizeReactNativeIssueMetadata(metadata, compactMetadata, stackFrames) {
  /** @type {Record<string, unknown>} */
  const next = { ...metadata };
  for (const key of ["errorFrameFile", "releaseArtifactCodeFile"]) {
    next[key] = reactNativeCodePath(next[key]) ?? next[key];
  }
  const groupingKey = next["issueGroupingKey"];
  const groups = typeof groupingKey === "string" ? GROUPING_KEY_RE.exec(groupingKey)?.groups : undefined;
  const identity = groups ? reactNativeGroupingIdentity(reactNativeCodePath(groups["location"]), stackFrames) : undefined;
  if (groups && identity !== undefined && identity !== "") {
    next["issueGroupingKey"] = `${String(groups["kind"])}:${String(groups["scope"])}:${identity}`;
  }
  return compactMetadata(next);
}

/**
 * @param {readonly Readonly<IssueStackFrame>[] | undefined} stackFrames
 * @returns {IssueStackFrame[] | undefined}
 */
function sanitizeReactNativeIssueStackFrames(stackFrames) {
  if (!isFrameList(stackFrames)) {
    return undefined;
  }
  return stackFrames.map(frame => ({
    ...frame,
    filename: reactNativeCodePath(frame.filename) ?? frame.filename
  }));
}

/**
 * @param {IssueExceptionChain | undefined} exceptionChain
 * @returns {IssueExceptionChain | undefined}
 */
function sanitizeReactNativeIssueExceptionChain(exceptionChain) {
  if (!exceptionChain || !Array.isArray(exceptionChain.entries)) {
    return undefined;
  }
  return {
    ...exceptionChain,
    entries: exceptionChain.entries.map(entry => {
      const stackFrames = sanitizeReactNativeIssueStackFrames(entry.stackFrames);
      /** @type {IssueExceptionChainEntry} */
      const sanitized = {
        ...entry,
        ...(stackFrames ? { stackFrames } : {})
      };
      return sanitized;
    })
  };
}

/**
 * @param {string} rawLine
 * @returns {string}
 */
function stackFrameLocation(rawLine) {
  const location = rawLine.trim();
  if (location.startsWith("at ")) {
    const inner = location.slice(AT_PREFIX_LENGTH).trim();
    return inner.endsWith(")") && inner.includes("(") ? inner.slice(inner.lastIndexOf("(") + STEP, NOT_FOUND) : inner;
  }
  return location.includes("@") ? location.slice(location.lastIndexOf("@") + STEP) : location;
}

/**
 * @param {string} location
 * @returns {string | undefined}
 */
function locationFilename(location) {
  const parts = location.replace(/^address at /u, "").split(":");
  if (parts.length < MIN_LOCATION_PARTS) {
    return undefined;
  }
  const columnText = parts.pop() ?? "";
  const lineText = parts.pop() ?? "";
  const filename = parts.join(":").trim();
  if (!POSITIVE_INTEGER_RE.test(lineText) || !POSITIVE_INTEGER_RE.test(columnText)) {
    return undefined;
  }
  return Number.isSafeInteger(Number(lineText)) && Number.isSafeInteger(Number(columnText)) && filename ? filename : undefined;
}

/**
 * @param {unknown} rawLine
 * @returns {string | undefined}
 */
function runtimeStackFrameFilename(rawLine) {
  const trimmed = typeof rawLine === "string" ? rawLine.trim() : "";
  return trimmed ? locationFilename(stackFrameLocation(trimmed)) : undefined;
}

/**
 * @param {string} stack
 * @returns {string[]}
 */
function stackFilenames(stack) {
  /** @type {string[]} */
  const filenames = [];
  for (const line of stack.split(/\r?\n/u)) {
    const filename = runtimeStackFrameFilename(line);
    if (filename !== undefined) {
      filenames.push(filename);
    }
  }
  return filenames;
}

/**
 * @param {unknown} debugId
 * @returns {debugId is string}
 */
function isSafeDebugId(debugId) {
  return typeof debugId === "string" && SAFE_RELEASE_ARTIFACT_DEBUG_ID.test(debugId);
}

/**
 * @param {string} stack
 * @param {unknown} debugId
 * @returns {{ debugId: string, filenames: string[] } | undefined}
 */
function stackDebugIds(stack, debugId) {
  if (!isSafeDebugId(debugId)) {
    return undefined;
  }
  const filenames = stackFilenames(stack);
  return filenames.length === NO_ITEMS ? undefined : { debugId: debugId.toLowerCase(), filenames };
}

/**
 * @param {readonly (readonly [string, string])[]} debugIds
 * @returns {Record<string, string>}
 */
function nullPrototypeRecord(debugIds) {
  /** @type {Record<string, string>} */
  const record = {};
  Object.setPrototypeOf(record, NULL_VALUE);
  for (const [filename, debugId] of debugIds) {
    record[filename] = debugId;
  }
  return record;
}

/**
 * @param {readonly (readonly [string, unknown])[]} entries
 * @returns {Record<string, string> | undefined}
 */
function debugIdMapFromEntries(entries) {
  /** @type {Map<string, string>} */
  const debugIds = new Map();
  let frameCount = NO_ITEMS;
  for (const [stack, debugId] of entries) {
    const stackIds = stackDebugIds(stack, debugId);
    frameCount += stackIds?.filenames.length ?? NO_ITEMS;
    if (stackIds === undefined || frameCount > MAX_REACT_NATIVE_DEBUG_ID_REGISTRY_FRAMES
      || stackIds.filenames.some(filename => (debugIds.get(filename) ?? stackIds.debugId) !== stackIds.debugId)) {
      return undefined;
    }
    for (const filename of stackIds.filenames) {
      debugIds.set(filename, stackIds.debugId);
    }
  }
  return frameCount > NO_ITEMS ? nullPrototypeRecord([...debugIds]) : undefined;
}

/**
 * @returns {Record<string, string> | undefined}
 */
function runtimeReactNativeDebugIdMap() {
  try {
    /** @type {unknown} */
    const registry = Reflect.get(globalThis, REACT_NATIVE_DEBUG_ID_REGISTRY);
    if (!isRecord(registry) || Array.isArray(registry)) {
      return undefined;
    }
    const entries = Object.entries(registry);
    if (entries.length === NO_ITEMS || entries.length > MAX_REACT_NATIVE_DEBUG_ID_REGISTRY_ENTRIES) {
      return undefined;
    }
    return debugIdMapFromEntries(entries);
  } catch {
    return undefined;
  }
}

module.exports = {
  createSafeReactNativeMetadata,
  runtimeReactNativeDebugIdMap,
  safeReactNativeMetadataFactoryResult,
  sanitizeReactNativeIssueExceptionChain,
  sanitizeReactNativeIssueMetadata,
  sanitizeReactNativeIssueStackFrames
};
