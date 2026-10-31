"use strict";

const diagnosticsChannel = require("node:diagnostics_channel");
const {
  attempt,
  boundedText,
  callOptional,
  isObjectLike,
  isWeakKey,
  readMember,
  sanitizeUrl,
  templateText
} = require("./internal.cjs");

/**
 * @typedef {() => unknown} ActiveTraceProvider
 * @typedef {Readonly<Record<string, unknown>>} BreadcrumbEntry
 * @typedef {{ breadcrumbs: BreadcrumbEntry[], truncated: boolean }} BreadcrumbRing
 * @typedef {Readonly<{ breadcrumbs: BreadcrumbEntry[], truncated: boolean }>} BreadcrumbSnapshot
 * @typedef {(breadcrumb: unknown) => void} AddBreadcrumb
 * @typedef {Readonly<{ method: unknown, url: string | undefined }>} PendingRequest
 * @typedef {"debug" | "error" | "info" | "warning"} BreadcrumbLevel
 */

const MAX_BREADCRUMBS = 64;
const MAX_MESSAGE_LENGTH = 512;
const NUMERIC_ZERO = 0;
const LEVEL_NAME = 1;
const PINO_ERROR = 50;
const PINO_WARNING = 40;
const PINO_INFO = 30;
const FIRST_ARGUMENT = 0;
const CLIENT_ERROR_STATUS = 400;
const SERVER_ERROR_STATUS = 500;
const INSTALLED = Symbol.for("@logbrew/node.automaticBreadcrumbs");
const BREADCRUMB_RECORDER = Symbol.for("@logbrew/sdk.breadcrumbRecorder");
/** @type {readonly (readonly [string, BreadcrumbLevel])[]} */
const CONSOLE_LEVELS = [
  ["debug", "debug"],
  ["error", "error"],
  ["info", "info"],
  ["log", "info"],
  ["warn", "warning"]
];
/** @type {readonly (readonly [number, BreadcrumbLevel])[]} */
const PINO_LEVELS = [
  [PINO_ERROR, "error"],
  [PINO_WARNING, "warning"],
  [PINO_INFO, "info"],
  [NUMERIC_ZERO, "debug"]
];

/** @type {WeakMap<object, BreadcrumbRing>} */
const traceRings = new WeakMap();
/** @type {BreadcrumbRing} */
const processRing = { breadcrumbs: [], truncated: false };
/** @type {Set<string>} */
const ignoredUrls = new Set();
const recordingState = { active: false };
/** @type {WeakMap<object, PendingRequest>} */
const pendingRequests = new WeakMap();

/**
 * @param {ActiveTraceProvider} activeTraceProvider
 * @returns {BreadcrumbRing}
 */
function currentRing(activeTraceProvider) {
  const trace = activeTraceProvider();
  if (!isObjectLike(trace)) {
    return processRing;
  }
  const existing = traceRings.get(trace);
  if (existing) {
    return existing;
  }
  /** @type {BreadcrumbRing} */
  const ring = { breadcrumbs: [], truncated: false };
  traceRings.set(trace, ring);
  return ring;
}

/**
 * @param {ActiveTraceProvider} activeTraceProvider
 * @returns {() => BreadcrumbSnapshot}
 */
function createBreadcrumbProvider(activeTraceProvider) {
  return () => {
    const ring = currentRing(activeTraceProvider);
    return { breadcrumbs: [...ring.breadcrumbs], truncated: ring.truncated };
  };
}

/**
 * @param {unknown} value
 * @returns {void}
 */
function ignoreBreadcrumbUrl(value) {
  const url = sanitizeUrl(value);
  if (url !== undefined && url !== "") {
    ignoredUrls.add(url);
  }
}

/**
 * @param {object} breadcrumb
 * @param {ActiveTraceProvider} activeTraceProvider
 * @returns {void}
 */
function recordBreadcrumb(breadcrumb, activeTraceProvider) {
  const ring = currentRing(activeTraceProvider);
  if (ring.breadcrumbs.length >= MAX_BREADCRUMBS) {
    ring.breadcrumbs.shift();
    ring.truncated = true;
  }
  ring.breadcrumbs.push({ timestamp: new Date().toISOString(), ...breadcrumb });
}

