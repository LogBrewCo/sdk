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
const TRACE_SUMMARY_METADATA_KEYS = new Set([
  ...DEFAULT_OTEL_RESOURCE_ATTRIBUTE_KEYS,
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
const OTEL_SPAN_KIND_NAMES = new Map([
  [0, "internal"],
  [1, "server"],
  [2, "client"],
  [3, "producer"],
  [4, "consumer"]
]);
const OTEL_STATUS_CODE_ERROR = 2;
const OTEL_STATUS_CODE_OK = 1;
const OTEL_EXPORT_RESULT_SUCCESS = 0;
const OTEL_EXPORT_RESULT_FAILED = 1;
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
    const includeTraceSummary = config.includeTraceSummary === true;
    const resolvedOptions = resolveOpenTelemetryReadableSpanOptions(config);
    const state = {
      captured: 0,
      closed: false,
      flushInFlight: false,
      pendingFlush: Promise.resolve(null),
      traceSummaryCount: 0,
      traceSummaries: includeTraceSummary ? new Map() : null
    };

    return {
      onStart() {},
      onEnd(span) {
        if (state.closed) {
          return;
        }
        try {
          enqueueOpenTelemetryReadableSpan({
            client,
            eventIdPrefix,
            resolvedOptions,
            span,
            spanFilter,
            state,
            timestamp
          });
        } catch (error) {
          onError(error);
        }
      },
      async forceFlush() {
        await flushOpenTelemetryProcessorQueue({
          client,
          eventIdPrefix,
          flushOnForceFlush,
          includeTraceSummary,
          onError,
          state,
          timestamp,
          transport
        });
      },
      async shutdown() {
        state.closed = true;
        await flushOpenTelemetryProcessorQueue({
          client,
          eventIdPrefix,
          flushOnForceFlush,
          includeTraceSummary,
          onError,
          state,
          timestamp,
          transport
        });
      }
    };
  }

  function createLogBrewOpenTelemetrySpanExporter(config) {
    if (!config || Array.isArray(config) || typeof config !== "object") {
      throw new SdkError("validation_error", "OpenTelemetry span exporter config must be an object");
    }
    const client = config.client;
    if (!(client instanceof LogBrewClient)) {
      throw new SdkError("validation_error", "OpenTelemetry span exporter client must be a LogBrewClient");
    }
    const eventIdPrefix = config.eventIdPrefix ?? "otel";
    requireNonEmpty("OpenTelemetry eventIdPrefix", eventIdPrefix);
    const transport = config.transport;
    const timestamp = typeof config.timestamp === "function"
      ? config.timestamp
      : undefined;
    const onError = typeof config.onError === "function" ? config.onError : () => {};
    const spanFilter = typeof config.spanFilter === "function" ? config.spanFilter : null;
    const flushOnExport = config.flushOnExport !== false;
    const includeTraceSummary = config.includeTraceSummary === true;
    const resolvedOptions = resolveOpenTelemetryReadableSpanOptions(config);
    const state = {
      captured: 0,
      closed: false,
      flushInFlight: false,
      pendingFlush: Promise.resolve(null),
      traceSummaryCount: 0,
      traceSummaries: includeTraceSummary ? new Map() : null
    };

    return {
      export(spans, resultCallback) {
        const callback = typeof resultCallback === "function" ? resultCallback : () => {};
        if (state.closed) {
          const error = new SdkError("shutdown_error", "OpenTelemetry span exporter is already shut down");
          callback(openTelemetryExportFailure(error));
          return;
        }
        if (!Array.isArray(spans)) {
          const error = new SdkError("validation_error", "OpenTelemetry span exporter spans must be an array");
          onError(error);
          callback(openTelemetryExportFailure(error));
          return;
        }
        try {
          for (const span of spans) {
            enqueueOpenTelemetryReadableSpan({
              client,
              eventIdPrefix,
              resolvedOptions,
              span,
              spanFilter,
              state,
              timestamp
            });
          }
        } catch (error) {
          onError(error);
          callback(openTelemetryExportFailure(error));
          return;
        }
        flushOpenTelemetryExporterQueue({
          client,
          eventIdPrefix,
          flushOnExport,
          includeTraceSummary,
          onError,
          state,
          timestamp,
          transport
        }).then(
          () => callback({ code: OTEL_EXPORT_RESULT_SUCCESS }),
          (error) => {
            onError(error);
            callback(openTelemetryExportFailure(error));
          }
        );
      },
      async forceFlush() {
        await flushOpenTelemetryExporterQueue({
          client,
          eventIdPrefix,
          flushOnExport: true,
          includeTraceSummary,
          onError,
          state,
          timestamp,
          transport
        });
      },
      async shutdown() {
        state.closed = true;
        await flushOpenTelemetryExporterQueue({
          client,
          eventIdPrefix,
          flushOnExport: true,
          includeTraceSummary,
          onError,
          state,
          timestamp,
          transport
        });
      }
    };
  }

  function enqueueOpenTelemetryReadableSpan({
    client,
    eventIdPrefix,
    resolvedOptions,
    span,
    spanFilter,
    state,
    timestamp
  }) {
    if (spanFilter && spanFilter(span) === false) {
      return;
    }
    const attributes = spanAttributesFromResolvedOpenTelemetryReadableSpan(span, resolvedOptions);
    if (!attributes) {
      return;
    }
    recordOpenTelemetryTraceSummary(state, attributes, span);
    state.captured += 1;
    client.span(
      `${eventIdPrefix}_${state.captured}`,
      timestampFromOpenTelemetryReadableSpan(span, timestamp),
      attributes
    );
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
    const exceptionSummary = openTelemetryExceptionEventSummary(span.events);
    const exceptionMetadata = openTelemetryExceptionMetadata(exceptionSummary);
    const durationMs = durationMsFromOpenTelemetryReadableSpan(span);
    const resolvedMetadata = {
      ...metadata,
      ...exceptionMetadata
    };

    return {
      name: openTelemetrySpanName(span),
      traceId: context.traceId,
      spanId: context.spanId,
      ...(context.parentSpanId !== undefined ? { parentSpanId: context.parentSpanId } : {}),
      status: openTelemetrySpanStatus(span.status, exceptionSummary),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(events !== undefined ? { events } : {}),
      ...(links !== undefined ? { links } : {}),
      ...(Object.keys(resolvedMetadata).length > 0 ? { metadata: resolvedMetadata } : {})
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

  function openTelemetrySpanStatus(status, exceptionSummary = null) {
    if (status?.code === OTEL_STATUS_CODE_ERROR || status?.code === "ERROR") {
      return "error";
    }
    if (status?.code === OTEL_STATUS_CODE_OK || status?.code === "OK") {
      return "ok";
    }
    if (exceptionSummary?.escapedCount > 0) {
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

  function openTelemetryExceptionEventSummary(events) {
    if (!Array.isArray(events) || events.length === 0) {
      return null;
    }
    const types = [];
    let count = 0;
    let escapedCount = 0;
    for (const event of events) {
      if (!event || Array.isArray(event) || typeof event !== "object" || event.name !== "exception") {
        continue;
      }
      count += 1;
      if (event.attributes?.["exception.escaped"] === true) {
        escapedCount += 1;
      }
      const type = safeOpenTelemetryExceptionType(event.attributes?.["exception.type"]);
      if (type && !types.includes(type) && types.length < maxSpanEvents) {
        types.push(type);
      }
    }
    return count > 0 ? { count, escapedCount, types } : null;
  }

  function openTelemetryExceptionMetadata(summary) {
    if (!summary || summary.count === 0) {
      return {};
    }
    return {
      "otel.exception_event_count": summary.count,
      ...(summary.escapedCount > 0 ? { "otel.exception_escaped_count": summary.escapedCount } : {}),
      ...(summary.types.length > 0 ? { "otel.exception_types": summary.types.join(",") } : {})
    };
  }

  function safeOpenTelemetryExceptionType(value) {
    return typeof value === "string" && /^[A-Za-z_$][A-Za-z0-9_$:.]{0,127}$/u.test(value) ? value : undefined;
  }

  function recordOpenTelemetryTraceSummary(state, attributes, span) {
    if (!(state.traceSummaries instanceof Map)) {
      return;
    }
    let summary = state.traceSummaries.get(attributes.traceId);
    if (!summary) {
      summary = {
        traceId: attributes.traceId,
        spanCount: 0,
        errorSpanCount: 0,
        metadata: {},
        rootSeen: false
      };
      state.traceSummaries.set(attributes.traceId, summary);
    }

    summary.spanCount += 1;
    if (attributes.status === "error") {
      summary.errorSpanCount += 1;
    }
    recordOpenTelemetryTraceSummaryExceptions(summary, attributes.metadata);

    const startMs = openTelemetryTimeMs(span.startTime);
    const durationMs = attributes.durationMs;
    const endMs = endMsFromOpenTelemetryReadableSpan(span, startMs, durationMs);
    if (startMs !== undefined && (summary.firstStartMs === undefined || startMs < summary.firstStartMs)) {
      summary.firstStartMs = startMs;
    }
    if (endMs !== undefined && (summary.lastEndMs === undefined || endMs > summary.lastEndMs)) {
      summary.lastEndMs = endMs;
    }

    copyOpenTelemetryTraceSummaryMetadata(summary, attributes.metadata);

    const isRootSpan = attributes.parentSpanId === undefined;
    if (isRootSpan || !summary.rootSpanId) {
      summary.rootSpanId = attributes.spanId;
      summary.rootName = attributes.name;
      summary.rootKind = attributes.metadata?.["otel.kind"];
      summary.rootSeen = isRootSpan;
      if (startMs !== undefined) {
        summary.rootStartMs = startMs;
      }
      if (durationMs !== undefined) {
        summary.rootDurationMs = durationMs;
      }
      copyOpenTelemetryTraceSummaryMetadata(summary, attributes.metadata, { overwrite: true });
    }
  }

  function recordOpenTelemetryTraceSummaryExceptions(summary, metadata) {
    if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
      return;
    }
    if (Number.isSafeInteger(metadata["otel.exception_event_count"]) && metadata["otel.exception_event_count"] > 0) {
      summary.exceptionEventCount = (summary.exceptionEventCount ?? 0) + metadata["otel.exception_event_count"];
    }
    if (Number.isSafeInteger(metadata["otel.exception_escaped_count"]) && metadata["otel.exception_escaped_count"] > 0) {
      summary.exceptionEscapedCount = (summary.exceptionEscapedCount ?? 0) + metadata["otel.exception_escaped_count"];
    }
    if (typeof metadata["otel.exception_types"] === "string" && metadata["otel.exception_types"].trim() !== "") {
      const types = summary.exceptionTypes ?? new Set();
      for (const type of metadata["otel.exception_types"].split(",")) {
        const safeType = safeOpenTelemetryExceptionType(type);
        if (safeType) {
          types.add(safeType);
        }
      }
      summary.exceptionTypes = types;
    }
  }

  function copyOpenTelemetryTraceSummaryMetadata(summary, metadata, options = {}) {
    if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (
        TRACE_SUMMARY_METADATA_KEYS.has(key) &&
        (options.overwrite === true || summary.metadata[key] === undefined) &&
        isMetadataValue(value)
      ) {
        summary.metadata[key] = value;
      }
    }
  }

  function enqueueOpenTelemetryTraceSummaries({ client, eventIdPrefix, onError, state, timestamp }) {
    if (!(state.traceSummaries instanceof Map) || state.traceSummaries.size === 0) {
      return;
    }
    const summaries = Array.from(state.traceSummaries.values());
    state.traceSummaries.clear();
    for (const summary of summaries) {
      try {
        state.traceSummaryCount += 1;
        client.span(
          `${eventIdPrefix}_trace_${state.traceSummaryCount}`,
          timestampFromOpenTelemetryTraceSummary(summary, timestamp),
          openTelemetryTraceSummaryAttributes(summary)
        );
      } catch (error) {
        onError(error);
      }
    }
  }

  function openTelemetryTraceSummaryAttributes(summary) {
    const metadata = compactMetadata({
      source: "opentelemetry.trace_summary",
      ...summary.metadata,
      "otel.trace.span_count": summary.spanCount,
      ...(summary.errorSpanCount > 0 ? { "otel.trace.error_span_count": summary.errorSpanCount } : {}),
      ...(summary.exceptionEventCount > 0 ? { "otel.trace.exception_event_count": summary.exceptionEventCount } : {}),
      ...(summary.exceptionEscapedCount > 0 ? { "otel.trace.exception_escaped_count": summary.exceptionEscapedCount } : {}),
      ...(summary.exceptionTypes?.size > 0 ? { "otel.trace.exception_types": Array.from(summary.exceptionTypes).join(",") } : {}),
      ...(summary.rootSpanId ? { "otel.trace.root_span_id": summary.rootSpanId } : {}),
      ...(summary.rootName ? { "otel.trace.root_name": summary.rootName } : {}),
      ...(summary.rootKind ? { "otel.trace.root_kind": summary.rootKind } : {}),
      "otel.trace.summary_kind": summary.rootSeen ? "rooted" : "flush_batch"
    });
    const durationMs = durationMsFromOpenTelemetryTraceSummary(summary);
    return {
      name: summary.rootName ? `opentelemetry.trace:${summary.rootName}` : "opentelemetry.trace",
      traceId: summary.traceId,
      spanId: defaultSpanIdFactory(),
      status: summary.errorSpanCount > 0 ? "error" : "ok",
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {})
    };
  }

  function durationMsFromOpenTelemetryTraceSummary(summary) {
    if (
      summary.firstStartMs !== undefined &&
      summary.lastEndMs !== undefined &&
      summary.lastEndMs >= summary.firstStartMs
    ) {
      return summary.lastEndMs - summary.firstStartMs;
    }
    return summary.rootDurationMs;
  }

  function timestampFromOpenTelemetryTraceSummary(summary, fallbackTimestamp) {
    return timestampFromOpenTelemetryTime(summary.rootStartMs)
      ?? timestampFromOpenTelemetryTime(summary.firstStartMs)
      ?? (typeof fallbackTimestamp === "function" ? fallbackTimestamp() : new Date().toISOString());
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

  function endMsFromOpenTelemetryReadableSpan(span, startMs, durationMs) {
    const endMs = openTelemetryTimeMs(span.endTime);
    if (endMs !== undefined) {
      return endMs;
    }
    if (startMs !== undefined && durationMs !== undefined) {
      return startMs + durationMs;
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

  async function flushOpenTelemetryProcessorQueue({
    client,
    eventIdPrefix,
    flushOnForceFlush,
    includeTraceSummary,
    onError,
    state,
    timestamp,
    transport
  }) {
    if (includeTraceSummary) {
      enqueueOpenTelemetryTraceSummaries({ client, eventIdPrefix, onError, state, timestamp });
    }
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

  async function flushOpenTelemetryExporterQueue({
    client,
    eventIdPrefix,
    flushOnExport,
    includeTraceSummary,
    onError,
    state,
    timestamp,
    transport
  }) {
    if (includeTraceSummary) {
      enqueueOpenTelemetryTraceSummaries({ client, eventIdPrefix, onError, state, timestamp });
    }
    if (!transport || !flushOnExport || client.pendingEvents() === 0) {
      await state.pendingFlush;
      return;
    }
    if (state.flushInFlight) {
      await state.pendingFlush;
      return;
    }
    state.flushInFlight = true;
    state.pendingFlush = Promise.resolve(client.flush(transport))
      .finally(() => {
        state.flushInFlight = false;
      });
    await state.pendingFlush;
  }

  function openTelemetryExportFailure(error) {
    return {
      code: OTEL_EXPORT_RESULT_FAILED,
      ...(error instanceof Error ? { error } : {})
    };
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
    createLogBrewOpenTelemetrySpanExporter,
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
