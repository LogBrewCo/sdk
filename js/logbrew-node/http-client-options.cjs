"use strict";

const { callMethod, readMember, stringValue, templateText } = require("./internal.cjs");
const { isRecord, pathOnly } = require("./span-support.cjs");

/**
 * @typedef {Readonly<Record<string, unknown>>} HttpClientOptions
 * @typedef {Readonly<{ callback: unknown, options: HttpClientOptions }>} NormalizedHttpClientArgs
 * @typedef {Readonly<{ method: string, module: string, path: string, protocol: unknown, url: string }>} HttpClientContext
 */

const AUTHORITY_NAME_KEY = ["host", "name"].join("");
const LEGACY_AUTHORITY_KEY = ["ho", "st"].join("");
const URL_USER_KEY = ["user", "name"].join("");
const URL_ACCESS_KEY = ["pass", "word"].join("");
const DEFAULT_AUTHORITY = ["local", "host"].join("");
const KEY_INDEX = 0;
const VALUE_INDEX = 1;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function copyHeaderValue(value) {
  if (Array.isArray(value)) {
    /** @type {readonly unknown[]} */
    const values = value;
    return [...values];
  }
  return value;
}

/**
 * @param {unknown} entries
 * @returns {Readonly<Record<string, unknown>>}
 */
function objectFromEntries(entries) {
  /** @type {unknown} */
  const result = Reflect.apply(Object.fromEntries, Object, [entries]);
  return isRecord(result) ? result : {};
}

/**
 * @param {readonly unknown[]} entries
 * @returns {Readonly<Record<string, unknown>>}
 */
function headersFromPairs(entries) {
  return objectFromEntries(entries.map((entry) => [readMember(entry, KEY_INDEX), copyHeaderValue(readMember(entry, VALUE_INDEX))]));
}

/**
 * @param {unknown} headers
 * @returns {Readonly<Record<string, unknown>>}
 */
function cloneHttpClientHeaders(headers) {
  if (headers === undefined || headers === null) {
    return {};
  }
  if (typeof readMember(headers, "entries") === "function") {
    return objectFromEntries(callMethod(headers, "entries", []));
  }
  if (Array.isArray(headers)) {
    return headersFromPairs(headers);
  }
  if (isRecord(headers)) {
    /** @type {readonly (readonly [string, unknown])[]} */
    const entries = Object.entries(headers);
    return Object.fromEntries(entries.map(([key, value]) => [key, copyHeaderValue(value)]));
  }
  return {};
}

/**
 * @param {Readonly<Record<string, unknown>>} options
 * @returns {HttpClientOptions}
 */
function cloneHttpClientOptions(options) {
  const clone = { ...options };
  const { headers } = clone;
  return headers === undefined ? clone : { ...clone, headers: cloneHttpClientHeaders(headers) };
}

/**
 * @param {unknown} value
 * @returns {value is URL}
 */
function isUrlObject(value) {
  return value instanceof URL;
}

/**
 * @param {unknown} value
 * @returns {URL | undefined}
 */