/**
 * @param {unknown} breadcrumb
 * @param {ActiveTraceProvider} activeTraceProvider
 * @returns {void}
 */
function addLogBrewBreadcrumb(breadcrumb, activeTraceProvider) {
  if (!isObjectLike(breadcrumb) || recordingState.active) {
    return;
  }
  recordingState.active = true;
  attempt(() => {
    recordBreadcrumb(breadcrumb, activeTraceProvider);
  });
  recordingState.active = false;
}

/**
 * @param {readonly unknown[]} args
 * @returns {string}
 */
function consoleTemplate(args) {
  const [first] = args;
  if (typeof first === "string") {
    return first;
  }
  return first instanceof Error ? first.name || "Error" : "";
}

/**
 * @param {AddBreadcrumb} add
 * @returns {void}
 */
function installConsoleBreadcrumbs(add) {
  for (const [method, level] of CONSOLE_LEVELS) {
    /** @type {unknown} */
    const original = Reflect.get(console, method);
    if (typeof original === "function") {
      Reflect.set(
        console,
        method,
        /**
         * @this {unknown}
         * @param {readonly unknown[]} args
         * @returns {unknown}
         */
        function logBrewConsoleBreadcrumb(...args) {
          const message = boundedText(consoleTemplate(args), MAX_MESSAGE_LENGTH);
          if (message) {
            add({
              type: "debug",

              category: "console",
              level,
              message
            });
          }
          /** @type {unknown} */
          const result = Reflect.apply(original, this, args);
          return result;
        }
      );
    }
  }
}

/**
 * @param {string} name
 * @param {(message: unknown) => void} handler
 * @returns {void}
 */
function subscribe(name, handler) {
  diagnosticsChannel.subscribe(name, (message) => {
    attempt(() => {
      handler(message ?? {});
    });
  });
}

/**
 * @param {string | undefined} url
 * @returns {boolean}
 */
function isIgnoredUrl(url) {
  return url !== undefined && ignoredUrls.has(url);
}

/**
 * @param {number | undefined} status
 * @returns {BreadcrumbLevel}
 */
function httpLevel(status) {
  if (status === undefined || status < CLIENT_ERROR_STATUS) {
    return "info";
  }
  return status >= SERVER_ERROR_STATUS ? "error" : "warning";
}

/**
 * @param {unknown} method
 * @param {string | undefined} url
 * @param {unknown} [statusCode]
 * @returns {Readonly<Record<string, unknown>>}
 */
function httpBreadcrumb(method, url, statusCode) {
  const status = typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : undefined;
  return {
    type: "http",

    category: "http.client",

    level: httpLevel(status),

    data: {
      method: typeof method === "string" && method ? method.toUpperCase() : "GET",
      ...(url !== undefined && url !== "" ? { url } : {}),
      ...(status === undefined ? {} : { status_code: status })
    }
  };
}

/**
 * @param {unknown} request
 * @returns {string | undefined}
 */
function requestUrl(request) {
  const header = callOptional(request, "getHeader", ["host"]);
  const host = typeof header === "string" ? header : readMember(request, "host");
  const protocol = readMember(request, "protocol");
  const path = readMember(request, "path");
  return sanitizeUrl(
    `${typeof protocol === "string" ? protocol : "http:"}//${templateText(host ?? "unknown")}${typeof path === "string" ? path : "/"}`
  );
}

/**
 * @param {unknown} request
 * @returns {string | undefined}
 */
function undiciUrl(request) {
  const path = readMember(request, "path");
  return sanitizeUrl(`${templateText(readMember(request, "origin") ?? "")}${typeof path === "string" ? path : "/"}`);
}

/**
 * @param {unknown} message
 * @returns {PendingRequest | undefined}
 */
function takePending(message) {
  const request = readMember(message, "request");
  const started = isWeakKey(request) ? pendingRequests.get(request) : undefined;
  if (started && isWeakKey(request)) {
    pendingRequests.delete(request);
  }
  return started;
}

/**
 * @param {unknown} message
 * @param {(request: unknown) => string | undefined} urlOf
 * @returns {void}
 */
