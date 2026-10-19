"use strict";

// Request-error event building and deployment detection without Node-only imports, so the Edge runtime can use them.
const { createIssueAttributesFromError, parseTraceparent } = require("@logbrew/sdk");

const MAX_REQUEST_ERROR_MESSAGE_LENGTH = 2048;
const MAX_REQUEST_ROUTE_PATH_LENGTH = 512;
const NEXT_RENDER_SOURCES = new Set([
  "react-server-components",
  "react-server-components-payload",
  "server-rendering"
]);
const NEXT_RENDER_TYPES = new Set(["dynamic", "dynamic-resume"]);
const NEXT_REVALIDATE_REASONS = new Set(["on-demand", "stale"]);
const NEXT_ROUTE_TYPES = new Set(["action", "middleware", "proxy", "render", "route"]);
const NEXT_ROUTER_KINDS = new Set(["App Router", "Pages Router"]);

function createNextRequestErrorEvent(error, request = {}, context = {}, {
  includeErrorStack = false,
  includePathname = false,
  now = () => new Date().toISOString(),
  idFactory = defaultNextRequestErrorId
} = {}) {
  const method = nextRequestMethod(request);
  const routePath = nextRoutePath(context?.routePath);
  const pathname = includePathname ? nextRoutePath(request?.path) : undefined;
  const errorDigest = nextErrorDigest(error);
  return {
    id: idFactory(error, request, context),
    timestamp: now(),
    attributes: createIssueAttributesFromError(error, {
      title: `${method} ${routePath} failed`,
      message: nextErrorMessage(error),
      mechanism: "nextjs.on_request_error",
      handled: false,
      source: "nextjs.on_request_error",
      includeErrorStack,
      metadata: {
        framework: "nextjs",
        method,
        routePath,
        ...nextCategoricalMetadata("routerKind", context?.routerKind, NEXT_ROUTER_KINDS),
        ...nextCategoricalMetadata("routeType", context?.routeType, NEXT_ROUTE_TYPES),
        ...nextCategoricalMetadata("renderSource", context?.renderSource, NEXT_RENDER_SOURCES),
        ...nextCategoricalMetadata("revalidateReason", context?.revalidateReason, NEXT_REVALIDATE_REASONS),
        ...nextCategoricalMetadata("renderType", context?.renderType, NEXT_RENDER_TYPES),
        ...nextRequestTraceMetadata(request),
        ...(errorDigest ? { errorDigest } : {}),
        ...(pathname ? { pathname } : {})
      }
    })
  };
}

function defaultNextRequestErrorId() {
  return `evt_next_request_error_${randomHex(8)}`;
}

function nextRequestMethod(request) {
  const method = typeof request?.method === "string" ? request.method.trim().toUpperCase() : "";
  return /^[A-Z]{1,16}$/u.test(method) ? method : "UNKNOWN";
}

function nextRoutePath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "/";
  }
  let pathname;
  try {
    pathname = new URL(value, "http://localhost").pathname;
  } catch {
    return "/";
  }
  if (typeof pathname !== "string" || pathname === "") {
    return "/";
  }
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return normalized.length <= MAX_REQUEST_ROUTE_PATH_LENGTH ? normalized : "/";
}

function nextCategoricalMetadata(key, value, allowed) {
  return typeof value === "string" && allowed.has(value) ? { [key]: value } : {};
}

function nextErrorDigest(error) {
  const digest = error && typeof error === "object" ? error.digest : undefined;
  if (typeof digest !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(digest)) {
    return undefined;
  }
  return digest;
}

function nextErrorMessage(error) {
  let message;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = "Next.js request failed";
  }
  const normalized = typeof message === "string" && message.trim() !== ""
    ? message
    : "Next.js request failed";
  return normalized.length <= MAX_REQUEST_ERROR_MESSAGE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_REQUEST_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function nextRequestTraceMetadata(request) {
  try {
    const traceparent = getTraceparentHeader(request);
    if (!traceparent) {
      return {};
    }
    const trace = parseTraceparent(traceparent);
    return {
      traceId: trace.traceId,
      parentSpanId: trace.parentSpanId,
      sampled: trace.sampled
    };
  } catch {
    return {};
  }
}

function getTraceparentHeader(request) {
  const headers = request?.headers;
  if (!headers) {
    return undefined;
  }
  let value;
  if (typeof headers.get === "function") {
    value = headers.get("traceparent");
  } else {
    const names = Object.keys(headers).filter(name => name.toLowerCase() === "traceparent");
    value = names.length === 1 ? headers[names[0]] : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return /^0+$/.test(value) ? "0000000000000001" : value;
}

function readEnvApiKey() {
  return globalThis.process?.env?.LOGBREW_API_KEY;
}

function readEnvServerApiKey() {
  return globalThis.process?.env?.LOGBREW_SERVER_API_KEY;
}

// Release, environment, and service from LOGBREW_* variables, then Vercel's system variables.
function nextDeploymentContext(context, env = globalThis.process?.env ?? {}) {
  const release = boundedEnv(env.LOGBREW_RELEASE) ?? boundedEnv(env.VERCEL_GIT_COMMIT_SHA);
  const environment = boundedEnv(env.LOGBREW_ENVIRONMENT) ?? boundedEnv(env.VERCEL_ENV);
  const service = boundedEnv(env.LOGBREW_SERVICE_NAME);
  return mergeDeployment(context, { release, environment, service });
}

function mergeDeployment(context, { release, environment, service }) {
  if (release === undefined && environment === undefined && service === undefined) {
    return context;
  }
  if (context !== undefined && (context === null || typeof context !== "object" || context.schemaVersion !== 1)) {
    return context;
  }
  const resource = context?.resource ?? {};
  const deployment = {
    ...(environment === undefined ? {} : { environment }),
    ...(release === undefined ? {} : { release }),
    ...resource.deployment
  };
  return {
    ...(context ?? { schemaVersion: 1 }),
    resource: {
      ...resource,
      ...(Object.keys(deployment).length === 0 ? {} : { deployment }),
      ...(service === undefined || resource.service ? {} : { service: { name: service } })
    }
  };
}

function boundedEnv(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  const characters = Array.from(normalized);
  if (characters.length === 0 || characters.length > 256 || characters.some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  })) {
    return undefined;
  }
  return normalized;
}

module.exports = {
  createNextRequestErrorEvent,
  getTraceparentHeader,
  mergeDeployment,
  nextDeploymentContext,
  nextRoutePath,
  randomHex,
  readEnvApiKey,
  readEnvServerApiKey
};
