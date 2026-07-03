"use strict";

const {
  createTraceparent,
  parseTraceparent,
  SdkError
} = require("@logbrew/sdk");

function createBrowserTraceparent({
  randomValues = defaultRandomValues,
  spanId,
  traceFlags = "01",
  traceId
} = {}) {
  return createTraceparent({
    spanId: spanId ?? randomHex(8, randomValues),
    traceFlags,
    traceId: traceId ?? randomHex(16, randomValues)
  });
}

function createBrowserTraceContext({
  randomValues = defaultRandomValues,
  sampled,
  spanId,
  traceFlags,
  traceId
} = {}) {
  return normalizeBrowserTraceContext(createBrowserTraceparent({
    randomValues,
    spanId,
    traceFlags: traceFlags ?? (sampled === false ? "00" : "01"),
    traceId
  }));
}

function createTraceparentFetch({
  fetchImpl = defaultFetch(),
  randomValues = defaultRandomValues,
  traceContext,
  traceFlags = "01",
  traceparent,
  traceparentFactory,
  tracePropagationTargets = []
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new SdkError("configuration_error", "createTraceparentFetch requires fetch");
  }
  if (!Array.isArray(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  if (traceparentFactory !== undefined && typeof traceparentFactory !== "function") {
    throw new SdkError("configuration_error", "traceparentFactory must be a function");
  }
  const fetchTraceContext = traceContextProvider(traceContext);

  return async function tracedFetch(input, init) {
    const url = requestUrl(input);
    if (!shouldPropagateTraceparent(url, tracePropagationTargets)) {
      return init === undefined ? fetchImpl(input) : fetchImpl(input, init);
    }

    const requestInit = init ?? {};
    const nextTraceparent = traceparentForRequest({
      init,
      input,
      randomValues,
      traceContext: fetchTraceContext(),
      traceFlags,
      traceparent,
      traceparentFactory,
      url
    });
    const nextInit = {
      ...requestInit,
      headers: headersWithTraceparent(requestHeaders(input, requestInit), nextTraceparent)
    };
    return fetchImpl(input, nextInit);
  };
}

function shouldPropagateTraceparent(url, tracePropagationTargets = []) {
  if (!Array.isArray(tracePropagationTargets)) {
    throw new SdkError("configuration_error", "tracePropagationTargets must be an array");
  }
  return tracePropagationTargets.some((target) => {
    if (typeof target === "string") {
      return shouldPropagateToStringTarget(url, target);
    }
    if (target instanceof RegExp) {
      target.lastIndex = 0;
      const matched = target.test(url);
      target.lastIndex = 0;
      return matched;
    }
    if (typeof target === "function") {
      return target(url) === true;
    }
    throw new SdkError("configuration_error", "tracePropagationTargets entries must be strings, RegExp values, or functions");
  });
}

function optionalBrowserTraceContext(traceContext) {
  if (traceContext === undefined || traceContext === false) {
    return undefined;
  }
  return normalizeBrowserTraceContext(traceContext);
}

function browserTraceMetadata(traceContext, { traceId } = {}) {
  if (traceContext === undefined && traceId === undefined) {
    return {};
  }
  return compactMetadata({
    spanId: traceContext?.spanId,
    traceId: traceId ?? traceContext?.traceId,
    traceSampled: traceContext?.sampled
  });
}

function normalizeBrowserTraceContext(traceContext) {
  if (typeof traceContext === "string") {
    return browserTraceContextFromParsed(parseTraceparent(traceContext));
  }
  if (!traceContext || Array.isArray(traceContext) || typeof traceContext !== "object") {
    throw new SdkError("configuration_error", "traceContext must be a traceparent string or trace context object");
  }
  if (typeof traceContext.traceparent === "string") {
    return browserTraceContextFromParsed(parseTraceparent(traceContext.traceparent));
  }
  const traceId = stringOrUndefined(traceContext.traceId);
  const spanId = stringOrUndefined(traceContext.spanId ?? traceContext.parentSpanId);
  if (traceId === undefined || spanId === undefined) {
    throw new SdkError("configuration_error", "traceContext requires traceId and spanId");
  }
  return browserTraceContextFromParsed(parseTraceparent(createTraceparent({
    spanId,
    traceFlags: typeof traceContext.traceFlags === "string"
      ? traceContext.traceFlags
      : traceContext.sampled === false ? "00" : "01",
    traceId
  })));
}

function browserTraceContextFromParsed(parsed) {
  return {
    sampled: parsed.sampled,
    spanId: parsed.parentSpanId,
    traceFlags: parsed.traceFlags,
    traceId: parsed.traceId
  };
}

function traceContextProvider(traceContext) {
  if (typeof traceContext === "function") {
    return () => optionalBrowserTraceContext(traceContext());
  }
  const fetchTraceContext = optionalBrowserTraceContext(traceContext);
  return () => fetchTraceContext;
}

function traceparentForRequest({
  init,
  input,
  randomValues,
  traceContext,
  traceFlags,
  traceparent,
  traceparentFactory,
  url
}) {
  const nextTraceparent = typeof traceparentFactory === "function"
    ? traceparentFactory({ init, input, url })
    : traceparent ?? traceparentFromBrowserTraceContext(traceContext) ?? createBrowserTraceparent({ randomValues, traceFlags });
  parseTraceparent(nextTraceparent);
  return nextTraceparent;
}

function traceparentFromBrowserTraceContext(traceContext) {
  return traceContext === undefined
    ? undefined
    : createTraceparent({
      spanId: traceContext.spanId,
      traceFlags: traceContext.traceFlags,
      traceId: traceContext.traceId
    });
}

function headersWithTraceparent(headers, traceparent) {
  const nextHeaders = {};
  for (const [key, value] of headerEntries(headers)) {
    if (String(key).toLowerCase() !== "traceparent") {
      nextHeaders[key] = value;
    }
  }
  nextHeaders.traceparent = traceparent;
  return nextHeaders;
}

function headerEntries(headers) {
  if (headers === undefined || headers === null) {
    return [];
  }
  const HeadersConstructor = globalThis.Headers;
  if (typeof HeadersConstructor === "function" && headers instanceof HeadersConstructor) {
    const entries = [];
    headers.forEach((value, key) => {
      entries.push([key, value]);
    });
    return entries;
  }
  if (Array.isArray(headers)) {
    return headers;
  }
  if (typeof headers[Symbol.iterator] === "function") {
    return Array.from(headers);
  }
  if (typeof headers === "object") {
    return Object.entries(headers);
  }
  return [];
}

function requestHeaders(input, init) {
  if (init && init.headers !== undefined) {
    return init.headers;
  }
  return input?.headers;
}

function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input?.url === "string") {
    return input.url;
  }
  return String(input);
}

