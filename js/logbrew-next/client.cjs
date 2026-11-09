"use client";

const React = require("react");
const {
  LogBrewClient,
  SdkError,
  createIssueAttributesFromError,
  installBrowserBreadcrumbs,
  parseTraceparent
} = require("@logbrew/sdk");

const DEFAULT_ENDPOINT = "https://api.logbrew.co/v1/events";
// Send 1 second after the first queued event; pagehide flushes the rest when the page closes.
const DEFAULT_BROWSER_DELIVERY_INTERVAL_MS = 1000;
const clientEndpoints = new WeakMap();
// The first route template each client's navigation hook saw: the route the page loaded on.
const landingRouteTemplates = new WeakMap();
// Good and poor limits from https://web.dev/articles/vitals.
const WEB_VITALS = {
  cls: { description: "Cumulative Layout Shift of one page load.", good: 0.1, poor: 0.25, unit: "1" },
  fcp: { description: "First Contentful Paint of one page load.", good: 1800, poor: 3000, unit: "ms" },
  inp: { description: "Interaction to Next Paint of one page load.", good: 200, poor: 500, unit: "ms" },
  lcp: { description: "Largest Contentful Paint of one page load.", good: 2500, poor: 4000, unit: "ms" },
  ttfb: { description: "Time to First Byte of one page load.", good: 800, poor: 1800, unit: "ms" }
};

