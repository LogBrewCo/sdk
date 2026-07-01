const DEFAULT_OTEL_SPAN_ATTRIBUTE_KEYS = new Set([
  "db.operation.name",
  "db.system",
  "faas.trigger",
  "graphql.operation.name",
  "graphql.operation.type",
  "http.method",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "http.status_code",
  "messaging.operation.name",
  "messaging.system",
  "rpc.method",
  "rpc.service",
  "rpc.system"
]);
const DEFAULT_OTEL_RESOURCE_ATTRIBUTE_KEYS = new Set([
  "deployment.environment",
  "deployment.environment.name",
  "service.name",
  "service.version",
  "telemetry.sdk.language",
  "telemetry.sdk.name",
  "telemetry.sdk.version"
]);
const DEFAULT_OTEL_EVENT_ATTRIBUTE_KEYS = new Set([
  "exception.escaped",
  "exception.type"
]);
const DEFAULT_OTEL_LINK_ATTRIBUTE_KEYS = new Set();
const OTEL_SPAN_KIND_NAMES = new Map([
  [0, "internal"],
  [1, "server"],
  [2, "client"],
  [3, "producer"],
  [4, "consumer"]
]);
const OTEL_STATUS_CODE_ERROR = 2;
const ZERO_SPAN_ID = "0000000000000000";
const SENSITIVE_OTEL_ATTRIBUTE_KEYS = new Set([
  "code.stacktrace",
  "db.statement",
  "exception.message",
  "exception.stacktrace",
  "http.request.body",
  "http.response.body",
  "http.url",
  "url.full"
]);
const SENSITIVE_OTEL_ATTRIBUTE_PREFIXES = [
  "http.request.header.",
  "http.response.header."
];
const SENSITIVE_OTEL_ATTRIBUTE_PATTERN = /(^|[._-])(authorization|body|cookie|credential|fragment|header|headers|payload|password|passwd|private[-_]?key|query|secret|stack|stacktrace|token)([._-]|$)/iu;

