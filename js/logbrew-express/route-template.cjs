"use strict";

const UNMATCHED_ROUTE = "<unmatched>";
const ABSOLUTE_FORM_PREFIX = /^[a-z][\d+.a-z-]*:\/\/[^/?#]*/iu;
const QUERY_OR_FRAGMENT = /[?#].*$/su;
const TRAILING_SLASH = /\/$/u;
const EXPRESS4_PATTERN = /^\^(?<body>.*?)(?:\\\/\?)?\(\?=\\\/\|\$\)$/su;
const EXPRESS4_TOKEN = /\\\/(?<literal>(?:[\w~-]|\\\.)+)|\(\?:\\(?<separator>[./])\((?:[^()]+)\)\)(?<optional>\??)/gyu;
const ESCAPED_DOT = /\\\./gu;
const PATH_TO_REGEXP_MATCHER = "match";
const PROBE_SEGMENT = "logbrew-mount-probe";
const NO_PARAMS = 0;
const FIRST_SEGMENT = 1;

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
 * @param {unknown} keys
 * @returns {readonly unknown[]}
 */
function keyNames(keys) {
  return Array.isArray(keys) ? keys.map((key) => member(key, "name")) : [];
}

/**
 * @param {Readonly<Record<string, string | undefined>> | undefined} groups
 * @param {unknown} name
 * @returns {string | undefined}
 */
function express4Part(groups, name) {
  const literal = groups?.["literal"];
  if (literal !== undefined) {
    return `/${literal.replaceAll(ESCAPED_DOT, ".")}`;
  }
  return groups === undefined || typeof name !== "string" ? undefined : `${String(groups["separator"])}:${name}${String(groups["optional"])}`;
}

/**
 * @param {string} body
 * @returns {readonly Readonly<Record<string, string | undefined>>[] | undefined}
 */
function express4Tokens(body) {
  const tokens = [];
  EXPRESS4_TOKEN.lastIndex = NO_PARAMS;
  while (EXPRESS4_TOKEN.lastIndex < body.length) {
    const groups = EXPRESS4_TOKEN.exec(body)?.groups;
    if (groups === undefined) {
      return undefined;
    }
    tokens.push(groups);
  }
  return tokens;
}

/**
 * @param {string} body
 * @param {readonly unknown[]} names
 * @returns {string | undefined}
 */
function express4Body(body, names) {
  const tokens = express4Tokens(body);
  const params = tokens?.filter((groups) => groups["literal"] === undefined) ?? [];
  if (tokens === undefined || params.length !== names.length) {
    return undefined;
  }
  const parts = tokens.map((groups) => express4Part(groups, names[params.indexOf(groups)]));
  return parts.includes(undefined) ? undefined : parts.join("");
}

/**
 * @param {unknown} layer
 * @returns {string | undefined}
 */
function express4Template(layer) {
  const regexp = member(layer, "regexp");
  const body = regexp instanceof RegExp ? EXPRESS4_PATTERN.exec(regexp.source)?.groups?.["body"] : undefined;
  return body === undefined ? undefined : express4Body(body, keyNames(member(layer, "keys")));
}

/**
 * @param {unknown} value
 * @returns {value is (path: string) => unknown}
 */
function isPathMatcher(value) {
  return typeof value === "function" && value.name === PATH_TO_REGEXP_MATCHER;
}

/**
 * @param {unknown} result
 * @returns {Readonly<Record<string, unknown>> | undefined}
 */
function matchParams(result) {
  const params = member(result, "params");
  return typeof params === "object" && params !== null ? Object.fromEntries(Object.entries(params)) : undefined;
}

/**
 * @param {(path: string) => unknown} matcher
 * @param {readonly string[]} segments
 * @param {number} index
 * @returns {string | undefined}
 */
function probedParam(matcher, segments, index) {
  const probe = segments.map((segment, at) => (at === index ? PROBE_SEGMENT : segment)).join("/");
  const params = matchParams(matcher(probe));
  if (params === undefined) {
    return "";
  }
  return Object.keys(params).find((name) => params[name] === PROBE_SEGMENT);
}

/**
 * @param {(path: string) => unknown} matcher
 * @param {string} matched
 * @returns {string | undefined}
 */
function express5Template(matcher, matched) {
  const params = matchParams(matcher(matched)) ?? {};
  const segments = matched.replace(TRAILING_SLASH, "").split("/");
  const named = new Set();
  const template = segments.map((segment, index) => {
    const name = index < FIRST_SEGMENT ? "" : probedParam(matcher, segments, index);
    named.add(name);
    return name === "" ? segment : `:${String(name)}`;
  });
  const declared = Object.keys(params).filter((name) => params[name] !== undefined);
  return named.has(undefined) || declared.some((name) => !named.has(name)) ? undefined : template.join("/");
}

/**
 * @param {unknown} layer
 * @param {string} matched
 * @returns {string | undefined}
 */
function declaredMountTemplate(layer, matched) {
  const matchers = member(layer, "matchers");
  if (!Array.isArray(matchers)) {
    return express4Template(layer);
  }
  const matcher = matchers.filter((candidate) => isPathMatcher(candidate)).find((candidate) => candidate(matched) !== false);
  return matcher === undefined ? undefined : express5Template(matcher, matched);
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
  const mount = declaredMountTemplate(layer, matched);
  const rest = path.slice(matched.length);
  return mount === undefined ? undefined : { mount: mount.replace(TRAILING_SLASH, ""), rest: rest.startsWith("/") ? rest : `/${rest}` };
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
