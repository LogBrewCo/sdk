"use strict";

const { SdkError } = require("@logbrew/sdk");
const { readField } = require("./values.cjs");

/**
 * @import { Metadata, TransportResponse } from "@logbrew/sdk"
 * @import { BrowserTraceContext, LogBrewBrowserContext, LogBrewBrowserOptions } from "./index.cjs"
 * @typedef {Pick<LogBrewBrowserOptions, "flushOnCapture" | "onCaptureError" | "onFlush" | "raiseCaptureErrors">} CaptureFlushOptions
 * @typedef {{
 *   readonly includeDocumentTitle: unknown,
 *   readonly includeUserAgent: unknown,
 *   readonly path: string,
 *   readonly source: string
 * }} BrowserMetadataOptions
 * @typedef {{ readonly includeHash?: unknown, readonly includeQueryString?: unknown }} BrowserPathOptions
 */

const PATH_BASE_URL = "https://logbrew.example";
const DURATION_DIGITS = 3;
const ZERO = 0;

/**
 * @param {unknown} value
 * @returns {value is Window}
 */
function isWindowValue(value) {
  return typeof value === "object";
}

/**
 * @returns {Window | undefined}
 */
function defaultWindow() {
  /** @type {unknown} */
  const browserWindow = readField(globalThis, "window");
  return isWindowValue(browserWindow) ? browserWindow : undefined;
}

/**
 * @param {unknown} context
 * @param {string} functionName
 * @returns {void}
 */
function assertBrowserContext(context, functionName) {
  const hasContext = Boolean(context);
  if (!hasContext || typeof context !== "object") {
    throw new SdkError("configuration_error", `${functionName} requires a browser context`);
  }
  const hasClient = Boolean(readField(context, "client"));
  if (!hasClient) {
    throw new SdkError("configuration_error", `${functionName} requires a browser context`);
  }
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {CaptureFlushOptions} options
 * @returns {Promise<TransportResponse | undefined>}
 */
async function flushCaptured(context, options) {
  try {
    const response = await context.client.flush(context.transport);
    if (typeof options.onFlush === "function") {
      await options.onFlush(response, context, { reason: "capture" });
    }
    return response;
  } catch (error) {
    if (typeof options.onCaptureError === "function") {
      await options.onCaptureError(error, context, { reason: "capture" });
    }
    if (options.raiseCaptureErrors === true) {
      throw error;
    }
    return undefined;
  }
}

/**
 * @param {LogBrewBrowserContext} context
 * @param {CaptureFlushOptions} options
 * @returns {Promise<TransportResponse | undefined>}
 */
async function flushAfterCapture(context, options) {
  if (options.flushOnCapture === false) {
    return undefined;
  }
  return flushCaptured(context, options);
}

/**
 * @param {Readonly<Record<string, unknown>>} metadata
 * @returns {Metadata}
 */
function compactMetadata(metadata) {
  /** @type {Metadata} */
  const compacted = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      compacted[key] = value;
    }
  }
  return compacted;
}

/**
 * @param {unknown} metadata
 * @returns {Metadata}
 */
function safeMetadata(metadata) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  return compactMetadata({ ...metadata });
}

/**
 * @param {Readonly<Metadata>} metadata
 * @returns {Metadata}
 */
function defaultSanitizeMetadata(metadata) {
  return safeMetadata(metadata);
}

/**
 * @param {Readonly<Metadata>} baseMetadata
 * @param {unknown} extraMetadata
 * @returns {Metadata}
 */
function mergeMetadata(baseMetadata, extraMetadata) {
  return compactMetadata({
    ...baseMetadata,
    ...safeMetadata(extraMetadata)
  });
}

/**
 * @param {Window | undefined} browserWindow
 * @param {BrowserMetadataOptions} options
 * @returns {Metadata}
 */
