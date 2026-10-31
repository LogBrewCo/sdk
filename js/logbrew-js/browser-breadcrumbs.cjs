"use strict";

/**
 * @import { IssueBreadcrumbLevel } from "./index.cjs"
 */

/**
 * @typedef {Readonly<{
 *   category: string;
 *   data?: Readonly<Record<string, number | string>>;
 *   level?: IssueBreadcrumbLevel;
 *   message?: string;
 *   type: string;
 * }>} BrowserBreadcrumb
 * @typedef {(breadcrumb: BrowserBreadcrumb) => boolean} AddBreadcrumb
 * @typedef {() => void} Restore
 * @typedef {(this: unknown, ...args: readonly unknown[]) => unknown} ObservedMethod
 * @typedef {Readonly<{ method: string; url: string | undefined }>} HttpRequest
 * @typedef {Readonly<{ method?: unknown; url?: unknown }> | undefined} FetchInput
 * @typedef {Readonly<{ method?: unknown }> | undefined} FetchInit
 * @typedef {Readonly<{ status?: unknown }> | undefined} FetchResponse
 * @typedef {(this: unknown, input: FetchInput, init: FetchInit) => Promise<FetchResponse>} FetchMethod
 * @typedef {Readonly<{
 *   addEventListener?: (type: string, listener: () => void) => unknown;
 *   status?: unknown;
 * }>} XhrInstance
 * @typedef {(this: XhrInstance, method: unknown, url: unknown, ...rest: readonly unknown[]) => unknown} XhrOpen
 * @typedef {(this: XhrInstance, ...args: readonly unknown[]) => unknown} XhrSend
 * @typedef {Readonly<{ open?: XhrOpen; send?: XhrSend }>} XhrPrototype
 * @typedef {"debug" | "error" | "info" | "log" | "warn"} ConsoleMethod
 * @typedef {Readonly<Partial<Record<ConsoleMethod, ObservedMethod>>>} BrowserConsole
 * @typedef {Readonly<{ pushState?: ObservedMethod; replaceState?: ObservedMethod }>} BrowserHistory
 * @typedef {Readonly<{
 *   addEventListener?: (type: string, listener: () => void) => unknown;
 *   console?: BrowserConsole;
 *   fetch?: FetchMethod;
 *   history?: BrowserHistory;
 *   location?: Readonly<{ href?: unknown; pathname?: unknown }>;
 *   removeEventListener?: (type: string, listener: () => void) => unknown;
 *   XMLHttpRequest?: Readonly<{ prototype?: XhrPrototype }>;
 * }>} BrowserWindow
 * @typedef {Readonly<{ addBreadcrumb: (breadcrumb: BrowserBreadcrumb) => unknown }>} BreadcrumbClient
 * @typedef {Readonly<{
 *   console?: boolean;
 *   ignoredUrls?: readonly unknown[];
 *   navigation?: boolean;
 *   network?: boolean;
 * }>} BrowserBreadcrumbOptions
 */

const MAX_MESSAGE_LENGTH = 512;
const MAX_URL_LENGTH = 256;
const MAX_METHOD_LENGTH = 16;
const TEXT_START = 0;
const FIRST_RESTORE = 0;
const NO_STATUS = 0;
const CLIENT_ERROR_STATUS = 400;
const SERVER_ERROR_STATUS = 500;
const LAST_C0_CONTROL = 31;
const FIRST_C1_CONTROL = 127;
const LAST_C1_CONTROL = 159;
const WHITESPACE_PATTERN = /\s+/gu;
/** @type {ReadonlyMap<ConsoleMethod, IssueBreadcrumbLevel>} */
const CONSOLE_LEVELS = new Map([
  ["debug", "debug"],
  ["error", "error"],
  ["info", "info"],
  ["log", "info"],
  ["warn", "warning"]
]);
/** @type {readonly (keyof BrowserHistory)[]} */
const NAVIGATION_METHODS = ["pushState", "replaceState"];

/** @type {(value: unknown) => string} */
const text = String;

