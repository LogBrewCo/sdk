const { recordIssueBreadcrumb } = require("./index-breadcrumbs.cjs");
const { defaultEventId } = require("./index-random.cjs");
const {
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  getActiveLogBrewTrace,
  resolveTraceContext
} = require("./index-trace.cjs");
const {
  getReactNativeContext,
  requireClient,
  spanStatusFromStatusCode,
  stripQueryAndHash,
  textOf
} = require("./index-values.cjs");

/**
 * @import { ClientLike, ContextOptions } from "./index-values.cjs"
 * @typedef {ContextOptions & {
 *   readonly actionType?: unknown,
 *   readonly durationMs?: unknown,
 *   readonly id?: string | undefined,
 *   readonly idFactory?: (context: { readonly routeName: string | undefined, readonly routePath: string | undefined, readonly screen: string | undefined }) => string,
 *   readonly includeRouteKey?: boolean | undefined,
 *   readonly name?: unknown,
 *   readonly now?: () => string,
 *   readonly previousRouteKey?: unknown,
 *   readonly previousRouteName?: unknown,
 *   readonly routeKey?: unknown,
 *   readonly routeName?: string | undefined,
 *   readonly routePath?: unknown,
 *   readonly screen?: string | undefined,
 *   readonly status?: unknown,
 *   readonly timestamp?: string | undefined,
 *   readonly trace?: unknown
 * }} NavigationSpanInput
 * @typedef {ContextOptions & {
 *   readonly durationMs?: unknown,
 *   readonly id?: string | undefined,
 *   readonly idFactory?: (context: { readonly method: string | undefined, readonly routeTemplate: string | undefined, readonly screen: unknown }) => string,
 *   readonly kind?: unknown,
 *   readonly method?: unknown,
 *   readonly name?: unknown,
 *   readonly now?: () => string,
 *   readonly responseSizeBytes?: unknown,
 *   readonly routeTemplate?: unknown,
 *   readonly screen?: unknown,
 *   readonly sessionId?: unknown,
 *   readonly status?: unknown,
 *   readonly statusCode?: unknown,
 *   readonly timestamp?: string | undefined,
 *   readonly trace?: unknown
 * }} ResourceSpanInput
 * @typedef {{ readonly id: string, readonly timestamp: string, readonly attributes: Record<string, unknown> }} SpanEvent
 */

/**
 * @returns {string}
 */
function currentTimestamp() {
  return new Date().toISOString();
}

/**
 * @returns {string}
 */
function defaultNavigationSpanEventId() {
  return defaultEventId("navigation");
}

/**
 * @returns {string}
 */
function defaultResourceSpanEventId() {
  return defaultEventId("resource");
}

/**
 * @param {NavigationSpanInput} [input]
 * @returns {SpanEvent}
 */
function createReactNativeNavigationSpanEvent({
  actionType, durationMs, id, idFactory = defaultNavigationSpanEventId, includeRouteKey = false, metadata = {},
  name, now = currentTimestamp, platform, appState, previousRouteKey, previousRouteName,
  routeKey, routeName, routePath, screen, status = "ok", timestamp, trace
} = {}) {
  const safeRoutePath = stripQueryAndHash(routePath);
  const spanName = name ?? `navigation:${routeName ?? safeRoutePath ?? screen ?? "route"}`;
  const context = resolveTraceContext(trace) ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext();
  return {
    id: id ?? idFactory({ routeName, routePath: safeRoutePath, screen }),
    timestamp: timestamp ?? now(),

    attributes: createReactNativeSpanAttributes({
      name: spanName,
      status,

      durationMs,
      trace: context,

      metadata: {
        ...getReactNativeContext({ appState, platform }),
        source: "react-native.navigation",

        actionType,
        previousRouteName,
        routeName,
        routePath: safeRoutePath,
        screen: screen ?? routeName,
        ...(includeRouteKey ? { previousRouteKey, routeKey } : {}),
        ...metadata
      }
    })
  };
}

/**
 * @param {ClientLike} client
 * @param {NavigationSpanInput} [input]
 * @returns {SpanEvent}
 */
function captureReactNativeNavigationSpan(client, input = {}) {
  requireClient(client);
  const event = createReactNativeNavigationSpanEvent(input);
  client.span(event.id, event.timestamp, event.attributes);
  recordIssueBreadcrumb(client, event, { category: "navigation", type: "navigation" });
  return event;
}

/**
 * @param {ResourceSpanInput} [input]
 * @returns {SpanEvent}
 */
function createReactNativeResourceSpanEvent({
  durationMs, id, idFactory = defaultResourceSpanEventId, kind = "fetch", metadata = {}, method, name,
  now = currentTimestamp, platform, appState, responseSizeBytes, routeTemplate, screen,
  sessionId, status, statusCode, timestamp, trace
} = {}) {
  const safeRouteTemplate = stripQueryAndHash(routeTemplate);
  const safeMethod = method === undefined ? undefined : textOf(method).toUpperCase();
  const defaultName = [safeMethod, safeRouteTemplate].filter(Boolean).join(" ");
  const spanName = name ?? (defaultName || "mobile.resource");
  const context = resolveTraceContext(trace) ?? getActiveLogBrewTrace() ?? createReactNativeTraceContext();
  return {
    id: id ?? idFactory({ method: safeMethod, routeTemplate: safeRouteTemplate, screen }),
    timestamp: timestamp ?? now(),

    attributes: createReactNativeSpanAttributes({
      name: spanName,
      status: status ?? spanStatusFromStatusCode(statusCode),

      durationMs,
      trace: context,

      metadata: {
        ...getReactNativeContext({ appState, platform }),
        source: "react-native.resource",

        durationMs,
        method: safeMethod,
        resourceKind: kind,
        responseSizeBytes,
        routeTemplate: safeRouteTemplate,
        screen,
        sessionId,
        statusCode,
        ...metadata
      }
    })
  };
}

/**
 * @param {ClientLike} client
 * @param {ResourceSpanInput} [input]
 * @returns {SpanEvent}
 */
function captureReactNativeResourceSpan(client, input = {}) {
  requireClient(client);
  const event = createReactNativeResourceSpanEvent(input);
  client.span(event.id, event.timestamp, event.attributes);
  return event;
}

module.exports = {
  captureReactNativeNavigationSpan,
  captureReactNativeResourceSpan,
  createReactNativeNavigationSpanEvent,
  createReactNativeResourceSpanEvent
};