function startPending(message, urlOf) {
  const request = readMember(message, "request");
  const started = { method: readMember(request, "method"), url: urlOf(request) };
  if (!isWeakKey(request)) {
    throw new TypeError("Invalid value used as weak map key");
  }
  pendingRequests.set(request, started);
}

/**
 * @param {unknown} message
 * @returns {unknown}
 */
function responseStatus(message) {
  const response = readMember(message, "response");
  return response === undefined || response === null ? undefined : readMember(response, "statusCode");
}

/**
 * @param {AddBreadcrumb} add
 * @returns {void}
 */
function installHttpBreadcrumbs(add) {
  subscribe("http.client.request.start", (message) => {
    startPending(message, requestUrl);
  });
  subscribe("http.client.response.finish", (message) => {
    const request = readMember(message, "request");
    const started = isWeakKey(request) ? pendingRequests.get(request) : undefined;
    if (started && !isIgnoredUrl(started.url)) {
      add(httpBreadcrumb(started.method, started.url, responseStatus(message)));
    }
  });
  subscribe("undici:request:create", (message) => {
    startPending(message, undiciUrl);
  });
  subscribe("undici:request:headers", (message) => {
    const started = takePending(message);
    if (started && !isIgnoredUrl(started.url)) {
      add(httpBreadcrumb(started.method, started.url, responseStatus(message)));
    }
  });
  subscribe("undici:request:error", (message) => {
    const started = takePending(message);
    if (started && !isIgnoredUrl(started.url)) {
      add({ ...httpBreadcrumb(started.method, started.url), level: "error" });
    }
  });
}

/**
 * @param {unknown} result
 * @param {unknown} args
 * @returns {unknown}
 */
function parsePinoRecord(result, args) {
  if (typeof result === "string" && result) {
    try {
      /** @type {unknown} */
      const parsed = JSON.parse(result);
      return parsed;
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(args)) {
    return undefined;
  }
  /** @type {readonly unknown[]} */
  const values = args;
  const first = values[FIRST_ARGUMENT];
  return isObjectLike(first) ? first : undefined;
}

/**
 * @param {unknown} level
 * @returns {BreadcrumbLevel}
 */
function pinoLevel(level) {
  const numeric = Number(level);
  return PINO_LEVELS.find(([floor]) => numeric >= floor)?.[LEVEL_NAME] ?? "info";
}

/**
 * @param {AddBreadcrumb} add
 * @returns {void}
 */
function installPinoBreadcrumbs(add) {
  if (typeof diagnosticsChannel.tracingChannel !== "function") {
    return;
  }
  subscribe("tracing:pino_asJson:end", (message) => {
    const record = parsePinoRecord(readMember(message, "result"), readMember(message, "arguments"));
    if (record === undefined || record === null || record === false || record === NUMERIC_ZERO || record === "") {
      return;
    }
    const messageText = readMember(record, "msg");
    const text = boundedText(typeof messageText === "string" ? messageText : "", MAX_MESSAGE_LENGTH);
    if (text) {
      add({
        type: "debug",

        category: "log.pino",
        level: pinoLevel(readMember(record, "level")),
        message: text
      });
    }
  });
}

/**
 * @param {ActiveTraceProvider} activeTraceProvider
 * @returns {void}
 */
function installAutomaticBreadcrumbs(activeTraceProvider) {
  const installed = Boolean(Reflect.get(globalThis, INSTALLED));
  if (installed) {
    return;
  }
  Reflect.set(globalThis, INSTALLED, true);
  /**
   * @param {unknown} breadcrumb
   * @returns {void}
   */
  function add(breadcrumb) {
    addLogBrewBreadcrumb(breadcrumb, activeTraceProvider);
  }
  Reflect.set(globalThis, BREADCRUMB_RECORDER, add);
  installConsoleBreadcrumbs(add);
  installHttpBreadcrumbs(add);
  installPinoBreadcrumbs(add);
}

module.exports = { addLogBrewBreadcrumb, createBreadcrumbProvider, ignoreBreadcrumbUrl, installAutomaticBreadcrumbs };
