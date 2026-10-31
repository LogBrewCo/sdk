"use strict";

const { SdkError } = require("@logbrew/sdk");
const { readMember } = require("./internal.cjs");

/**
 * @typedef {Readonly<{ routeTemplate?: unknown, routeTemplateFactory?: unknown }>} RouteTemplateOptions
 */

const NO_MATCHERS = 0;
const FIRST_INDEX = 0;
const QUERY_OR_FRAGMENT = /[?#]/u;
const SINGLE_PART = 1;
const ABSOLUTE_HTTP_URL = /^https?:\/\//iu;
const LOCAL_ORIGIN = "http://localhost";

/**
 * @param {unknown} value
 * @returns {readonly unknown[]}
 */
function fetchTargetMatcherValues(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    /** @type {readonly unknown[]} */
    const values = value;
    return values;
  }
  return [value];
}

/**
 * @param {unknown} matcher
 * @returns {unknown}
 */
function normalizeFetchTargetMatcher(matcher) {
  if (typeof matcher === "string") {
    const trimmed = matcher.trim();
    if (trimmed === "") {
      throw new SdkError("configuration_error", "tracePropagationTargets must not contain empty strings");
    }
    return trimmed;
  }
  if (matcher instanceof RegExp || typeof matcher === "function") {
    return matcher;
  }
  throw new SdkError("configuration_error", "tracePropagationTargets entries must be strings, RegExp values, or functions");
}

/**
 * @param {unknown} value
 * @returns {readonly unknown[]}
 */
function normalizeFetchTargetMatchers(value) {
  return fetchTargetMatcherValues(value)
    .filter((matcher) => matcher !== undefined && matcher !== null)
    .map((matcher) => normalizeFetchTargetMatcher(matcher));
}

/**
 * @param {string} rawValue
 * @returns {URL | undefined}
 */
function parseLocalUrl(rawValue) {
  try {
    return new URL(rawValue, LOCAL_ORIGIN);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {readonly string[]}
 */
function fetchTargetCandidates(value) {
  const rawValue = typeof value === "string" ? value : String(value);
  const [withoutQuery = ""] = rawValue.split(QUERY_OR_FRAGMENT, SINGLE_PART);
  const candidates = new Set([withoutQuery]);
  const parsed = parseLocalUrl(rawValue);
  if (parsed) {
    candidates.add(parsed.pathname || "/");
    if (ABSOLUTE_HTTP_URL.test(rawValue)) {
      candidates.add(`${parsed.origin}${parsed.pathname || "/"}`);
    }
  }
  return [...candidates];
}

/**
 * @param {RegExp} matcher
 * @param {string} candidate
 * @returns {boolean}
 */
function testPattern(matcher, candidate) {
  matcher.lastIndex = FIRST_INDEX;
  const matched = matcher.test(candidate);
  matcher.lastIndex = FIRST_INDEX;
  return matched;
}

/**
 * @param {unknown} context
 * @param {readonly unknown[]} matchers
 * @returns {boolean}
 */
function matchesFetchTarget(context, matchers) {
  if (matchers.length === NO_MATCHERS) {
    return false;
  }
  const candidates = fetchTargetCandidates(readMember(context, "url"));
  return matchers.some((matcher) => {
    if (typeof matcher === "string") {
      return candidates.some((candidate) => candidate.startsWith(matcher));
    }
    if (matcher instanceof RegExp) {
      return candidates.some((candidate) => testPattern(matcher, candidate));
    }
    if (typeof matcher !== "function") {
      throw new TypeError("matcher is not a function");
    }
    return Reflect.apply(matcher, undefined, [context]) === true;
  });
}

/**
 * @param {RouteTemplateOptions} options
 * @param {Readonly<Record<string, unknown> & { path: string }>} context
 * @returns {string}
 */
function resolveRouteTemplate(options, context) {
  if (typeof options.routeTemplate === "string" && options.routeTemplate.trim() !== "") {
    return options.routeTemplate;
  }
  if (typeof options.routeTemplateFactory === "function") {
    /** @type {unknown} */
    const value = Reflect.apply(options.routeTemplateFactory, options, [context]);
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return context.path;
}

module.exports = {
  fetchTargetMatcherValues,
  matchesFetchTarget,
  normalizeFetchTargetMatchers,
  resolveRouteTemplate
};
