const { isObjectLike, propertyOf } = require("./error-details.cjs");
const { MAX_ISSUE_BREADCRUMBS, validateIssueBreadcrumb } = require("./issue-diagnostics.cjs");

/**
 * @import { IssueBreadcrumb } from "./index.cjs"
 * @import { Callable, DeepReadonly } from "./validation.cjs"
 * @typedef {readonly DeepReadonly<IssueBreadcrumb>[]} Breadcrumbs
 * @typedef {Readonly<{ breadcrumbs: Breadcrumbs, truncated: boolean }>} BreadcrumbTrail
 */

const NO_BREADCRUMBS = 0;
/** @type {BreadcrumbTrail} */
const EMPTY_TRAIL = { breadcrumbs: [], truncated: false };

/**
 * @param {Callable | undefined} provider
 * @param {unknown} receiver
 * @returns {unknown}
 */
function callProvider(provider, receiver) {
  try {
    return provider === undefined ? undefined : Reflect.apply(provider, receiver, []);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} breadcrumb
 * @returns {IssueBreadcrumb | undefined}
 */
function validBreadcrumb(breadcrumb) {
  try {
    return validateIssueBreadcrumb(breadcrumb);
  } catch {
    return undefined;
  }
}

/**
 * @param {readonly unknown[]} entries
 * @returns {BreadcrumbTrail}
 */
function validBreadcrumbs(entries) {
  /** @type {IssueBreadcrumb[]} */
  const breadcrumbs = [];
  let truncated = false;
  for (const entry of entries.slice(-MAX_ISSUE_BREADCRUMBS)) {
    const breadcrumb = validBreadcrumb(entry);
    if (breadcrumb === undefined) {
      truncated = true;
    } else {
      breadcrumbs.push(breadcrumb);
    }
  }
  return { breadcrumbs, truncated };
}

/**
 * @param {Callable | undefined} provider
 * @param {unknown} receiver
 * @returns {BreadcrumbTrail}
 */
function providedBreadcrumbs(provider, receiver) {
  const provided = callProvider(provider, receiver);
  const list = isObjectLike(provided) ? propertyOf(provided, "breadcrumbs") : undefined;
  if (!Array.isArray(list)) {
    return EMPTY_TRAIL;
  }
  /** @type {readonly unknown[]} */
  const entries = list;
  const flagged = propertyOf(provided, "truncated") === true || entries.length > MAX_ISSUE_BREADCRUMBS;
  const validated = validBreadcrumbs(entries);
  return { breadcrumbs: validated.breadcrumbs, truncated: flagged || validated.truncated };
}

/**
 * @param {DeepReadonly<IssueBreadcrumb>} left
 * @param {DeepReadonly<IssueBreadcrumb>} right
 * @returns {number}
 */
function byTimestamp(left, right) {
  return Date.parse(left.timestamp) - Date.parse(right.timestamp);
}

/**
 * @param {Breadcrumbs} local
 * @param {Breadcrumbs} provided
 * @returns {Breadcrumbs}
 */
function mergedBreadcrumbs(local, provided) {
  if (provided.length === NO_BREADCRUMBS) {
    return local;
  }
  const merged = [...local, ...provided];
  merged.sort(byTimestamp);
  return merged;
}

/**
 * @param {Readonly<Record<string, unknown>>} attributes
 * @param {BreadcrumbTrail} local
 * @param {BreadcrumbTrail} provided
 * @returns {Readonly<Record<string, unknown>>}
 */
function withIssueBreadcrumbs(attributes, local, provided) {
  const merged = mergedBreadcrumbs(local.breadcrumbs, provided.breadcrumbs);
  const breadcrumbs = merged.slice(-MAX_ISSUE_BREADCRUMBS);
  const truncated = attributes["breadcrumbsTruncated"] === true || local.truncated
    || provided.truncated || merged.length > breadcrumbs.length;
  if (breadcrumbs.length === NO_BREADCRUMBS) {
    return attributes;
  }
  return { ...attributes, breadcrumbs, ...(truncated ? { breadcrumbsTruncated: true } : {}) };
}

module.exports = { providedBreadcrumbs, withIssueBreadcrumbs };
