"use strict";

const MAX_MESSAGE_LENGTH = 512;
const MAX_URL_LENGTH = 256;
const CONSOLE_LEVELS = Object.freeze({
  debug: "debug",
  error: "error",
  info: "info",
  log: "info",
  warn: "warning"
});

// Records console calls, fetch and XHR requests, and route changes as issue breadcrumbs.
// Browser-safe and shared by @logbrew/browser and @logbrew/next/client. Returns an uninstall function
// that puts back every patched method it still owns.
function installBrowserBreadcrumbs(browserWindow, client, {
  console: captureConsole = true,
  ignoredUrls = [],
  navigation = true,
  network = true
} = {}) {
  const ignored = new Set(ignoredUrls.map((url) => sanitizeUrl(url, browserWindow)).filter(Boolean));
  const add = (breadcrumb) => {
    try {
      client.addBreadcrumb(breadcrumb);
    } catch {
      // Breadcrumbs are advisory and never reach application code.
    }
  };
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
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
  };
}

function patchConsole(target, add) {
  if (!target) {
    return [];
  }
  return Object.entries(CONSOLE_LEVELS).flatMap(([method, level]) => replaceMethod(target, method, (original) => (
    /** @this {Console} */
    function logBrewConsoleBreadcrumb(...args) {
      const message = boundedText(consoleTemplate(args), MAX_MESSAGE_LENGTH);
      if (message) {
        add({ type: "debug", category: "console", level, message });
      }
      return original.apply(this, args);
    }
  )));
}

function patchFetch(browserWindow, add, ignored) {
  return replaceMethod(browserWindow, "fetch", (original) => /** @this {*} */ async function logBrewFetchBreadcrumb(input, init) {
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    const url = sanitizeUrl(typeof input === "string" || input instanceof URL ? input : input?.url, browserWindow);
    try {
      const response = await original.call(this, input, init);
      if (!ignored.has(url)) {
        add(httpBreadcrumb("fetch", method, url, response?.status));
      }
      return response;
    } catch (error) {
      if (!ignored.has(url)) {
        add({ ...httpBreadcrumb("fetch", method, url), level: "error" });
      }
      throw error;
    }
  });
}

function patchXhr(browserWindow, add, ignored) {
  const prototype = browserWindow.XMLHttpRequest?.prototype;
  if (!prototype) {
    return [];
  }
  const state = new WeakMap();
  return [
    ...replaceMethod(prototype, "open", (original) => /** @this {XMLHttpRequest} */ function logBrewXhrOpen(method, url, ...rest) {
      state.set(this, { method: String(method ?? "GET").toUpperCase(), url: sanitizeUrl(url, browserWindow) });
      return original.call(this, method, url, ...rest);
    }),
    ...replaceMethod(prototype, "send", (original) => /** @this {XMLHttpRequest} */ function logBrewXhrSend(...args) {
      const request = state.get(this);
      if (request && !ignored.has(request.url) && typeof this.addEventListener === "function") {
        this.addEventListener("loadend", () => {
          add(httpBreadcrumb("xhr", request.method, request.url, this.status || undefined));
        });
      }
      return original.apply(this, args);
    })
  ];
}

function patchNavigation(browserWindow, add) {
  const history = browserWindow.history;
  if (!history) {
    return [];
  }
  let from = currentPath(browserWindow);
  const record = () => {
    const to = currentPath(browserWindow);
    if (to && to !== from) {
      add({ type: "navigation", category: "navigation", data: { ...(from ? { from } : {}), to } });
      from = to;
    }
  };
  const restores = ["pushState", "replaceState"].flatMap((method) => replaceMethod(history, method, (original) => (
    /** @this {History} */
    function logBrewNavigationBreadcrumb(...args) {
      const result = original.apply(this, args);
      record();
      return result;
    }
  )));
  if (typeof browserWindow.addEventListener === "function") {
    browserWindow.addEventListener("popstate", record);
    restores.push(() => browserWindow.removeEventListener?.("popstate", record));
  }
  return restores;
}

function replaceMethod(target, name, wrap) {
  const original = target?.[name];
  if (typeof original !== "function") {
    return [];
  }
  const replacement = wrap(original);
  target[name] = replacement;
  return [() => {
    if (target[name] === replacement) {
      target[name] = original;
    }
  }];
}

function httpBreadcrumb(category, method, url, status) {
  const statusCode = Number.isInteger(status) && status > 0 ? status : undefined;
  return {
    type: "http",
    category,
    level: statusCode === undefined || statusCode < 400 ? "info" : statusCode >= 500 ? "error" : "warning",
    data: {
      method: method.slice(0, 16) || "GET",
      ...(url ? { url } : {}),
      ...(statusCode === undefined ? {} : { status_code: statusCode })
    }
  };
}

// Records the message template, never the interpolated arguments.
function consoleTemplate(args) {
  const [first] = args;
  if (typeof first === "string") {
    return first;
  }
  return first instanceof Error ? first.name || "Error" : "";
}

function currentPath(browserWindow) {
  const pathname = browserWindow.location?.pathname;
  return typeof pathname === "string" ? boundedText(pathname, MAX_URL_LENGTH) : undefined;
}

// Keeps scheme, host, and path; drops user info, query, and fragment.
function sanitizeUrl(value, browserWindow) {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    const url = new URL(String(value), String(browserWindow.location?.href ?? "http://localhost/"));
    return boundedText(`${url.protocol}//${url.host}${url.pathname}`, MAX_URL_LENGTH) || undefined;
  } catch {
    return undefined;
  }
}

function boundedText(value, limit) {
  const characters = Array.from(String(value), (character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
  });
  return Array.from(characters.join("").replace(/\s+/gu, " ").trim()).slice(0, limit).join("");
}

module.exports = { installBrowserBreadcrumbs };
