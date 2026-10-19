"use strict";

const diagnosticsChannel = require("node:diagnostics_channel");
const { format } = require("node:util");

const MAX_BREADCRUMBS = 64;
const MAX_MESSAGE_LENGTH = 512;
const MAX_URL_LENGTH = 256;
const INSTALLED = Symbol.for("@logbrew/node.automaticBreadcrumbs");
const CONSOLE_LEVELS = Object.freeze({
  debug: "debug",
  error: "error",
  info: "info",
  log: "info",
  warn: "warning"
});
const PINO_LEVELS = [[50, "error"], [40, "warning"], [30, "info"], [0, "debug"]];

// Breadcrumbs recorded inside a request belong to that request's trace; others go to the process ring.
const traceRings = new WeakMap();
const processRing = { breadcrumbs: [], truncated: false };
// LogBrew's own delivery requests are not application breadcrumbs.
const ignoredUrls = new Set();
let recording = false;

function createBreadcrumbProvider(activeTraceProvider) {
  return () => {
    const ring = currentRing(activeTraceProvider);
    return { breadcrumbs: ring.breadcrumbs.slice(), truncated: ring.truncated };
  };
}

function ignoreBreadcrumbUrl(value) {
  const url = sanitizeUrl(value);
  if (url) {
    ignoredUrls.add(url);
  }
}

function addLogBrewBreadcrumb(breadcrumb, activeTraceProvider) {
  if (!breadcrumb || typeof breadcrumb !== "object" || recording) {
    return;
  }
  // A breadcrumb source must never throw into the application call it observes.
  recording = true;
  try {
    const ring = currentRing(activeTraceProvider);
    if (ring.breadcrumbs.length >= MAX_BREADCRUMBS) {
      ring.breadcrumbs.shift();
      ring.truncated = true;
    }
    ring.breadcrumbs.push({ timestamp: new Date().toISOString(), ...breadcrumb });
  } catch {
    // Ignore: breadcrumbs are advisory.
  } finally {
    recording = false;
  }
}

function currentRing(activeTraceProvider) {
  const trace = activeTraceProvider();
  if (!trace || typeof trace !== "object") {
    return processRing;
  }
  let ring = traceRings.get(trace);
  if (!ring) {
    ring = { breadcrumbs: [], truncated: false };
    traceRings.set(trace, ring);
  }
  return ring;
}

// Installs console, outbound HTTP, and Pino breadcrumb sources once per process.
function installAutomaticBreadcrumbs(activeTraceProvider) {
  if (globalThis[INSTALLED]) {
    return;
  }
  globalThis[INSTALLED] = true;
  const add = (breadcrumb) => addLogBrewBreadcrumb(breadcrumb, activeTraceProvider);
  installConsoleBreadcrumbs(add);
  installHttpBreadcrumbs(add);
  installPinoBreadcrumbs(add);
}

function installConsoleBreadcrumbs(add) {
  for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
    const original = console[method];
    if (typeof original !== "function") {
      continue;
    }
    console[method] = function logBrewConsoleBreadcrumb(...args) {
      const message = boundedText(safeFormat(args), MAX_MESSAGE_LENGTH);
      if (message) {
        add({ type: "debug", category: "console", level, message });
      }
      return original.apply(this, args);
    };
  }
}

function installHttpBreadcrumbs(add) {
  const pending = new WeakMap();
  // Node's http client (http.request, http.get, and libraries built on them).
  subscribe("http.client.request.start", ({ request }) => {
    pending.set(request, { method: request.method, url: requestUrl(request) });
  });
  subscribe("http.client.response.finish", ({ request, response }) => {
    const started = pending.get(request);
    if (started && !isIgnoredUrl(started.url)) {
      add(httpBreadcrumb(started.method, started.url, response?.statusCode));
    }
  });
  // undici, which also backs the global fetch.
  subscribe("undici:request:create", ({ request }) => {
    pending.set(request, { method: request.method, url: undiciUrl(request) });
  });
  subscribe("undici:request:headers", ({ request, response }) => {
    const started = pending.get(request);
    if (started) {
      pending.delete(request);
      if (!isIgnoredUrl(started.url)) {
        add(httpBreadcrumb(started.method, started.url, response?.statusCode));
      }
    }
  });
  subscribe("undici:request:error", ({ request }) => {
    const started = pending.get(request);
    if (started) {
      pending.delete(request);
      if (!isIgnoredUrl(started.url)) {
        add({ ...httpBreadcrumb(started.method, started.url), level: "error" });
      }
    }
  });
}

function installPinoBreadcrumbs(add) {
  if (typeof diagnosticsChannel.tracingChannel !== "function") {
    return;
  }
  subscribe("tracing:pino_asJson:end", ({ arguments: args, result }) => {
    const record = parsePinoRecord(result, args);
    if (!record) {
      return;
    }
    const message = boundedText(typeof record.msg === "string" ? record.msg : "", MAX_MESSAGE_LENGTH);
    if (message) {
      add({ type: "debug", category: "log.pino", level: pinoLevel(record.level), message });
    }
  });
}

function subscribe(name, handler) {
  diagnosticsChannel.subscribe(name, (message) => {
    try {
      handler(message ?? {});
    } catch {
      // Ignore: breadcrumbs are advisory.
    }
  });
}

function isIgnoredUrl(url) {
  return url !== undefined && ignoredUrls.has(url);
}

function httpBreadcrumb(method, url, statusCode) {
  const status = Number.isInteger(statusCode) ? statusCode : undefined;
  return {
    type: "http",
    category: "http.client",
    level: status === undefined || status < 400 ? "info" : status >= 500 ? "error" : "warning",
    data: {
      method: typeof method === "string" && method ? method.toUpperCase() : "GET",
      ...(url ? { url } : {}),
      ...(status === undefined ? {} : { status_code: status })
    }
  };
}

// Keeps scheme, host, and path; drops credentials, query, and fragment.
function requestUrl(request) {
  const header = request.getHeader?.("host");
  const host = typeof header === "string" ? header : request.host;
  const protocol = typeof request.protocol === "string" ? request.protocol : "http:";
  return sanitizeUrl(`${protocol}//${host ?? "unknown"}${typeof request.path === "string" ? request.path : "/"}`);
}

function undiciUrl(request) {
  return sanitizeUrl(`${request.origin ?? ""}${typeof request.path === "string" ? request.path : "/"}`);
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    return boundedText(`${url.protocol}//${url.host}${url.pathname}`, MAX_URL_LENGTH);
  } catch {
    return undefined;
  }
}

function parsePinoRecord(result, args) {
  const candidate = typeof result === "string" ? result : undefined;
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(args) && args[0] && typeof args[0] === "object" ? args[0] : undefined;
}

function pinoLevel(level) {
  const numeric = Number(level);
  return PINO_LEVELS.find(([floor]) => numeric >= floor)?.[1] ?? "info";
}

function safeFormat(args) {
  try {
    return format(...args.map((value) => (value instanceof Error ? `${value.name}: ${value.message}` : value)));
  } catch {
    return "";
  }
}

function boundedText(value, limit) {
  // Breadcrumb text allows no control characters; newlines and tabs become spaces.
  const characters = Array.from(String(value), (character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
  });
  return Array.from(characters.join("").replace(/\s+/gu, " ").trim()).slice(0, limit).join("");
}

module.exports = { addLogBrewBreadcrumb, createBreadcrumbProvider, ignoreBreadcrumbUrl, installAutomaticBreadcrumbs };