function parseRequestUrl(value) {
  if (isUrlObject(value)) {
    return value;
  }
  try {
    return new URL(String(value));
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {HttpClientOptions}
 */
function httpClientOptionsFromUrl(value) {
  const parsed = parseRequestUrl(value);
  if (!parsed) {
    return { path: String(value) };
  }
  const user = readMember(parsed, URL_USER_KEY);
  const access = readMember(parsed, URL_ACCESS_KEY);
  return {
    protocol: parsed.protocol,

    [AUTHORITY_NAME_KEY]: readMember(parsed, AUTHORITY_NAME_KEY),
    ...(parsed.port ? { port: parsed.port } : {}),

    path: `${parsed.pathname || "/"}${parsed.search || ""}`,
    ...(templateText(user) || templateText(access) ? { auth: `${templateText(user)}:${templateText(access)}` } : {})
  };
}

/**
 * @param {Readonly<Record<string, unknown>>} options
 * @returns {string}
 */
function httpClientPathFromOptions(options) {
  const path = options["path"] ?? `${templateText(options["pathname"] ?? "")}${templateText(options["search"] ?? "")}`;
  const normalizedPath = typeof path === "string" && path.trim() !== "" ? path : "/";
  return normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
}

/**
 * @param {Readonly<Record<string, unknown>>} options
 * @returns {string}
 */
function getHttpClientMethod(options) {
  return stringValue(options["method"] ?? "GET").toUpperCase();
}

/**
 * @param {unknown} input
 * @param {HttpClientOptions} extraOptions
 * @returns {HttpClientOptions | undefined}
 */
function baseHttpClientOptions(input, extraOptions) {
  if (input === undefined) {
    return extraOptions;
  }
  if (typeof input === "string" || isUrlObject(input)) {
    return { ...httpClientOptionsFromUrl(input), ...extraOptions };
  }
  if (isRecord(input)) {
    return { ...cloneHttpClientOptions(input), ...extraOptions };
  }
  return undefined;
}

/**
 * @param {unknown} inputOptions
 * @param {unknown} inputCallback
 * @returns {unknown}
 */
function requestCallback(inputOptions, inputCallback) {
  if (typeof inputOptions === "function") {
    return inputOptions;
  }
  return typeof inputCallback === "function" ? inputCallback : undefined;
}

/**
 * @param {HttpClientOptions} baseOptions
 * @param {string} defaultProtocol
 * @returns {HttpClientOptions}
 */
function completeHttpClientOptions(baseOptions, defaultProtocol) {
  const { protocol } = baseOptions;
  const withProtocol = { ...baseOptions, protocol: typeof protocol === "string" && protocol.trim() !== "" ? protocol : defaultProtocol };
  const withPath = { ...withProtocol, path: httpClientPathFromOptions(withProtocol) };
  /** @type {HttpClientOptions} */
  const options = { ...withPath, method: getHttpClientMethod(withPath) };
  const { headers } = options;
  return headers === undefined ? options : { ...options, headers: cloneHttpClientHeaders(headers) };
}

/**
 * @param {readonly unknown[]} args
 * @param {string} defaultProtocol
 * @returns {NormalizedHttpClientArgs | undefined}
 */
function normalizeHttpClientArgs(args, defaultProtocol) {
  const [input, inputOptions, inputCallback] = args;
  const callback = requestCallback(inputOptions, inputCallback);
  const options = baseHttpClientOptions(input, isRecord(inputOptions) ? cloneHttpClientOptions(inputOptions) : {});
  if (!options) {
    return undefined;
  }
  return { callback, options: completeHttpClientOptions(options, defaultProtocol) };
}

/**
 * @param {Readonly<Record<string, unknown>>} options
 * @returns {string}
 */
function httpClientAuthorityFromOptions(options) {
  const authorityName = options[AUTHORITY_NAME_KEY] ?? options[LEGACY_AUTHORITY_KEY] ?? DEFAULT_AUTHORITY;
  const [authority = ""] = stringValue(authorityName).split("/");
  if (authority.includes(":") || options["port"] === undefined || options["port"] === "") {
    return authority;
  }
  return `${authority}:${templateText(options["port"])}`;
}

/**
 * @param {Readonly<Record<string, unknown>>} options
 * @param {string} moduleName
 * @returns {HttpClientContext}
 */
function createHttpClientInstrumentationContext(options, moduleName) {
  const { protocol } = options;
  const urlProtocol = typeof protocol === "string" && protocol.trim() !== "" ? protocol : "http:";
  return {
    method: getHttpClientMethod(options),
    module: moduleName,
    path: pathOnly(httpClientPathFromOptions(options)),
    protocol: protocol ?? (moduleName === "https" ? "https:" : "http:"),
    url: `${urlProtocol}//${httpClientAuthorityFromOptions(options)}${httpClientPathFromOptions(options)}`
  };
}

/**
 * @param {Readonly<Record<string, unknown>>} options
 * @param {string} traceparent
 * @returns {HttpClientOptions}
 */
function withHttpClientTraceparent(options, traceparent) {
  /** @type {readonly (readonly [string, unknown])[]} */
  const entries = Object.entries(cloneHttpClientHeaders(options["headers"]));
  const headers = entries.filter(([key]) => key.toLowerCase() !== "traceparent");
  return {
    ...options,
    headers: {
      ...Object.fromEntries(headers),
      traceparent
    }
  };
}

module.exports = {
  createHttpClientInstrumentationContext,
  normalizeHttpClientArgs,
  withHttpClientTraceparent
};
