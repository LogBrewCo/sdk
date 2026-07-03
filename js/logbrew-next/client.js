"use client";

import React from "react";
import {
  LogBrewClient,
  SdkError,
  parseTraceparent
} from "@logbrew/sdk";

const DEFAULT_SDK_NAME = "logbrew-next-client";
const DEFAULT_SDK_VERSION = "0.1.0";

export function createLogBrewNextBrowserClient({
  apiKey,
  clientKey,
  eventFilter,
  sdkName = DEFAULT_SDK_NAME,
  sdkVersion = DEFAULT_SDK_VERSION,
  maxQueueSize,
  maxRetries = 2,
  onEventDropped
} = {}) {
  const authKey = clientKey ?? apiKey;
  if (!authKey) {
    throw new SdkError("configuration_error", "createLogBrewNextBrowserClient requires clientKey or apiKey");
  }
  return LogBrewClient.create({
    apiKey: authKey,
    eventFilter,
    maxQueueSize,
    maxRetries,
    onEventDropped,
    sdkName,
    sdkVersion
  });
}

export function createNextRouteTemplate({
  pathname,
  routePatterns = [],
  routeTemplate
} = {}) {
  const safeRouteTemplate = normalizeRouteTemplate(routeTemplate);
  if (safeRouteTemplate) {
    return safeRouteTemplate;
  }

  const safePathname = pathnameOnly(pathname);
  if (!safePathname || !Array.isArray(routePatterns)) {
    return undefined;
  }

  const matches = routePatterns
    .map((pattern) => normalizeRouteTemplate(pattern))
    .filter((pattern) => pattern && routePatternMatchesPathname(pattern, safePathname));

  const matched = matches.sort(compareRouteSpecificity)[0];
  return matched;
}

export function createNextNavigationSpanEvent({
  durationMs,
  id,
  idFactory = defaultNextNavigationSpanId,
  metadata = {},
  navigationIndex,
  navigationType,
  now = () => new Date().toISOString(),
  parentSpanId,
  pathname,
  routePatterns,
  routeTemplate,
  spanId,
  spanIdFactory = defaultSpanIdFactory,
  status = "ok",
  timestamp,
  traceId,
  traceparent
} = {}) {
  const safeRouteTemplate = createNextRouteTemplate({ pathname, routePatterns, routeTemplate });
  if (!safeRouteTemplate) {
    return undefined;
  }
  const trace = traceContextFromInput({ parentSpanId, spanId, spanIdFactory, traceId, traceparent });
  return {
    id: id ?? idFactory({ navigationIndex, navigationType, routeTemplate: safeRouteTemplate }),
    timestamp: timestamp ?? now(),
    type: "span",
    attributes: {
      durationMs,
      name: `next.route ${safeRouteTemplate}`,
      parentSpanId: trace.parentSpanId,
      spanId: trace.spanId,
      status,
      traceId: trace.traceId,
      metadata: compactMetadata({
        framework: "nextjs",
        navigationIndex,
        navigationType,
        routeTemplate: safeRouteTemplate,
        source: "next.client.route",
        ...metadata
      })
    }
  };
}

export function captureNextNavigation(client, input = {}) {
  if (!client) {
    throw new SdkError("configuration_error", "captureNextNavigation requires a client");
  }
  const event = createNextNavigationSpanEvent(input);
  if (!event) {
    return undefined;
  }
  client.span(event.id, event.timestamp, event.attributes);
  return event;
}

