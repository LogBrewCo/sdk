"use strict";

const { arch, release, type } = require("node:os");

/**
 * @import { TelemetryContext, TelemetryNamedVersion, TelemetryResource } from "@logbrew/sdk"
 */

/**
 * @typedef {Readonly<Record<string, string | undefined>>} EnvironmentVariables
 * @typedef {Readonly<Record<string, unknown>>} UnknownRecord
 * @typedef {{ readonly resource: TelemetryResource, readonly schemaVersion: 1 }} NodeRuntimeContext
 */

const SCHEMA_VERSION = 1;
const MAX_CONTEXT_STRING_LENGTH = 256;
const LAST_C0_CONTROL = 31;
const FIRST_C1_CONTROL = 127;
const LAST_C1_CONTROL = 159;
const EMPTY = 0;
const CONTEXT_SECTIONS = new Set(["resource", "trace", "session", "subject", "tags"]);
const ENVIRONMENT_RESOURCE_FIELDS = [
  ["LOGBREW_SERVICE_NAME", "service", "name"],
  ["LOGBREW_ENVIRONMENT", "deployment", "environment"],
  ["LOGBREW_RELEASE", "deployment", "release"]
];

/**
 * @param {unknown} value
 * @returns {value is UnknownRecord}
 */
function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

/**
 * @param {string} character
 * @returns {boolean}
 */
function isControlCharacter(character) {
  const code = character.codePointAt(EMPTY);
  return code !== undefined && (code <= LAST_C0_CONTROL || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL));
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
    if (!normalized || [...normalized].length > MAX_CONTEXT_STRING_LENGTH) {
      return undefined;
    }
    return [...normalized].some((character) => isControlCharacter(character)) ? undefined : normalized;
  } catch {
    return undefined;
  }
}

/**
 * @param {EnvironmentVariables} env
 * @returns {Record<string, Record<string, string>>}
 */
function environmentResource(env) {
  /** @type {Record<string, Record<string, string>>} */
  const resource = {};
  for (const [variable = "", section = "", field = ""] of ENVIRONMENT_RESOURCE_FIELDS) {
    const value = boundedProbe(() => env[variable]);
    if (value !== undefined) {
      resource[section] = { ...resource[section], [field]: value };
    }
  }
  return resource;
}

/**
 * @param {UnknownRecord} explicitResource
 * @param {Readonly<Record<string, Readonly<Record<string, string>>>>} resource
 * @returns {Record<string, unknown>}
 */
function mergeEnvironmentResource(explicitResource, resource) {
  /** @type {Record<string, unknown>} */
  const merged = { ...explicitResource };
  for (const [section, fields] of Object.entries(resource)) {
    const explicit = explicitResource[section];
    if (explicit === undefined) {
      merged[section] = fields;
    } else if (isRecord(explicit)) {
      merged[section] = { ...fields, ...explicit };
    }
  }
  return merged;
}

/**
 * @template Context
 * @param {Context} context
 * @param {Readonly<Record<string, Readonly<Record<string, string>>>>} resource
 * @returns {Context | TelemetryContext}
 */
function withEnvironmentResource(context, resource) {
  if (context === undefined) {
    return {
      schemaVersion: SCHEMA_VERSION,

      resource
    };
  }
  if (!isRecord(context) || context["schemaVersion"] !== SCHEMA_VERSION) {
    return context;
  }
  const explicitResource = context["resource"];
  if (explicitResource === undefined) {
    return { ...context, resource };
  }
  if (!isRecord(explicitResource) || Object.keys(explicitResource).length === EMPTY) {
    return context;
  }
  return { ...context, resource: mergeEnvironmentResource(explicitResource, resource) };
}

/**
 * @template Context
 * @param {Context} context
 * @param {EnvironmentVariables} [env]
 * @returns {Context | TelemetryContext}
 */
function addEnvironmentResourceContext(context, env = process.env) {
  const resource = environmentResource(env);
  if (Object.keys(resource).length === EMPTY) {
    return context;
  }
  return withEnvironmentResource(context, resource);
}

/**
 * @returns {TelemetryNamedVersion}
 */
function runtimeIdentity() {
  /** @type {TelemetryNamedVersion} */
  const runtime = { name: "node" };
  const runtimeVersion = boundedProbe(() => process.versions.node);
  if (runtimeVersion !== undefined) {
    runtime.version = runtimeVersion;
  }
  return runtime;
}

/**
 * @returns {TelemetryNamedVersion | undefined}
 */
function operatingSystemIdentity() {
  const operatingSystemName = boundedProbe(type);
  if (operatingSystemName === undefined) {
    return undefined;
  }
  /** @type {TelemetryNamedVersion} */
  const operatingSystem = { name: operatingSystemName };
  const operatingSystemVersion = boundedProbe(release);
  if (operatingSystemVersion !== undefined) {
    operatingSystem.version = operatingSystemVersion;
  }
  return operatingSystem;
}

/**
 * @returns {NodeRuntimeContext}
 */
function createNodeRuntimeContext() {
  /** @type {TelemetryResource} */
  const resource = { runtime: runtimeIdentity() };
  const operatingSystem = operatingSystemIdentity();
  if (operatingSystem) {
    resource.operatingSystem = operatingSystem;
  }
  const architecture = boundedProbe(arch);
  if (architecture !== undefined) {
    resource.device = { architecture };
  }
  return {
    schemaVersion: SCHEMA_VERSION,

    resource
  };
}

const DEFAULT_NODE_RUNTIME_CONTEXT = createNodeRuntimeContext();

/**
 * @param {UnknownRecord} context
 * @returns {boolean}
 */
function hasContextSection(context) {
  return Object.keys(context).some((key) => CONTEXT_SECTIONS.has(key));
}

/**
 * @param {UnknownRecord} explicitResource
 * @returns {Record<string, unknown>}
 */
function mergeRuntimeResource(explicitResource) {
  /** @type {Record<string, unknown>} */
  const resource = { ...DEFAULT_NODE_RUNTIME_CONTEXT.resource, ...explicitResource };
  const explicitDevice = explicitResource["device"];
  if (isRecord(explicitDevice)) {
    resource["device"] = {
      ...DEFAULT_NODE_RUNTIME_CONTEXT.resource.device,
      ...explicitDevice
    };
  }
  return resource;
}

/**
 * @param {UnknownRecord} context
 * @returns {UnknownRecord}
 */
function withRuntimeResource(context) {
  const explicitResource = context["resource"];
  if (explicitResource === undefined) {
    return { ...context, resource: DEFAULT_NODE_RUNTIME_CONTEXT.resource };
  }
  if (!isRecord(explicitResource) || Object.keys(explicitResource).length === EMPTY) {
    return context;
  }
  const explicitDevice = explicitResource["device"];
  if (isRecord(explicitDevice) && Object.keys(explicitDevice).length === EMPTY) {
    return context;
  }
  return { ...context, resource: mergeRuntimeResource(explicitResource) };
}

/**
 * @template Context
 * @param {Context} context
 * @returns {Context | NodeRuntimeContext | UnknownRecord}
 */
function addNodeRuntimeContext(context) {
  if (context === undefined) {
    return DEFAULT_NODE_RUNTIME_CONTEXT;
  }
  if (!isRecord(context) || context["schemaVersion"] !== SCHEMA_VERSION || !hasContextSection(context)) {
    return context;
  }
  return withRuntimeResource(context);
}

module.exports = { addEnvironmentResourceContext, addNodeRuntimeContext };