/**
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function boundedText(value, limit) {
  const characters = Array.from(text(value), (character) => {
    const code = character.codePointAt(TEXT_START);
    return code !== undefined && (code <= LAST_C0_CONTROL || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL))
      ? " "
      : character;
  });
  return [...characters.join("").replaceAll(WHITESPACE_PATTERN, " ").trim()].slice(TEXT_START, limit).join("");
}

/**
 * @param {unknown} value
 * @param {BrowserWindow} browserWindow
 * @returns {string | undefined}
 */
function sanitizeUrl(value, browserWindow) {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    const url = new URL(text(value), text(browserWindow.location?.href ?? "http://localhost/"));
    const sanitized = boundedText(`${url.protocol}//${url.host}${url.pathname}`, MAX_URL_LENGTH);
    return sanitized === "" ? undefined : sanitized;
  } catch {
    return undefined;
  }
}

/**
 * @param {BrowserWindow} browserWindow
 * @returns {string | undefined}
 */
function currentPath(browserWindow) {
  const pathname = browserWindow.location?.pathname;
  return typeof pathname === "string" ? boundedText(pathname, MAX_URL_LENGTH) : undefined;
}

/**
 * @param {Readonly<Error>} error
 * @returns {string}
 */
function errorName(error) {
  if (error.name) {
    return error.name;
  }
  return "Error";
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
  return first instanceof Error ? errorName(first) : "";
}

/**
 * @param {number | undefined} statusCode
 * @returns {IssueBreadcrumbLevel}
 */
function httpLevel(statusCode) {
  if (statusCode === undefined || statusCode < CLIENT_ERROR_STATUS) {
    return "info";
  }
  return statusCode >= SERVER_ERROR_STATUS ? "error" : "warning";
}

/**
 * @param {string} category
 * @param {HttpRequest} request
 * @param {unknown} [status]
 * @returns {BrowserBreadcrumb}
 */
function httpBreadcrumb(category, request, status) {
  const statusCode = typeof status === "number" && Number.isInteger(status) && status > NO_STATUS ? status : undefined;
  const method = request.method.slice(TEXT_START, MAX_METHOD_LENGTH);
  return {
    type: "http",

    category,
    level: httpLevel(statusCode),

    data: {
      method: method === "" ? "GET" : method,
      ...(request.url === undefined ? {} : { url: request.url }),
      ...(statusCode === undefined ? {} : { status_code: statusCode })
    }
  };
}

/**
 * @template {object} Target
 * @template {keyof Target & string} Name
 * @param {Target | undefined} target
 * @param {Name} name
 * @param {(original: NonNullable<Target[Name]>) => NonNullable<Target[Name]>} wrap
 * @returns {Restore[]}
 */
function replaceMethod(target, name, wrap) {
  const original = target?.[name];
  if (target === undefined || typeof original !== "function") {
    return [];
  }
  const replacement = wrap(original);
  Object.assign(target, { [name]: replacement });
  return [
    () => {
      if (target[name] === replacement) {
        Object.assign(target, { [name]: original });
      }
    }
  ];
}

/**
 * @param {BrowserConsole | undefined} target
 * @param {AddBreadcrumb} add
 * @returns {Restore[]}
 */
function patchConsole(target, add) {
  if (!target) {
    return [];
  }
  /** @type {Restore[]} */
  const restores = [];
  for (const [method, level] of CONSOLE_LEVELS) {
    restores.push(...replaceMethod(target, method, (original) => (
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
        return Reflect.apply(original, this, args);
      }
    )));
  }
  return restores;
}

/**
 * @param {BrowserWindow} browserWindow
 * @param {AddBreadcrumb} add
 * @param {Readonly<ReadonlySet<string | undefined>>} ignored
 * @returns {Restore[]}
 */
function patchFetch(browserWindow, add, ignored) {
  return replaceMethod(browserWindow, "fetch", (original) => (
    /**
     * @this {unknown}
     * @param {FetchInput} input
     * @param {FetchInit} init
     * @returns {Promise<FetchResponse>}
     */
    async function logBrewFetchBreadcrumb(input, init) {
      const request = {
        method: text(init?.method ?? input?.method ?? "GET").toUpperCase(),
        url: sanitizeUrl(typeof input === "string" || input instanceof URL ? input : input?.url, browserWindow)
      };
      try {
        const response = await original.call(this, input, init);
        if (!ignored.has(request.url)) {
          add(httpBreadcrumb("fetch", request, response?.status));
        }
        return response;
      } catch (error) {
        if (!ignored.has(request.url)) {
          add({ ...httpBreadcrumb("fetch", request), level: "error" });
        }
        throw error;
      }
    }
  ));
}