function buildOpenTelemetryHelpers({
  compactMetadata,
  isMetadataValue,
  LogBrewClient,
  maxSpanEvents,
  maxSpanLinks,
  requireNonEmpty,
  requireSpanId,
  requireTraceId,
  SdkError,
  stringOrUndefined
}) {
  function logbrewTraceContextFromOpenTelemetrySpanContext(spanContext, options = {}) {
    const context = normalizeOpenTelemetrySpanContext(spanContext);
    if (!context) {
      return null;
    }
    return {
      traceId: context.traceId,
      spanId: resolveLogBrewChildSpanId(options),
      parentSpanId: context.parentSpanId,
      sampled: context.sampled
    };
  }

  function logbrewTraceContextFromOpenTelemetrySpan(span, options = {}) {
    if (!span || typeof span !== "object") {
      return null;
    }
    const getSpanContext = typeof span.spanContext === "function"
      ? span.spanContext
      : span.getSpanContext;
    if (typeof getSpanContext !== "function") {
      return null;
    }
    let spanContext;
    try {
      spanContext = getSpanContext.call(span);
    } catch {
      return null;
    }
    return logbrewTraceContextFromOpenTelemetrySpanContext(spanContext, options);
  }

  function logbrewTraceContextFromCurrentOpenTelemetrySpan(options = {}) {
    const openTelemetryApi = options?.openTelemetryApi ?? optionalOpenTelemetryApi();
    const getActiveSpan = openTelemetryApi?.trace?.getActiveSpan;
    if (typeof getActiveSpan !== "function") {
      return null;
    }
    let activeSpan;
    try {
      activeSpan = getActiveSpan.call(openTelemetryApi.trace);
    } catch {
      return null;
    }
    return logbrewTraceContextFromOpenTelemetrySpan(activeSpan, options);
  }

  function spanAttributesFromOpenTelemetryReadableSpan(span, options = {}) {
    return spanAttributesFromResolvedOpenTelemetryReadableSpan(
      span,
      resolveOpenTelemetryReadableSpanOptions(options)
    );
  }

  function createLogBrewOpenTelemetrySpanProcessor(config) {
    if (!config || Array.isArray(config) || typeof config !== "object") {
      throw new SdkError("validation_error", "OpenTelemetry span processor config must be an object");
    }
    const client = config.client;
    if (!(client instanceof LogBrewClient)) {
      throw new SdkError("validation_error", "OpenTelemetry span processor client must be a LogBrewClient");
    }
    const eventIdPrefix = config.eventIdPrefix ?? "otel";
    requireNonEmpty("OpenTelemetry eventIdPrefix", eventIdPrefix);
    const transport = config.transport;
    const timestamp = typeof config.timestamp === "function"
      ? config.timestamp
      : undefined;
    const onError = typeof config.onError === "function" ? config.onError : () => {};
    const spanFilter = typeof config.spanFilter === "function" ? config.spanFilter : null;
    const flushOnForceFlush = config.flushOnForceFlush !== false;
    const resolvedOptions = resolveOpenTelemetryReadableSpanOptions(config);
    const state = {
      captured: 0,
      closed: false,
      flushInFlight: false,
      pendingFlush: Promise.resolve(null)
    };

    return {
      onStart() {},
      onEnd(span) {
        if (state.closed) {
          return;
        }
        try {
          if (spanFilter && spanFilter(span) === false) {
            return;
          }
          const attributes = spanAttributesFromResolvedOpenTelemetryReadableSpan(span, resolvedOptions);
          if (!attributes) {
            return;
          }
          state.captured += 1;
          client.span(
            `${eventIdPrefix}_${state.captured}`,
            timestampFromOpenTelemetryReadableSpan(span, timestamp),
            attributes
          );
        } catch (error) {
          onError(error);
        }
      },
      async forceFlush() {
        await flushOpenTelemetryProcessorQueue({
          client,
          flushOnForceFlush,
          onError,
          state,
          transport
        });
      },
      async shutdown() {
        state.closed = true;
        await flushOpenTelemetryProcessorQueue({
          client,
          flushOnForceFlush,
          onError,
          state,
          transport
        });
      }
    };
  }

  function spanAttributesFromResolvedOpenTelemetryReadableSpan(span, options) {
    if (!span || Array.isArray(span) || typeof span !== "object") {
      return null;
    }
    const context = normalizeOpenTelemetryReadableSpanContext(span);
    if (!context) {
      return null;
    }
    if (!options.captureUnsampled && context.sampled === false) {
      return null;
    }

    const metadata = openTelemetryReadableSpanMetadata(span, options);
    const events = options.includeSpanEvents
      ? openTelemetryReadableSpanEvents(span.events, options)
      : undefined;
    const links = options.includeSpanLinks
      ? openTelemetryReadableSpanLinks(span.links, options)
      : undefined;
    const durationMs = durationMsFromOpenTelemetryReadableSpan(span);

    return {
      name: openTelemetrySpanName(span),
      traceId: context.traceId,
      spanId: context.spanId,
      ...(context.parentSpanId !== undefined ? { parentSpanId: context.parentSpanId } : {}),
      status: openTelemetrySpanStatus(span.status),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(events !== undefined ? { events } : {}),
      ...(links !== undefined ? { links } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {})
    };
  }

  function resolveOpenTelemetryReadableSpanOptions(options = {}) {
    return {
      attributeKeys: openTelemetryAttributeKeySet(
        DEFAULT_OTEL_SPAN_ATTRIBUTE_KEYS,
        options.attributeKeys,
        "OpenTelemetry attributeKeys"
      ),
      captureUnsampled: options.captureUnsampled === true,
      eventAttributeKeys: openTelemetryAttributeKeySet(
        DEFAULT_OTEL_EVENT_ATTRIBUTE_KEYS,
        options.eventAttributeKeys,
        "OpenTelemetry eventAttributeKeys"
      ),
      includeSpanEvents: options.includeSpanEvents !== false,
      includeSpanLinks: options.includeSpanLinks !== false,
      linkAttributeKeys: openTelemetryAttributeKeySet(
        DEFAULT_OTEL_LINK_ATTRIBUTE_KEYS,
        options.linkAttributeKeys,
        "OpenTelemetry linkAttributeKeys"
      ),
      metadata: compactMetadata(options.metadata),
      resourceAttributeKeys: openTelemetryAttributeKeySet(
        DEFAULT_OTEL_RESOURCE_ATTRIBUTE_KEYS,
        options.resourceAttributeKeys,
        "OpenTelemetry resourceAttributeKeys"
      )
    };
  }

  function openTelemetryAttributeKeySet(defaultKeys, extraKeys, label) {
    const allowedKeys = new Set(defaultKeys);
    if (extraKeys === undefined) {
      return allowedKeys;
    }
    if (!Array.isArray(extraKeys)) {
      throw new SdkError("validation_error", `${label} must be an array`);
    }
    for (const key of extraKeys) {
      requireNonEmpty(label, key);
      if (isSensitiveOpenTelemetryAttributeKey(key)) {
        throw new SdkError("validation_error", `${label} cannot include sensitive key: ${key}`);
      }
      allowedKeys.add(key);
    }
    return allowedKeys;
  }

  function normalizeOpenTelemetrySpanContext(spanContext) {
    const context = normalizeOpenTelemetrySpanContextIds(spanContext);
    if (!context) {
      return null;
    }
    return {
      traceId: context.traceId,
      parentSpanId: context.spanId,
      sampled: context.sampled
    };
  }

  function normalizeOpenTelemetryReadableSpanContext(span) {
    const context = normalizeOpenTelemetrySpanContextIds(readOpenTelemetrySpanContext(span));
    if (!context) {
      return null;
    }
    const parentContext = normalizeOpenTelemetrySpanContextIds(span.parentSpanContext);
    const parentSpanId = parentContext?.traceId === context.traceId
      ? parentContext.spanId
      : normalizeSpanId(span.parentSpanId);
    return {
      traceId: context.traceId,
      spanId: context.spanId,
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      sampled: context.sampled
    };
  }

  function normalizeOpenTelemetrySpanContextIds(spanContext) {
    if (!spanContext || typeof spanContext !== "object" || spanContext.isValid === false) {
      return null;
    }
    const traceId = normalizeTraceId(spanContext.traceId);
    const spanId = normalizeSpanId(spanContext.spanId);
    if (!traceId || !spanId) {
      return null;
    }
    return {
      traceId,
      spanId,
      sampled: openTelemetryTraceFlagsSampled(spanContext.traceFlags)
    };
  }

  function normalizeTraceId(traceId) {
    try {
      requireTraceId(traceId);
    } catch {
      return undefined;
    }
    return traceId.toLowerCase();
  }

  function normalizeSpanId(spanId) {
    try {
      requireSpanId("trace spanId", spanId);
    } catch {
      return undefined;
    }
    return spanId.toLowerCase();
  }

  function resolveLogBrewChildSpanId(options = {}) {
    if (options.spanId !== undefined) {
      requireSpanId("spanId", options.spanId);
      return options.spanId.toLowerCase();
    }
    const spanIdFactory = typeof options.spanIdFactory === "function"
      ? options.spanIdFactory
      : defaultSpanIdFactory;
    const spanId = spanIdFactory();
    requireSpanId("spanId", spanId);
    return spanId.toLowerCase();
  }

  function defaultSpanIdFactory() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const spanId = randomHex(8);
      if (spanId !== ZERO_SPAN_ID) {
        return spanId;
      }
    }
    throw new SdkError("configuration_error", "spanIdFactory must return a non-zero 16-character hex span id");
  }

  function readOpenTelemetrySpanContext(span) {
    if (typeof span.spanContext !== "function") {
      return null;
    }
    try {
      return span.spanContext();
    } catch {
      return null;
    }
  }

  function openTelemetryTraceFlagsSampled(traceFlags) {
    const sampled = traceFlags?.sampled;
    if (typeof sampled === "boolean") {
      return sampled;
    }
    if (typeof traceFlags === "number" && Number.isFinite(traceFlags)) {
      return (traceFlags & 1) === 1;
    }
    return false;
  }

  function randomHex(byteLength) {
    const bytes = new Uint8Array(byteLength);
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function openTelemetrySpanName(span) {
    return typeof span.name === "string" && span.name.trim() !== ""
      ? span.name
      : "opentelemetry.span";
  }

  function openTelemetrySpanStatus(status) {
    if (status?.code === OTEL_STATUS_CODE_ERROR || status?.code === "ERROR") {
      return "error";
    }
    return "ok";
  }

  function openTelemetryReadableSpanMetadata(span, options) {
    const metadata = {
      source: "opentelemetry.readable_span",
      ...options.metadata,
      ...openTelemetrySelectedMetadata(span.resource?.attributes, options.resourceAttributeKeys)
    };
    const kind = openTelemetrySpanKindName(span.kind);
    if (kind) {
      metadata["otel.kind"] = kind;
    }
    const scopeName = stringOrUndefined(span.instrumentationScope?.name);
    if (scopeName) {
      metadata["otel.scope.name"] = scopeName;
    }
    const scopeVersion = stringOrUndefined(span.instrumentationScope?.version);
    if (scopeVersion) {
      metadata["otel.scope.version"] = scopeVersion;
    }
    addPositiveOpenTelemetryCount(metadata, "otel.dropped_attributes_count", span.droppedAttributesCount);
    addPositiveOpenTelemetryCount(metadata, "otel.dropped_events_count", span.droppedEventsCount);
    addPositiveOpenTelemetryCount(metadata, "otel.dropped_links_count", span.droppedLinksCount);
    return {
      ...metadata,
      ...openTelemetrySelectedMetadata(span.attributes, options.attributeKeys)
    };
  }

  function openTelemetrySelectedMetadata(attributes, allowedKeys) {
    const metadata = {};
    if (!attributes || Array.isArray(attributes) || typeof attributes !== "object") {
      return metadata;
    }
    for (const [key, value] of Object.entries(attributes)) {
      if (allowedKeys.has(key) && !isSensitiveOpenTelemetryAttributeKey(key) && isMetadataValue(value)) {
        metadata[key] = value;
      }
    }
    return metadata;
  }

  function openTelemetryReadableSpanEvents(events, options) {
    if (!Array.isArray(events) || events.length === 0) {
      return undefined;
    }
    const summaries = [];
    for (const event of events.slice(0, maxSpanEvents)) {
      if (!event || Array.isArray(event) || typeof event !== "object") {
        continue;
      }
      const name = typeof event.name === "string" && event.name.trim() !== ""
        ? event.name
        : "opentelemetry.event";
      const timestamp = timestampFromOpenTelemetryTime(event.time ?? event.timestamp);
      const metadata = openTelemetrySelectedMetadata(event.attributes, options.eventAttributeKeys);
      summaries.push({
        name,
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {})
      });
    }
    return summaries.length > 0 ? summaries : undefined;
  }

  function openTelemetryReadableSpanLinks(links, options) {
    if (!Array.isArray(links) || links.length === 0) {
      return undefined;
    }
    const summaries = [];
    for (const link of links.slice(0, maxSpanLinks)) {
      const context = normalizeOpenTelemetrySpanContextIds(link?.context ?? link?.spanContext);
      if (!context) {
        continue;
      }
      const metadata = openTelemetrySelectedMetadata(link.attributes, options.linkAttributeKeys);
      summaries.push({
        traceId: context.traceId,
        spanId: context.spanId,
        sampled: context.sampled,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {})
      });
    }
    return summaries.length > 0 ? summaries : undefined;
  }

  function openTelemetrySpanKindName(kind) {
    if (typeof kind === "number") {
      return OTEL_SPAN_KIND_NAMES.get(kind);
    }
    if (typeof kind === "string" && kind.trim() !== "") {
      return kind.toLowerCase();
    }
    return undefined;
  }

  function addPositiveOpenTelemetryCount(metadata, key, value) {
    if (Number.isSafeInteger(value) && value > 0) {
      metadata[key] = value;
    }
  }

  function durationMsFromOpenTelemetryReadableSpan(span) {
    const durationMs = openTelemetryDurationMs(span.duration);
    if (durationMs !== undefined) {
      return durationMs;
    }
    const startMs = openTelemetryTimeMs(span.startTime);
    const endMs = openTelemetryTimeMs(span.endTime);
    if (startMs !== undefined && endMs !== undefined && endMs >= startMs) {
      return endMs - startMs;
    }
    return undefined;
  }

  function timestampFromOpenTelemetryReadableSpan(span, fallbackTimestamp) {
    return timestampFromOpenTelemetryTime(span.startTime)
      ?? (typeof fallbackTimestamp === "function" ? fallbackTimestamp() : new Date().toISOString());
  }

  function timestampFromOpenTelemetryTime(value) {
    const milliseconds = openTelemetryTimeMs(value);
    if (milliseconds === undefined) {
      return undefined;
    }
    const date = new Date(milliseconds);
    return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
  }

  function openTelemetryDurationMs(value) {
    if (!Array.isArray(value) || value.length < 2) {
      return undefined;
    }
    const [seconds, nanos] = value;
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos) || seconds < 0 || nanos < 0) {
      return undefined;
    }
    return seconds * 1000 + nanos / 1_000_000;
  }

  function openTelemetryTimeMs(value) {
    if (Array.isArray(value) && value.length >= 2) {
      const [seconds, nanos] = value;
      if (Number.isFinite(seconds) && Number.isFinite(nanos)) {
        return seconds * 1000 + nanos / 1_000_000;
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (value instanceof Date && !Number.isNaN(value.valueOf())) {
      return value.valueOf();
    }
    return undefined;
  }

  async function flushOpenTelemetryProcessorQueue({ client, flushOnForceFlush, onError, state, transport }) {
    if (!transport || !flushOnForceFlush || client.pendingEvents() === 0) {
      await state.pendingFlush;
      return;
    }
    if (state.flushInFlight) {
      await state.pendingFlush;
      return;
    }
    state.flushInFlight = true;
    state.pendingFlush = Promise.resolve(client.flush(transport))
      .then(() => null)
      .catch((error) => {
        onError(error);
        return null;
      })
      .finally(() => {
        state.flushInFlight = false;
      });
    await state.pendingFlush;
  }

  function isSensitiveOpenTelemetryAttributeKey(key) {
    if (SENSITIVE_OTEL_ATTRIBUTE_KEYS.has(key)) {
      return true;
    }
    if (SENSITIVE_OTEL_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      return true;
    }
    return SENSITIVE_OTEL_ATTRIBUTE_PATTERN.test(key);
  }

  return {
    createLogBrewOpenTelemetrySpanProcessor,
    logbrewTraceContextFromCurrentOpenTelemetrySpan,
    logbrewTraceContextFromOpenTelemetrySpan,
    logbrewTraceContextFromOpenTelemetrySpanContext,
    spanAttributesFromOpenTelemetryReadableSpan
  };
}

function optionalOpenTelemetryApi() {
  const packageName = "@opentelemetry/api";
  const optionalRequire = typeof module !== "undefined" && typeof module.require === "function"
    ? module.require.bind(module)
    : typeof require === "function"
      ? require
      : undefined;
  if (!optionalRequire) {
    return undefined;
  }
  try {
    return optionalRequire(packageName);
  } catch {
    return undefined;
  }
}

module.exports = { buildOpenTelemetryHelpers };
