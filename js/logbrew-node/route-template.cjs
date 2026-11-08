"use strict";

const { applyFunction, readMember } = require("./internal.cjs");
const { pathOnly } = require("./span-support.cjs");

const RECORD_ID_SEGMENT = /^(?:\d+|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|[\da-f]{16,})$/iu;

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
 * Names a request by the app's `routeTemplateFactory`, then by the request path with each numeric, UUID, or long hex (16 or more characters) segment
 * replaced by `:id`. `template` is set only for a real route template, never for a path.
 * @param {unknown} req
 * @param {unknown} routeTemplateFactory
 * @returns {Readonly<{ path: string, route: string, template: string | undefined }>}
 */
function requestRoute(req, routeTemplateFactory) {
  const rawPath = requestPath(req);
  const path = templateRecordIds(rawPath);
  const named = typeof routeTemplateFactory === "function" ? applyFunction(routeTemplateFactory, undefined, [req]) : undefined;
  const template = typeof named === "string" && named !== "" ? named : undefined;
  return { path, route: template ?? path, template };
}

module.exports = { requestRoute };
