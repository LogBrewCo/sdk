"use strict";

const { arch, release, type } = require("node:os");

const MAX_CONTEXT_STRING_LENGTH = 256;
const CONTEXT_SECTIONS = new Set(["resource", "trace", "session", "subject", "tags"]);
const DEFAULT_NODE_RUNTIME_CONTEXT = createNodeRuntimeContext();

function addNodeRuntimeContext(context) {
  if (context === undefined) {
    return DEFAULT_NODE_RUNTIME_CONTEXT;
  }
  if (!isRecord(context)
    || context.schemaVersion !== 1
    || !Object.keys(context).some((key) => CONTEXT_SECTIONS.has(key))) {
    return context;
  }
  if (context.resource === undefined) {
    return { ...context, resource: DEFAULT_NODE_RUNTIME_CONTEXT.resource };
  }
  if (!isRecord(context.resource) || Object.keys(context.resource).length === 0) {
    return context;
  }
  if (isRecord(context.resource.device) && Object.keys(context.resource.device).length === 0) {
    return context;
  }

  const resource = { ...DEFAULT_NODE_RUNTIME_CONTEXT.resource, ...context.resource };
  if (isRecord(context.resource.device)) {
    resource.device = {
      ...DEFAULT_NODE_RUNTIME_CONTEXT.resource.device,
      ...context.resource.device
    };
  }
  return { ...context, resource };
}

function createNodeRuntimeContext() {
  const runtime = { name: "node" };
  const runtimeVersion = boundedProbe(() => process.versions.node);
  if (runtimeVersion !== undefined) {
    runtime.version = runtimeVersion;
  }

  const resource = { runtime };
  const operatingSystemName = boundedProbe(type);
  if (operatingSystemName !== undefined) {
    const operatingSystem = { name: operatingSystemName };
    const operatingSystemVersion = boundedProbe(release);
    if (operatingSystemVersion !== undefined) {
      operatingSystem.version = operatingSystemVersion;
    }
    resource.operatingSystem = operatingSystem;
  }

  const architecture = boundedProbe(arch);
  if (architecture !== undefined) {
    resource.device = { architecture };
  }
  return { schemaVersion: 1, resource };
}

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
    return Array.from(normalized).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 31 || (code >= 127 && code <= 159));
    })
      ? undefined
      : normalized;
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

module.exports = { addNodeRuntimeContext };
