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

function isSensitiveMetadataKey(key) {
  return SENSITIVE_METADATA_FACTORY_KEY_RE.test(String(key).toLowerCase());
}

module.exports = {
  createSafeReactNativeMetadata,
  safeReactNativeMetadataFactoryResult
};
