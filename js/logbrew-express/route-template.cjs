"use strict";

const UNMATCHED_ROUTE = "<unmatched>";
const ABSOLUTE_FORM_PREFIX = /^[a-z][\d+.a-z-]*:\/\/[^/?#]*/iu;
const QUERY_OR_FRAGMENT = /[?#].*$/su;
const TRAILING_SLASH = /\/$/u;
const NO_PARAMS = 0;

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {unknown}
 */
function member(value, name) {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, name) : undefined;
}

/**
 * @param {unknown} req
 * @returns {string | undefined}
 */
function requestPathname(req) {
  const url = member(req, "originalUrl") ?? member(req, "url");
  if (typeof url !== "string") {
    return undefined;
  }
  const pathname = url.replace(ABSOLUTE_FORM_PREFIX, "").replace(QUERY_OR_FRAGMENT, "");
  return pathname.startsWith("/") ? pathname : undefined;
}

/**
 * @param {string} segment
 * @returns {string}
 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * @param {unknown} params
 * @returns {readonly string[]}
 */
function paramNames(params) {
  if (typeof params !== "object" || params === null) {
    return [];
  }
  return Object.keys(params).filter((name) => Reflect.get(params, name) !== undefined);
}

/**
 * @param {string} matched
 * @param {unknown} params
 * @returns {string | undefined}
 */
function mountTemplate(matched, params) {
  const pending = [...paramNames(params)];
  const segments = matched.split("/").map((segment) => {
    const [name] = pending;
    if (name !== undefined && decodeSegment(segment) === member(params, name)) {
      pending.shift();
      return `:${name}`;
    }
    return segment;
  });
  return pending.length === NO_PARAMS ? segments.join("/").replace(TRAILING_SLASH, "") : undefined;
}

/**
 * @param {unknown} layer
 * @param {string} path
 * @returns {boolean}
 */
function layerMatches(layer, path) {
  const match = member(layer, "match");
  return typeof match === "function" && Reflect.apply(match, layer, [path]) === true;
}

/**
 * @param {unknown} handle
 * @returns {readonly unknown[] | undefined}
 */
function childStack(handle) {
  const stack = member(handle, "stack");
  return Array.isArray(stack) ? stack : undefined;
}

/**
 * @param {unknown} layer
 * @param {string} path
 * @returns {Readonly<{ mount: string, rest: string }> | undefined}
 */
function mountedPart(layer, path) {
  const matched = member(layer, "path");
  if (typeof matched !== "string" || !path.startsWith(matched)) {
    return undefined;
  }
  const mount = mountTemplate(matched, member(layer, "params"));
  const rest = path.slice(matched.length);
  return mount === undefined ? undefined : { mount, rest: rest.startsWith("/") ? rest : `/${rest}` };
}

/**
 * @param {readonly unknown[]} stack
 * @param {string} path
 * @param {unknown} route
 * @returns {string | undefined}
 */
function mountPathTo(stack, path, route) {
  for (const layer of stack) {
    const children = childStack(member(layer, "handle"));
    if (member(layer, "route") === route && layerMatches(layer, path)) {
      return "";
    }
    const part = children !== undefined && layerMatches(layer, path) ? mountedPart(layer, path) : undefined;
    const nested = part === undefined ? undefined : mountPathTo(children ?? [], part.rest, route);
    if (part !== undefined && nested !== undefined) {
      return `${part.mount}${nested}`;
    }
  }
  return undefined;
}

/**
 * @param {unknown} req
 * @param {unknown} route
 * @returns {string}
 */
function mountPathOf(req, route) {
  const app = member(req, "app");
  const stack = childStack(member(app, "_router") ?? member(app, "router"));
  const path = requestPathname(req);
  try {
    return stack === undefined || path === undefined ? "" : mountPathTo(stack, path, route) ?? "";
  } catch {
    return "";
  }
}

/**
 * @param {unknown} req
 * @returns {string}
 */
function getRouteTemplate(req) {
  const route = member(req, "route");
  const routePath = member(route, "path");
  if (typeof routePath !== "string") {
    return UNMATCHED_ROUTE;
  }
  const mountPath = mountPathOf(req, route);
  return mountPath !== "" && routePath === "/" ? mountPath : `${mountPath}${routePath}`;
}

module.exports = { getRouteTemplate };
