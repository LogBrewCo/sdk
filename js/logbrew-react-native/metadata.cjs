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

function isSensitiveMetadataKey(key) {
  return SENSITIVE_METADATA_FACTORY_KEY_RE.test(String(key).toLowerCase());
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
  safeReactNativeMetadataFactoryResult,
  sanitizeReactNativeIssueMetadata
};
