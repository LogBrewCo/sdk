import { isRecord, readField } from "./values.js";

/**
 * @import { TelemetryContext, TelemetryNamedVersion, TelemetryResource } from "@logbrew/sdk"
 */

const MAX_CONTEXT_STRING_LENGTH = 256;
const CONTEXT_SECTIONS = new Set(["resource", "trace", "session", "subject", "tags"]);
const CONTEXT_SCHEMA_VERSION = 1;
const EMPTY = 0;
const FIRST = 0;
const LAST_CONTROL_CODE = 31;
const FIRST_DELETE_CODE = 127;
const LAST_C1_CONTROL_CODE = 159;

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function safeProperty(value, key) {
  try {
    return isRecord(value) ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} character
 * @returns {boolean}
 */
function isControlCharacter(character) {
  const code = character.codePointAt(FIRST);
  return code !== undefined && (code <= LAST_CONTROL_CODE || (code >= FIRST_DELETE_CODE && code <= LAST_C1_CONTROL_CODE));
}

/**
 * @param {() => unknown} probe
 * @returns {string | undefined}
 */
function boundedProbe(probe) {
  try {
    const value = probe();
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    if (!normalized || Array.from(normalized).length > MAX_CONTEXT_STRING_LENGTH) {
      return undefined;
    }
    return Array.from(normalized).some((character) => isControlCharacter(character)) ? undefined : normalized;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isGreaseBrand(value) {
  const normalizedBrandKey = value.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  return normalizedBrandKey.startsWith("not") && normalizedBrandKey.endsWith("brand");
}

/**
 * @param {unknown} entry
 * @returns {TelemetryNamedVersion | undefined}
 */
function brandCandidate(entry) {
  if (!isRecord(entry)) {
    return undefined;
  }
  const name = boundedProbe(() => safeProperty(entry, "brand"));
  if (name === undefined || isGreaseBrand(name)) {
    return undefined;
  }
  const version = boundedProbe(() => safeProperty(entry, "version"));
  return version === undefined ? { name } : { name, version };
}

/**
 * @param {unknown} userAgentData
 * @returns {TelemetryNamedVersion | undefined}
 */
function selectBrowserBrand(userAgentData) {
  const brands = safeProperty(userAgentData, "brands");
  if (!Array.isArray(brands)) {
    return undefined;
  }
  /** @type {TelemetryNamedVersion[]} */
  const candidates = [];
  for (const entry of brands) {
    const candidate = brandCandidate(entry);
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }
  return candidates.find(({ name }) => name.toLowerCase() !== "chromium") ?? candidates[FIRST];
}

/**
 * @param {unknown} browserNavigator
 * @returns {TelemetryResource}
 */
function createBrowserRuntimeResource(browserNavigator) {
  const userAgentData = safeProperty(browserNavigator, "userAgentData");
  /** @type {TelemetryResource} */
  const resource = { runtime: selectBrowserBrand(userAgentData) ?? { name: "browser" } };
  const platform = boundedProbe(() => safeProperty(userAgentData, "platform"));
  if (platform !== undefined) {
    resource.operatingSystem = { name: platform };
  }
  const mobile = safeProperty(userAgentData, "mobile");
  if (typeof mobile === "boolean") {
    resource.device = { family: mobile ? "mobile" : "desktop" };
  }
  return resource;
}

/**
 * @returns {unknown}
 */
function defaultNavigator() {
  try {
    return readField(globalThis, "navigator");
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isEmptyRecord(value) {
  return isRecord(value) && Object.keys(value).length === EMPTY;
}

/**
 * @param {TelemetryContext} context
 * @returns {boolean}
 */
function acceptsRuntimeContext(context) {
  return isRecord(context)
    && readField(context, "schemaVersion") === CONTEXT_SCHEMA_VERSION
    && Object.keys(context).some((key) => CONTEXT_SECTIONS.has(key));
}

/**
 * @param {TelemetryContext} context
 * @param {TelemetryResource} defaultResource
 * @returns {TelemetryContext}
 */
function mergeRuntimeResource(context, defaultResource) {
  const contextResource = readField(context, "resource");
  if (!isRecord(contextResource) || isEmptyRecord(contextResource) || isEmptyRecord(contextResource["device"])) {
    return context;
  }
  /** @type {TelemetryResource} */
  const resource = { ...defaultResource, ...contextResource };
  if (isRecord(contextResource["device"])) {
    resource.device = { ...defaultResource.device, ...contextResource["device"] };
  }
  return { ...context, resource };
}

/**
 * @param {TelemetryContext | undefined} context
 * @param {unknown} [browserNavigator]
 * @param {TelemetryResource} [scopeResource]
 * @returns {TelemetryContext | undefined}
 */
function addBrowserRuntimeContext(context, browserNavigator = defaultNavigator(), scopeResource = {}) {
  /** @type {TelemetryResource} */
  const defaultResource = { ...(browserNavigator === false ? {} : createBrowserRuntimeResource(browserNavigator)), ...scopeResource };
  const hasDefaults = Object.keys(defaultResource).length !== EMPTY;
  if (context === undefined) {
    return hasDefaults
      ? {
        schemaVersion: CONTEXT_SCHEMA_VERSION,

        resource: defaultResource
      }
      : undefined;
  }
  if (!acceptsRuntimeContext(context)) {
    return context;
  }
  if (readField(context, "resource") === undefined) {
    return hasDefaults ? { ...context, resource: defaultResource } : context;
  }
  return mergeRuntimeResource(context, defaultResource);
}

export { addBrowserRuntimeContext };