function createLogBrewNextBrowserClient({
  apiKey,
  clientKey,
  context,
  deliveryIntervalMs = DEFAULT_BROWSER_DELIVERY_INTERVAL_MS,
  endpoint = DEFAULT_ENDPOINT,
  eventFilter,
  sdkName = "logbrew-next-client",
  sdkVersion = "0.1.18",
  maxQueueSize,
  maxRetries = 2,
  onEventDropped,
  transport
} = {}) {
  const authKey = clientKey ?? apiKey;
  if (!authKey) {
    throw new SdkError("configuration_error", "createLogBrewNextBrowserClient requires clientKey or apiKey");
  }
  const deploymentContext = withPublicDeployment(context);
  const client = LogBrewClient.create({
    apiKey: authKey,
    context: deploymentContext,
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
  clientEndpoints.set(client, endpoint);
  return client;
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
// Console, fetch, XHR, and route-change breadcrumbs ride along with each issue; breadcrumbs: false turns them off.
// Web Vitals go out as metrics when the page is first hidden; webVitals: false turns them off.
function installLogBrewNextClientErrorCapture({ breadcrumbs = true, browserWindow = globalThis.window, client, webVitals = true } = {}) {
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
  const uninstallBreadcrumbs = breadcrumbs === false
    ? () => undefined
    : installBrowserBreadcrumbs(browserWindow, client, { ignoredUrls: [clientEndpoints.get(client) ?? DEFAULT_ENDPOINT] });
  const uninstallWebVitals = webVitals === false ? () => undefined : installWebVitals(browserWindow, client);
  return {
    uninstall() {
      uninstallBreadcrumbs();
      uninstallWebVitals();
      for (const [type, listener] of Object.entries(listeners)) {
        browserWindow.removeEventListener?.(type, listener);
      }
    }
  };
}

// Observe the page's performance entries the way https://github.com/GoogleChrome/web-vitals does,
// without the library, and record each Web Vital once, when the page is first hidden.
function installWebVitals(browserWindow, client) {
  const { PerformanceObserver: Observer, document, performance } = browserWindow;
  if (typeof Observer !== "function" || !document || typeof document.addEventListener !== "function") {
    return () => undefined;
  }
  const navigation = performance?.getEntriesByType?.("navigation")?.[0];
  const sinceActivation = (time) => Math.max(time - (navigation?.activationStart ?? 0), 0);
  const values = {};
  const layoutShift = { first: 0, last: 0, session: 0 };
  const interactions = new Map();
  const observers = [];
  const observe = (type, onEntry, options) => {
    try {
      const observer = new Observer((list) => { list.getEntries().forEach(onEntry); });
      observer.observe({ type, buffered: true, ...options });
      observers.push([observer, onEntry]);
      return true;
    } catch {
      return false;
    }
  };
  if (navigation?.responseStart > 0) {
    values.ttfb = sinceActivation(navigation.responseStart);
  }
  // A page that loads in the background has no meaningful paint timings.
  if (document.visibilityState !== "hidden") {
    observe("paint", (entry) => {
      if (entry.name === "first-contentful-paint") {
        values.fcp = sinceActivation(entry.startTime);
      }
    });
    observe("largest-contentful-paint", (entry) => { values.lcp = sinceActivation(entry.startTime); });
  }
  // CLS is the largest session window: shifts less than 1 s apart, at most 5 s long.
  if (observe("layout-shift", (entry) => {
    if (entry.hadRecentInput) {
      return;
    }
    if (layoutShift.session > 0 && (entry.startTime - layoutShift.last >= 1000 || entry.startTime - layoutShift.first >= 5000)) {
      layoutShift.session = 0;
    }
    if (layoutShift.session === 0) {
      layoutShift.first = entry.startTime;
    }
    layoutShift.session += entry.value;
    layoutShift.last = entry.startTime;
    values.cls = Math.max(values.cls ?? 0, layoutShift.session);
  })) {
    values.cls = 0;
  }
  observe("event", (entry) => {
    if (entry.interactionId > 0) {
      interactions.set(entry.interactionId, Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration));
    }
  }, { durationThreshold: 40 });

  let reported = false;
  const report = (event) => {
    if (reported || (document.visibilityState !== "hidden" && event?.type !== "pagehide")) {
      return;
    }
    reported = true;
    uninstall();
    // INP skips 1 slowest interaction per 50, as the web-vitals library does.
    const durations = [...interactions.values()].sort((left, right) => right - left);
    if (durations.length > 0) {
      const interactionCount = performance?.interactionCount ?? durations.length;
      values.inp = durations[Math.min(durations.length - 1, Math.floor(interactionCount / 50))];
    }
    const routeTemplate = landingRouteTemplates.get(client);
    for (const [vital, rawValue] of Object.entries(values)) {
      const { description, good, poor, unit } = WEB_VITALS[vital];
      const value = vital === "cls" ? Number(rawValue.toFixed(4)) : Math.round(rawValue);
      try {
        client.metric(`evt_next_web_vital_${randomHex(8)}`, new Date().toISOString(), {
          description,
          kind: "histogram",
          metadata: compactMetadata({
            framework: "nextjs",
            navigationType: navigation?.type,
            rating: value <= good ? "good" : value <= poor ? "needs-improvement" : "poor",
            routeTemplate
          }),
          name: `browser.web_vital.${vital}`,
          temporality: "delta",
          unit,
          value
        });
      } catch {
        // Capture failures never reach the page.
      }
    }
    void client.flush?.().catch(() => undefined);
  };
  document.addEventListener("visibilitychange", report);
  browserWindow.addEventListener("pagehide", report);
  function uninstall() {
    for (const [observer, onEntry] of observers) {
      observer.takeRecords?.().forEach(onEntry);
      observer.disconnect();
    }
    observers.length = 0;
    document.removeEventListener?.("visibilitychange", report);
    browserWindow.removeEventListener?.("pagehide", report);
  }
  return uninstall;
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
        analyticsKind: "page_view",
        analyticsSchemaVersion: 1,
        analyticsSurface: safeRouteTemplate,
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
  if (!landingRouteTemplates.has(client)) {
    landingRouteTemplates.set(client, event.attributes.metadata.routeTemplate);
  }
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
      // Telemetry never breaks the page: report the failure to the app if it asked, then drop the event.
      if (typeof options.onCaptureError === "function") {
        options.onCaptureError(error);
      }
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
  const parsed = typeof traceparent === "string" ? parseTraceparent(traceparent) : undefined;
  return {
    parentSpanId: parentSpanId ?? parsed?.parentSpanId,
    spanId: spanId ?? spanIdFactory(),
    traceId: traceId ?? parsed?.traceId ?? randomHex(16)
  };
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