/**
 * @param {BrowserWindow} browserWindow
 * @param {AddBreadcrumb} add
 * @param {Readonly<ReadonlySet<string | undefined>>} ignored
 * @returns {Restore[]}
 */
function patchXhr(browserWindow, add, ignored) {
  const prototype = browserWindow.XMLHttpRequest?.prototype;
  if (!prototype) {
    return [];
  }
  /** @type {WeakMap<XhrInstance, HttpRequest>} */
  const state = new WeakMap();
  return [
    ...replaceMethod(prototype, "open", (original) => (
      /**
       * @this {XhrInstance}
       * @param {unknown} method
       * @param {unknown} url
       * @param {readonly unknown[]} rest
       * @returns {unknown}
       */
      function logBrewXhrOpen(method, url, ...rest) {
        state.set(this, { method: text(method ?? "GET").toUpperCase(), url: sanitizeUrl(url, browserWindow) });
        return original.call(this, method, url, ...rest);
      }
    )),
    ...replaceMethod(prototype, "send", (original) => (
      /**
       * @this {XhrInstance}
       * @param {readonly unknown[]} args
       * @returns {unknown}
       */
      function logBrewXhrSend(...args) {
        const request = state.get(this);
        if (request && !ignored.has(request.url) && typeof this.addEventListener === "function") {
          this.addEventListener("loadend", () => {
            add(httpBreadcrumb("xhr", request, this.status));
          });
        }
        return Reflect.apply(original, this, args);
      }
    ))
  ];
}

/**
 * @param {BrowserWindow} browserWindow
 * @param {AddBreadcrumb} add
 * @returns {Restore[]}
 */
function patchNavigation(browserWindow, add) {
  const { history } = browserWindow;
  if (!history) {
    return [];
  }
  let from = currentPath(browserWindow);
  /** @returns {void} */
  function record() {
    const to = currentPath(browserWindow);
    if (to !== undefined && to !== "" && to !== from) {
      add({
        type: "navigation",

        category: "navigation",
        data: { ...(from === undefined || from === "" ? {} : { from }), to }
      });
      from = to;
    }
  }
  const restores = NAVIGATION_METHODS.flatMap((method) => replaceMethod(history, method, (original) => (
    /**
     * @this {unknown}
     * @param {readonly unknown[]} args
     * @returns {unknown}
     */
    function logBrewNavigationBreadcrumb(...args) {
      const result = Reflect.apply(original, this, args);
      record();
      return result;
    }
  )));
  if (typeof browserWindow.addEventListener === "function") {
    browserWindow.addEventListener("popstate", record);
    restores.push(() => {
      browserWindow.removeEventListener?.("popstate", record);
    });
  }
  return restores;
}

/**
 * @param {BrowserWindow} browserWindow
 * @param {BreadcrumbClient} client
 * @param {BrowserBreadcrumbOptions} [options]
 * @returns {Restore}
 */
function installBrowserBreadcrumbs(browserWindow, client, {
  console: captureConsole = true,
  ignoredUrls = [],
  navigation = true,
  network = true
} = {}) {
  const ignored = new Set(ignoredUrls.map((url) => sanitizeUrl(url, browserWindow)).filter(Boolean));
  /**
   * @param {BrowserBreadcrumb} breadcrumb
   * @returns {boolean}
   */
  function add(breadcrumb) {
    try {
      client.addBreadcrumb(breadcrumb);
    } catch {
      return false;
    }
    return true;
  }
  /** @type {Restore[]} */
  const restores = [];
  if (captureConsole) {
    restores.push(...patchConsole(browserWindow.console ?? globalThis.console, add));
  }
  if (network) {
    restores.push(...patchFetch(browserWindow, add, ignored), ...patchXhr(browserWindow, add, ignored));
  }
  if (navigation) {
    restores.push(...patchNavigation(browserWindow, add));
  }
  return () => {
    const pending = restores.splice(FIRST_RESTORE);
    for (let restore = pending.pop(); restore !== undefined; restore = pending.pop()) {
      restore();
    }
  };
}

module.exports = { installBrowserBreadcrumbs };
