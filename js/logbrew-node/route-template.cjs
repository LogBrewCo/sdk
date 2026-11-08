"use strict";

const { applyFunction, readMember, readOptionalMember } = require("./internal.cjs");
const { pathOnly } = require("./span-support.cjs");

const RECORD_ID_SEGMENT = /^(?:\d+|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|[\da-f]{16,})$/iu;
const DYNAMIC_SEGMENT = /[(*:?{]/u;
const TRAILING_SLASH = /(?<=.)\/$/u;

/**
 * @param {string} path
 * @returns {string}
 */
function templateRecordIds(path) {
  return path
    .split("/")
    .map((segment) => (RECORD_ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

/**
 * Reads the path the client asked for. Express rewrites `req.url` inside mounted routers and
 * keeps the full value in `req.originalUrl`.
 * @param {unknown} req
 * @returns {string}
 */
function requestPath(req) {
  return pathOnly(readMember(req, "originalUrl") ?? readMember(req, "url") ?? "/");
}

/**
 * Uses the matched `req.route.path` only when it covers the whole request path. Under a mounted
 * router the declared mount pattern is not available here, so the request keeps the normalized
 * path instead of a mount path guessed from the URL.
 * @param {unknown} req
 * @param {string} path
 * @returns {string | undefined}
 */
function matchedRouteTemplate(req, path) {
  const routePath = readOptionalMember(readMember(req, "route"), "path");
  if (typeof routePath !== "string" || !routePath.startsWith("/")) {
    return undefined;
  }
  const routeSegments = routePath.replace(TRAILING_SLASH, "").split("/");
  const pathSegments = path.replace(TRAILING_SLASH, "").split("/");
  const fits = routeSegments.length === pathSegments.length && routeSegments.every(
    (segment, index) => DYNAMIC_SEGMENT.test(segment) || segment === pathSegments[index]
  );
  return fits ? routePath : undefined;
}

/**
 * Names a request by the app's `routeTemplateFactory`, then the framework route template, then
 * the request path with each numeric, UUID, or long hex (16 or more characters) segment
 * replaced by `:id`. `template` is set only for a real route template, never for a path.
 * @param {unknown} req
 * @param {unknown} routeTemplateFactory
 * @returns {Readonly<{ path: string, route: string, template: string | undefined }>}
 */
function requestRoute(req, routeTemplateFactory) {
  const rawPath = requestPath(req);
  const path = templateRecordIds(rawPath);
  const named = typeof routeTemplateFactory === "function" ? applyFunction(routeTemplateFactory, undefined, [req]) : undefined;
  const template = typeof named === "string" && named !== "" ? named : matchedRouteTemplate(req, rawPath);
  return { path, route: template ?? path, template };
}

module.exports = { requestRoute };