function randomHex(length, randomValues) {
  if (typeof randomValues !== "function") {
    throw new SdkError("configuration_error", "randomValues must be a function");
  }
  const bytes = Array.from(randomValues(length));
  if (bytes.length !== length || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new SdkError("configuration_error", "randomValues must return byte values for the requested length");
  }
  return bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
}

function shouldPropagateToStringTarget(url, target) {
  const targetText = target.trim();
  if (targetText === "") {
    return false;
  }
  if (targetText.startsWith("/")) {
    return url.startsWith(targetText);
  }

  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor === "function") {
    try {
      const targetUrl = new URLConstructor(targetText);
      if (!hasUrlScheme(url)) {
        return false;
      }
      const requestUrlValue = new URLConstructor(url, targetUrl.origin);
      if (requestUrlValue.origin !== targetUrl.origin) {
        return false;
      }
      const targetPath = targetUrl.pathname || "/";
      return requestUrlValue.pathname === targetPath || requestUrlValue.pathname.startsWith(pathPrefix(targetPath));
    } catch {
      return url.startsWith(targetText);
    }
  }

  return url.startsWith(targetText);
}

function pathPrefix(pathname) {
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function hasUrlScheme(url) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(url);
}

function defaultFetch() {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

function defaultRandomValues(length) {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new SdkError("configuration_error", "createBrowserTraceparent requires crypto.getRandomValues or randomValues");
  }
  const bytes = new Uint8Array(length);
  return globalThis.crypto.getRandomValues(bytes);
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function compactMetadata(metadata) {
  const compacted = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      compacted[key] = value;
    }
  }
  return compacted;
}

module.exports = {
  browserTraceMetadata,
  createBrowserTraceContext,
  createBrowserTraceparent,
  createTraceparentFetch,
  optionalBrowserTraceContext,
  shouldPropagateTraceparent
};