function browserMetadata(browserWindow, { includeDocumentTitle, includeUserAgent, path, source }) {
  const withTitle = Boolean(includeDocumentTitle);
  const withUserAgent = Boolean(includeUserAgent);
  return compactMetadata({
    documentTitle: withTitle ? readField(readField(browserWindow, "document"), "title") : undefined,
    path,
    source,
    userAgent: withUserAgent ? readField(readField(browserWindow, "navigator"), "userAgent") : undefined,
    visibilityState: readField(readField(browserWindow, "document"), "visibilityState")
  });
}

/**
 * @param {unknown} location
 * @returns {string | undefined}
 */
function locationHref(location) {
  const hasLocation = Boolean(location);
  if (!hasLocation) {
    return undefined;
  }
  const href = readField(location, "href");
  return typeof href === "string" ? href : String(location);
}

/**
 * @param {Window | undefined} browserWindow
 * @param {BrowserPathOptions} [options]
 * @returns {string}
 */
function browserPath(browserWindow, { includeHash = false, includeQueryString = false } = {}) {
  const withHash = Boolean(includeHash);
  const withQueryString = Boolean(includeQueryString);
  const href = locationHref(readField(browserWindow, "location"));
  if (href === undefined) {
    return "/";
  }
  try {
    const url = new URL(href, PATH_BASE_URL);
    return `${url.pathname || "/"}${withQueryString ? url.search : ""}${withHash ? url.hash : ""}`;
  } catch {
    return "/";
  }
}

/**
 * @param {unknown} routeTemplate
 * @returns {string}
 */
function routeTemplatePath(routeTemplate) {
  if (typeof routeTemplate !== "string" || routeTemplate.trim() === "") {
    return "/";
  }
  try {
    return new URL(routeTemplate, PATH_BASE_URL).pathname || "/";
  } catch {
    return "/";
  }
}

/**
 * @param {unknown} source
 * @returns {string | undefined}
 */
function sanitizeSourcePath(source) {
  if (typeof source !== "string" || source.trim() === "") {
    return undefined;
  }
  try {
    return new URL(source, PATH_BASE_URL).pathname || "/";
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function nonNegativeNumberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= ZERO ? value : undefined;
}

/**
 * @param {number} value
 * @returns {number}
 */
function roundDurationMs(value) {
  return Number(value.toFixed(DURATION_DIGITS));
}

/**
 * @param {number | undefined} value
 * @returns {number | undefined}
 */
function roundedNumber(value) {
  return value === undefined ? undefined : roundDurationMs(value);
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {number}
 */
function finiteNonNegativeNumber(label, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < ZERO) {
    throw new SdkError("configuration_error", `${label} must be a non-negative finite number`);
  }
  return value;
}

/**
 * @param {unknown} start
 * @param {unknown} end
 * @param {{ readonly requirePositiveStart?: boolean }} [options]
 * @returns {number | undefined}
 */
function durationBetween(start, end, { requirePositiveStart = false } = {}) {
  const startMs = nonNegativeNumberOrUndefined(start);
  const endMs = nonNegativeNumberOrUndefined(end);
  if (startMs === undefined || endMs === undefined || endMs < startMs) {
    return undefined;
  }
  if (requirePositiveStart && startMs <= ZERO) {
    return undefined;
  }
  return roundDurationMs(endMs - startMs);
}

/**
 * @template {object} Options
 * @param {Options} options
 * @param {BrowserTraceContext | undefined} traceContext
 * @returns {Options & { readonly traceContext: BrowserTraceContext | undefined }}
 */
function optionsWithTraceContext(options, traceContext) {
  return {
    ...options,
    traceContext
  };
}

module.exports = {
  assertBrowserContext,
  browserMetadata,
  browserPath,
  compactMetadata,
  defaultSanitizeMetadata,
  defaultWindow,
  durationBetween,
  finiteNonNegativeNumber,
  flushAfterCapture,
  mergeMetadata,
  nonNegativeNumberOrUndefined,
  numberOrUndefined,
  optionsWithTraceContext,
  roundDurationMs,
  roundedNumber,
  routeTemplatePath,
  safeMetadata,
  sanitizeSourcePath
};
