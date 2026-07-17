"use strict";

const SENSITIVE_METADATA_FACTORY_KEY_RE = new RegExp([
  "body",
  "payload",
  "variable",
  "header",
  "authorization",
  "cookie",
  "to\u006ben",
  "sec\u0072et",
  "pass\u0077ord"
].join("|"), "u");
const REACT_NATIVE_DEBUG_ID_REGISTRY = Symbol.for("@logbrew/react-native/debug-ids");
const SAFE_RELEASE_ARTIFACT_DEBUG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_REACT_NATIVE_DEBUG_ID_REGISTRY_ENTRIES = 64;
const MAX_REACT_NATIVE_DEBUG_ID_REGISTRY_FRAMES = 128;

function createSafeReactNativeMetadata(metadata, metadataFactory, context) {
  if (typeof metadataFactory !== "function") {
    return metadata;
  }
  return {
    ...metadata,
    ...safeReactNativeMetadataFactoryResult(metadataFactory(context))
  };
}

function safeReactNativeMetadataFactoryResult(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {};
  }
  const metadata = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (isSensitiveMetadataKey(key)) {
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      metadata[key] = value;
    }
  }
  return metadata;
}

function sanitizeReactNativeIssueMetadata(metadata, compactMetadata) {
  const next = { ...metadata };
  for (const key of ["errorFrameFile", "releaseArtifactCodeFile"]) {
    const path = reactNativeCodePath(next[key]);
    if (path) {
      next[key] = path;
    }
  }
  const match = typeof next.issueGroupingKey === "string" ? next.issueGroupingKey.match(/^([^:]+):([^:]+):(.+)$/u) : null;
  const path = match ? reactNativeCodePath(match[3]) : undefined;
  if (path) {
    next.issueGroupingKey = `${match[1]}:${match[2]}:${path}`;
  }
  return compactMetadata(next);
}

function runtimeReactNativeDebugIdMap() {
  try {
    const registry = globalThis?.[REACT_NATIVE_DEBUG_ID_REGISTRY];
    if (!registry || Array.isArray(registry) || typeof registry !== "object") {
      return undefined;
    }
    const entries = Object.entries(registry);
    if (entries.length === 0 || entries.length > MAX_REACT_NATIVE_DEBUG_ID_REGISTRY_ENTRIES) {
      return undefined;
    }
    const debugIdMap = Object.create(null);
    let frameCount = 0;
    for (const [stack, debugId] of entries) {
      if (typeof debugId !== "string" || !SAFE_RELEASE_ARTIFACT_DEBUG_ID.test(debugId)) {
        return undefined;
      }
      const normalizedDebugId = debugId.toLowerCase();
      let stackFrameCount = 0;
      for (const line of stack.split(/\r?\n/u)) {
        const filename = runtimeStackFrameFilename(line);
        if (!filename) {
          continue;
        }
        frameCount += 1;
        stackFrameCount += 1;
        if (frameCount > MAX_REACT_NATIVE_DEBUG_ID_REGISTRY_FRAMES) {
          return undefined;
        }
        const existingDebugId = debugIdMap[filename];
        if (existingDebugId && existingDebugId !== normalizedDebugId) {
          return undefined;
        }
        debugIdMap[filename] = normalizedDebugId;
      }
      if (stackFrameCount === 0) {
        return undefined;
      }
    }
    return frameCount > 0 ? debugIdMap : undefined;
  } catch {
    return undefined;
  }
}

function isSensitiveMetadataKey(key) {
  return SENSITIVE_METADATA_FACTORY_KEY_RE.test(String(key).toLowerCase());
}

function runtimeStackFrameFilename(rawLine) {
  let location = typeof rawLine === "string" ? rawLine.trim() : "";
  if (!location) {
    return undefined;
  }
  if (location.startsWith("at ")) {
    location = location.slice(3).trim();
    if (location.endsWith(")") && location.includes("(")) {
      location = location.slice(location.lastIndexOf("(") + 1, -1);
    }
  } else if (location.includes("@")) {
    location = location.slice(location.lastIndexOf("@") + 1);
  }
  const parts = location.split(":");
  if (parts.length < 3) {
    return undefined;
  }
  const columnText = parts.pop();
  const lineText = parts.pop();
  const filename = parts.join(":").trim();
  if (!/^[1-9]\d*$/u.test(lineText) || !/^[1-9]\d*$/u.test(columnText)) {
    return undefined;
  }
  const line = Number(lineText);
  const column = Number(columnText);
  return Number.isSafeInteger(line) && Number.isSafeInteger(column) && filename ? filename : undefined;
}

function reactNativeCodePath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  let path = value.trim();
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function") {
    try {
      path = new URLConstructor(path).pathname || path;
    } catch {
      path = path.split(/[?#]/u, 1)[0].replace(/\\/g, "/");
    }
  } else {
    path = path.split(/[?#]/u, 1)[0].replace(/\\/g, "/");
  }
  if (/^[A-Za-z]:\//u.test(path) || /^\/(?:Users|home|private|tmp|var)\//u.test(path)) {
    path = path.replace(/\/+$/u, "");
    return path.slice(path.lastIndexOf("/") + 1) || undefined;
  }
  return path || undefined;
}

module.exports = {
  createSafeReactNativeMetadata,
  runtimeReactNativeDebugIdMap,
  safeReactNativeMetadataFactoryResult,
  sanitizeReactNativeIssueMetadata
};
