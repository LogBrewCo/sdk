"use client";

const React = require("react");
const {
  LogBrewClient,
  SdkError,
  createIssueAttributesFromError,
  parseTraceparent
} = require("@logbrew/sdk");

const DEFAULT_ENDPOINT = "https://api.logbrew.co/v1/events";
// Browsers keep a 5-second interval to save battery and radio; pagehide flushes the rest.
const DEFAULT_BROWSER_DELIVERY_INTERVAL_MS = 5000;

function createLogBrewNextBrowserClient({
  apiKey,
  clientKey,
  context,
  deliveryIntervalMs = DEFAULT_BROWSER_DELIVERY_INTERVAL_MS,
  endpoint = DEFAULT_ENDPOINT,
  eventFilter,
  sdkName = "logbrew-next-client",
  sdkVersion = "0.1.9",
  maxQueueSize,
  maxRetries = 2,
  onEventDropped,
  transport
} = {}) {
  const authKey = clientKey ?? apiKey;
  if (!authKey) {
    throw new SdkError("configuration_error", "createLogBrewNextBrowserClient requires clientKey or apiKey");
  }
  return LogBrewClient.create({
    apiKey: authKey,
    context: withPublicDeployment(context),
    deliveryIntervalMs,
    eventFilter,
    maxQueueSize,
    maxRetries,
    onEventDropped,
    sdkName,
    sdkVersion,
    // Sends on its own; pass transport: null to keep the client manual.
    ...(transport === null ? {} : { transport: transport ?? createNextBrowserTransport(endpoint) })
  });
}

// Report an error from app/error.tsx or app/global-error.tsx, then deliver it.
function captureNextClientError(client, error, { digest, routeTemplate, flush = true } = {}) {
  const safeDigest = typeof digest === "string" && /^[a-zA-Z0-9._:-]{1,128}$/u.test(digest)
    ? digest
    : typeof error?.digest === "string" && /^[a-zA-Z0-9._:-]{1,128}$/u.test(error.digest) ? error.digest : undefined;
  const route = normalizeRouteTemplate(routeTemplate);
  client.issue(`evt_next_client_error_${randomHex(8)}`, new Date().toISOString(), createIssueAttributesFromError(error, {
    handled: false,
    mechanism: "nextjs.error_boundary",
    runtime: "browser",
    source: "nextjs.error_boundary",
    metadata: {
      framework: "nextjs",
      ...(safeDigest ? { errorDigest: safeDigest } : {}),
      ...(route ? { routeTemplate: route } : {})
    }
  }));
  return flush && client.transport ? client.flush().catch(() => undefined) : Promise.resolve(undefined);
}

// Report uncaught browser errors and unhandled rejections, and flush queued events on pagehide.
function installLogBrewNextClientErrorCapture({ client, browserWindow = globalThis.window } = {}) {
  if (!client || !browserWindow || typeof browserWindow.addEventListener !== "function") {
    throw new SdkError("configuration_error", "installLogBrewNextClientErrorCapture requires a client and a browser window");
  }
  const capture = (error, mechanism) => {
    try {
      client.issue(`evt_next_client_error_${randomHex(8)}`, new Date().toISOString(), createIssueAttributesFromError(error, {
        handled: false,
        mechanism,
        runtime: "browser",
        source: mechanism,
        metadata: { framework: "nextjs" }
      }));
    } catch {
      // Capture failures never reach the page.
    }
  };
  const listeners = {
    error: (event) => { capture(event?.error ?? event?.message ?? "Uncaught browser error", "nextjs.window_error"); },
    unhandledrejection: (event) => { capture(event?.reason, "nextjs.unhandled_rejection"); },
    pagehide: () => { void client.flush?.().catch(() => undefined); }
  };
  for (const [type, listener] of Object.entries(listeners)) {
    browserWindow.addEventListener(type, listener);
  }
  return {
    uninstall() {
      for (const [type, listener] of Object.entries(listeners)) {
        browserWindow.removeEventListener?.(type, listener);
      }
    }
  };
}

function createNextBrowserTransport(endpoint) {
  return {
    async send(apiKey, body) {
      const response = await globalThis.fetch(endpoint, {
        body,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        keepalive: body.length <= 60000,
        method: "POST"
      });
      return { statusCode: response.status, attempts: 1 };
    }
  };
}

// Next.js inlines NEXT_PUBLIC_* values at build time when they appear literally like this.
function withPublicDeployment(context) {
  let release;
  let environment;
  try {
    release = process.env.NEXT_PUBLIC_LOGBREW_RELEASE || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
    environment = process.env.NEXT_PUBLIC_LOGBREW_ENVIRONMENT || process.env.NEXT_PUBLIC_VERCEL_ENV;
  } catch {
    return context;
  }
  const deployment = {
    ...(boundedValue(environment) ? { environment: boundedValue(environment) } : {}),
    ...(boundedValue(release) ? { release: boundedValue(release) } : {})
  };
  if (Object.keys(deployment).length === 0) {
    return context;
  }
  if (context !== undefined && (context === null || typeof context !== "object" || context.schemaVersion !== 1)) {
    return context;
  }
  const resource = context?.resource ?? {};
  return {
    ...(context ?? { schemaVersion: 1 }),
    resource: { ...resource, deployment: { ...deployment, ...resource.deployment } }
  };
}

function boundedValue(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  const characters = Array.from(normalized);
  const hasControl = characters.some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
  return characters.length > 0 && characters.length <= 256 && !hasControl ? normalized : undefined;
}

function createNextRouteTemplate({
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

  return matches.sort(compareRouteSpecificity)[0];
}

function createNextNavigationSpanEvent({
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
        operation: "browser.navigation",
        routeTemplate: safeRouteTemplate,
        source: "next.client.route",
        ...metadata
      })
    }
  };
}

function captureNextNavigation(client, input = {}) {
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

function useLogBrewNextNavigation(options = {}) {
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
      const navigationKey = `${routeTemplate}|${pathnameOnly(options.pathname) ?? ""}`;
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

function normalizeRouteTemplate(value) {
  const pathname = pathnameOnly(value);
  if (!pathname) {
    return undefined;
  }
  const segments = pathname
    .split("/")
    .filter((segment) => segment && !(segment.startsWith("(") && segment.endsWith(")")) && !segment.startsWith("@"));
  if (segments.length === 0) {
    return "/";
  }
  return `/${segments.join("/")}`;
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
  if (/^[a-z][a-z0-9+.-]*:/iu.test(withoutQueryOrHash)) {
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

function defaultNextNavigationSpanId() {
  return `evt_next_route_${randomHex(8)}`;
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

const api = {
  captureNextClientError,
  captureNextNavigation,
  createLogBrewNextBrowserClient,
  createNextNavigationSpanEvent,
  createNextRouteTemplate,
  installLogBrewNextClientErrorCapture,
  useLogBrewNextNavigation
};

Object.assign(exports, api);
exports.default = api;