export function useLogBrewNextNavigation(options = {}) {
  const lastNavigationKey = React.useRef(null);
  const navigationIndex = React.useRef(0);

  React.useEffect(() => {
    try {
      if (!options.client) {
        throw new SdkError("configuration_error", "useLogBrewNextNavigation requires client");
      }
      const routeTemplate = createNextRouteTemplate(options);
      if (!routeTemplate) {
        return;
      }
      const navigationKey = nextNavigationKey(options.pathname, routeTemplate);
      if (navigationKey === lastNavigationKey.current) {
        return;
      }
      lastNavigationKey.current = navigationKey;
      navigationIndex.current += 1;
      const event = captureNextNavigation(options.client, {
        ...options,
        navigationIndex: navigationIndex.current,
        routeTemplate
      });
      if (event && typeof options.onNavigation === "function") {
        options.onNavigation(event);
      }
    } catch (error) {
      if (typeof options.onCaptureError === "function") {
        options.onCaptureError(error);
        return;
      }
      throw error;
    }
  });
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

function traceContextFromInput({ parentSpanId, spanId, spanIdFactory, traceId, traceparent }) {
  if (typeof traceparent === "string") {
    const parsed = parseTraceparent(traceparent);
    return {
      parentSpanId: parentSpanId ?? parsed.parentSpanId,
      spanId: spanId ?? spanIdFactory(),
      traceId: traceId ?? parsed.traceId
    };
  }
  if (!traceId || !spanId) {
    throw new SdkError("configuration_error", "Next.js navigation requires traceparent or traceId and spanId");
  }
  return { parentSpanId, spanId, traceId };
}

function nextNavigationKey(pathname, routeTemplate) {
  return `${routeTemplate}|${pathnameOnly(pathname) ?? ""}`;
}

function normalizeRouteTemplate(value) {
  const pathname = pathnameOnly(value);
  if (!pathname) {
    return undefined;
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .filter((segment) => !isRouteGroupSegment(segment) && !segment.startsWith("@"));
  if (segments.length === 0) {
    return "/";
  }
  return `/${segments.join("/")}`;
}

function isRouteGroupSegment(segment) {
  return segment.startsWith("(") && segment.endsWith(")");
}

function pathnameOnly(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = String(value).trim();
  if (trimmed === "") {
    return undefined;
  }
  const withoutQueryOrHash = trimmed.split(/[?#]/u, 1)[0];
  let pathname = withoutQueryOrHash;
  if (hasUrlScheme(withoutQueryOrHash)) {
    try {
      pathname = new URL(withoutQueryOrHash).pathname;
    } catch {
      return undefined;
    }
  }
  if (!pathname.startsWith("/")) {
    pathname = `/${pathname}`;
  }
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function hasUrlScheme(url) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(url);
}

function routePatternMatchesPathname(routePattern, pathname) {
  const patternSegments = routePattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (patternSegments.length === 0) {
    return pathSegments.length === 0;
  }

  let pathIndex = 0;
  for (let patternIndex = 0; patternIndex < patternSegments.length; patternIndex += 1) {
    const segment = patternSegments[patternIndex];
    if (isOptionalCatchAllSegment(segment)) {
      return patternIndex === patternSegments.length - 1;
    }
    if (isCatchAllSegment(segment)) {
      return patternIndex === patternSegments.length - 1 && pathIndex < pathSegments.length;
    }
    if (pathIndex >= pathSegments.length) {
      return false;
    }
    if (isDynamicSegment(segment)) {
      pathIndex += 1;
      continue;
    }
    if (segment !== pathSegments[pathIndex]) {
      return false;
    }
    pathIndex += 1;
  }
  return pathIndex === pathSegments.length;
}

function compareRouteSpecificity(left, right) {
  const scoreDelta = routeSpecificityScore(left) - routeSpecificityScore(right);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return right.split("/").length - left.split("/").length;
}

function routeSpecificityScore(routePattern) {
  return routePattern
    .split("/")
    .filter(Boolean)
    .reduce((score, segment) => {
      if (isOptionalCatchAllSegment(segment)) {
        return score + 1000;
      }
      if (isCatchAllSegment(segment)) {
        return score + 100;
      }
      if (isDynamicSegment(segment)) {
        return score + 10;
      }
      return score;
    }, 0);
}

function isDynamicSegment(segment) {
  return /^\[[^[\]]+\]$/u.test(segment);
}

function isCatchAllSegment(segment) {
  return /^\[\.\.\.[^[\]]+\]$/u.test(segment);
}

function isOptionalCatchAllSegment(segment) {
  return /^\[\[\.\.\.[^[\]]+\]\]$/u.test(segment);
}

function defaultNextNavigationSpanId({ routeTemplate }) {
  return `evt_next_route_${slugify(routeTemplate ?? "route")}`;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

function defaultSpanIdFactory() {
  return randomHex(8);
}

function randomHex(bytes) {
  const randomValues = new Uint8Array(bytes);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(randomValues);
  } else {
    for (let index = 0; index < bytes; index += 1) {
      randomValues[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(randomValues, (value) => value.toString(16).padStart(2, "0")).join("");
}

const defaultExport = {
  captureNextNavigation,
  createLogBrewNextBrowserClient,
  createNextNavigationSpanEvent,
  createNextRouteTemplate,
  useLogBrewNextNavigation
};

export default defaultExport;
