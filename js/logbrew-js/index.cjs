const { buildCreateSupportTicketDraft } = require("./support-ticket.cjs");

const SEVERITY_ALIASES = new Map([
  ["trace", "info"],
  ["debug", "info"],
  ["info", "info"],
  ["warn", "warning"],
  ["warning", "warning"],
  ["error", "error"],
  ["fatal", "critical"],
  ["critical", "critical"]
]);
const SEVERITY_VALUES = new Set(SEVERITY_ALIASES.keys());
const SPAN_STATUSES = new Set(["ok", "error"]);
const ACTION_STATUSES = new Set(["queued", "running", "success", "failure"]);
const METRIC_KINDS = new Set(["counter", "gauge", "histogram"]);
const NON_NEGATIVE_METRIC_KINDS = new Set(["counter", "histogram"]);
const METRIC_TEMPORALITIES_BY_KIND = new Map([
  ["counter", new Set(["delta", "cumulative"])],
  ["gauge", new Set(["instant"])],
  ["histogram", new Set(["delta", "cumulative"])]
]);
const CONSOLE_METHODS = new Set(["debug", "info", "log", "warn", "error"]);
const DEFAULT_CONSOLE_LEVELS = ["debug", "info", "log", "warn", "error"];
const PINO_HOST_FIELD = ["host", "name"].join("");
const PINO_RESERVED_FIELDS = new Set(["level", "time", "timestamp", "msg", "message", "err", "error", "pid", PINO_HOST_FIELD, "v"]);
const WINSTON_RESERVED_FIELDS = new Set(["level", "message", "timestamp", "time", "err", "error", "stack"]);
const TRACEPARENT_PATTERN = /^([0-9a-fA-F]{2})-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{2})$/u;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const MAX_SPAN_EVENTS = 8;
const MAX_SPAN_LINKS = 8;
class SdkError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SdkError";
    this.code = code;
    const retryAfterMs = retryAfterMsOrUndefined(details?.retryAfterMs);
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

class TransportError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.retryable = retryable;
  }

  static network(message) {
    return new TransportError("network_failure", message, true);
  }
}

class RecordingTransport {
  constructor(scriptedResponses = [{ statusCode: 202 }]) {
    this.scriptedResponses = [...scriptedResponses];
    this.sentBodies = [];
  }

  static alwaysAccept() {
    return new RecordingTransport([{ statusCode: 202 }]);
  }

  lastBody() {
    return this.sentBodies.at(-1) ?? null;
  }

  async send(apiKey, body) {
    requireNonEmpty("apiKey", apiKey);
    this.sentBodies.push(body);

    const next = this.scriptedResponses.length > 0
      ? this.scriptedResponses.shift()
      : { statusCode: 202 };

    if (next instanceof Error) {
      throw next;
    }

    const retryAfterMs = retryAfterMsOrUndefined(next.retryAfterMs);
    return retryAfterMs === undefined
      ? { statusCode: next.statusCode, attempts: 1 }
      : { statusCode: next.statusCode, attempts: 1, retryAfterMs };
  }
}

class LogBrewClient {
  static create({
    apiKey,
    sdkName,
    sdkVersion,
    maxRetries = 2,
    eventFilter,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    onEventDropped
  }) {
    requireNonEmpty("apiKey", apiKey);
    requireNonEmpty("sdkName", sdkName);
    requireNonEmpty("sdkVersion", sdkVersion);
    if (eventFilter !== undefined && typeof eventFilter !== "function") {
      throw new SdkError("validation_error", "eventFilter must be a function");
    }
    requirePositiveInteger("maxQueueSize", maxQueueSize);
    if (onEventDropped !== undefined && typeof onEventDropped !== "function") {
      throw new SdkError("validation_error", "onEventDropped must be a function");
    }

    return new LogBrewClient({
      apiKey,
      eventFilter,
      maxQueueSize,
      onEventDropped,
      sdk: {
        name: sdkName,
        language: "javascript",
        version: sdkVersion
      },
      maxRetries
    });
  }

  constructor({ apiKey, sdk, maxRetries, eventFilter, maxQueueSize, onEventDropped }) {
    this.apiKey = apiKey;
    this.eventFilter = eventFilter;
    this.maxQueueSize = maxQueueSize;
    this.onEventDropped = onEventDropped;
    this.sdk = sdk;
    this.maxRetries = maxRetries;
    this.events = [];
    this.closed = false;
    this.droppedEventCount = 0;
  }

  pendingEvents() {
    return this.events.length;
  }

  droppedEvents() {
    return this.droppedEventCount;
  }

  previewJson() {
    return JSON.stringify({ sdk: this.sdk, events: this.events }, null, 2);
  }

  release(id, timestamp, attributes) {
    this.#pushEvent("release", id, timestamp, validateRelease(attributes));
  }

  environment(id, timestamp, attributes) {
    this.#pushEvent("environment", id, timestamp, validateEnvironment(attributes));
  }

  issue(id, timestamp, attributes) {
    this.#pushEvent("issue", id, timestamp, validateIssue(attributes));
  }

  log(id, timestamp, attributes) {
    this.#pushEvent("log", id, timestamp, validateLog(attributes));
  }

  span(id, timestamp, attributes) {
    this.#pushEvent("span", id, timestamp, validateSpan(attributes));
  }

  action(id, timestamp, attributes) {
    this.#pushEvent("action", id, timestamp, validateAction(attributes));
  }

  metric(id, timestamp, attributes) {
    this.#pushEvent("metric", id, timestamp, validateMetric(attributes));
  }

  async flush(transport) {
    if (this.closed) {
      throw new SdkError("shutdown_error", "client is already shut down");
    }
    return this.#flushInternal(transport);
  }

  async shutdown(transport) {
    if (this.closed) {
      throw new SdkError("shutdown_error", "client is already shut down");
    }
    const response = await this.#flushInternal(transport);
    this.closed = true;
    return response;
  }

  #pushEvent(eventType, id, timestamp, attributes) {
    if (this.closed) {
      throw new SdkError("shutdown_error", "client is already shut down");
    }
    requireNonEmpty("event id", id);
    requireTimestamp(timestamp);
    const event = { type: eventType, id, timestamp, attributes };
    if (this.eventFilter && this.eventFilter(cloneEvent(event)) === false) {
      return;
    }
    if (this.events.length >= this.maxQueueSize) {
      this.#recordDroppedEvent(event);
      return;
    }
    this.events.push(event);
  }

  #recordDroppedEvent(event) {
    this.droppedEventCount += 1;
    if (!this.onEventDropped) {
      return;
    }
    try {
      this.onEventDropped({
        droppedEvents: this.droppedEventCount,
        eventId: event.id,
        eventType: event.type,
        reason: "queue_overflow"
      });
    } catch {
      // Drop callbacks are advisory and must not interrupt application logging.
    }
  }

  async #flushInternal(transport) {
    if (this.events.length === 0) {
      return { statusCode: 204, attempts: 0 };
    }

    const body = this.previewJson();
    const maxAttempts = this.maxRetries + 1;
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const response = await transport.send(this.apiKey, body);
        if (response.statusCode === 401) {
          throw new SdkError("unauthenticated", "transport rejected the API key");
        }
        if (response.statusCode === 429) {
          throw new SdkError("rate_limited", "transport rate limited the batch", {
            retryAfterMs: response.retryAfterMs
          });
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          this.events = [];
          return { statusCode: response.statusCode, attempts };
        }
        if (response.statusCode >= 500 && attempts < maxAttempts) {
          continue;
        }
        throw new SdkError("transport_error", `unexpected transport status ${response.statusCode}`);
      } catch (error) {
        if (error instanceof SdkError) {
          throw error;
        }
        if (error instanceof TransportError && error.retryable && attempts < maxAttempts) {
          continue;
        }
        if (error instanceof TransportError) {
          throw new SdkError(error.code, error.message);
        }
        throw error;
      }
    }

    throw new SdkError("transport_error", "exhausted retries");
  }
}

function installLogBrewConsoleCapture(config) {
  if (!config || typeof config !== "object") {
    throw new SdkError("validation_error", "console capture config must be an object");
  }

  const client = config.client;
  if (!(client instanceof LogBrewClient)) {
    throw new SdkError("validation_error", "console capture client must be a LogBrewClient");
  }

  const targetConsole = config.console ?? globalThis.console;
  if (!targetConsole || typeof targetConsole !== "object") {
    throw new SdkError("validation_error", "console capture target must be an object");
  }

  const transport = config.transport;
  const flushOnCapture = config.flushOnCapture === true;
  const includeErrorStack = config.includeErrorStack === true;
  const logger = config.logger ?? "console";
  const metadata = compactMetadata(config.metadata);
  const timestamp = typeof config.timestamp === "function"
    ? config.timestamp
    : () => new Date().toISOString();
  const eventIdPrefix = config.eventIdPrefix ?? "console";
  const onError = typeof config.onError === "function" ? config.onError : () => {};
  const levels = normalizeConsoleLevels(config.levels);
  const originals = new Map();
  const state = {
    installed: true,
    captured: 0,
    pendingFlush: Promise.resolve(null)
  };

  for (const method of levels) {
    const original = targetConsole[method];
    if (typeof original !== "function") {
      continue;
    }
    originals.set(method, original);
    targetConsole[method] = createConsoleCaptureMethod({
      client,
      eventIdPrefix,
      flushOnCapture,
      includeErrorStack,
      logger,
      metadata,
      method,
      onError,
      original,
      state,
      timestamp,
      transport
    });
  }

  return {
    async flush() {
      if (transport && client.pendingEvents() > 0) {
        state.pendingFlush = Promise.resolve(client.flush(transport)).catch((error) => {
          onError(error);
          return null;
        });
      }
      return state.pendingFlush;
    },
    uninstall() {
      if (!state.installed) {
        return;
      }
      state.installed = false;
      for (const [method, original] of originals.entries()) {
        targetConsole[method] = original;
      }
      originals.clear();
    }
  };
}

function createConsoleCaptureMethod(config) {
  return function logBrewConsoleMethod(...args) {
    config.original.apply(this, args);
    if (!config.state.installed) {
      return;
    }
    try {
      config.state.captured += 1;
      config.client.log(
        `${config.eventIdPrefix}_${config.state.captured}`,
        config.timestamp(),
        logAttributesFromConsoleArgs(config.method, args, {
          includeErrorStack: config.includeErrorStack,
          logger: config.logger,
          metadata: config.metadata
        })
      );
      if (config.flushOnCapture && config.transport) {
        config.state.pendingFlush = Promise.resolve(config.client.flush(config.transport)).catch((error) => {
          config.onError(error);
          return null;
        });
      }
    } catch (error) {
      config.onError(error);
    }
  };
}

function logAttributesFromConsoleArgs(method, args, options = {}) {
  const logLevel = logbrewLevelFromConsoleMethod(method);
  const includeErrorStack = options.includeErrorStack === true;
  const message = consoleMessage(args, includeErrorStack);
  const metadata = {
    ...compactMetadata(options.metadata),
    consoleMethod: method,
    argumentCount: Array.isArray(args) ? args.length : 0
  };
  for (const value of Array.isArray(args) ? args : []) {
    if (value instanceof Error) {
      metadata.errorName = value.name || "Error";
      if (value.message) {
        metadata.errorMessage = value.message;
      }
      if (includeErrorStack && value.stack) {
        metadata.errorStack = value.stack;
      }
      break;
    }
  }

  return {
    message,
    level: logLevel,
    ...(options.logger ? { logger: options.logger } : {}),
    metadata
  };
}

function logbrewLevelFromConsoleMethod(method) {
  switch (method) {
    case "debug":
      return "info";
    case "warn":
      return "warning";
    case "error":
      return "error";
    case "info":
    case "log":
      return "info";
    default:
      throw new SdkError("validation_error", `console method must be one of: ${Array.from(CONSOLE_METHODS).join(", ")}`);
  }
}

function createProductActionAttributes(action, options = {}) {
  const details = productActionDetails(action);
  return {
    name: details.name,
    status: details.status,
    metadata: compactMetadata({
      source: "product.action",
      ...compactMetadata(options.metadata),
      ...compactMetadata(details.metadata),
      routeTemplate: sanitizeRouteTemplate(details.routeTemplate),
      sessionId: stringOrUndefined(details.sessionId),
      traceId: stringOrUndefined(details.traceId),
      screen: stringOrUndefined(details.screen),
      funnel: stringOrUndefined(details.funnel),
      step: stringOrUndefined(details.step)
    })
  };
}

function createNetworkMilestoneAttributes(request, options = {}) {
  const details = networkMilestoneDetails(request);
  return {
    name: details.name,
    status: details.status,
    metadata: compactMetadata({
      source: "network.milestone",
      ...compactMetadata(options.metadata),
      ...compactMetadata(details.metadata),
      routeTemplate: details.routeTemplate,
      method: details.method,
      statusCode: details.statusCode,
      durationMs: details.durationMs,
      sessionId: stringOrUndefined(details.sessionId),
      traceId: stringOrUndefined(details.traceId)
    })
  };
}

function parseTraceparent(traceparent) {
  if (typeof traceparent !== "string" || traceparent.trim() === "") {
    throw new SdkError("validation_error", "traceparent must be non-empty");
  }

  const match = TRACEPARENT_PATTERN.exec(traceparent.trim());
  if (!match) {
    throw new SdkError("validation_error", "traceparent must use W3C version-traceId-parentSpanId-traceFlags format");
  }

  const version = match[1].toLowerCase();
  const traceId = match[2].toLowerCase();
  const parentSpanId = match[3].toLowerCase();
  const traceFlags = match[4].toLowerCase();
  if (version === "ff") {
    throw new SdkError("validation_error", "traceparent version ff is not allowed");
  }
  if (traceId === ZERO_TRACE_ID) {
    throw new SdkError("validation_error", "traceparent traceId must not be all zeros");
  }
  if (parentSpanId === ZERO_SPAN_ID) {
    throw new SdkError("validation_error", "traceparent parentSpanId must not be all zeros");
  }

  return {
    version,
    traceId,
    parentSpanId,
    traceFlags,
    sampled: (Number.parseInt(traceFlags, 16) & 1) === 1
  };
}

function createTraceparent({ traceId, spanId, traceFlags = "01" }) {
  requireTraceId(traceId);
  requireSpanId("spanId", spanId);
  requireTraceFlags(traceFlags);
  return `00-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${traceFlags.toLowerCase()}`;
}

function createTraceparentHeaders(input) {
  return { traceparent: createTraceparent(input) };
}

const createSupportTicketDraft = buildCreateSupportTicketDraft({
  SdkError,
  requireAllowedValue,
  requireNonEmpty,
  requireTraceId
});

function spanAttributesFromTraceparent(traceparent, attributes) {
  if (!attributes || Array.isArray(attributes) || typeof attributes !== "object") {
    throw new SdkError("validation_error", "span attributes must be an object");
  }
  const context = parseTraceparent(traceparent);
  requireNonEmpty("span name", attributes.name);
  requireSpanId("spanId", attributes.spanId);
  requireAllowedValue("span status", attributes.status, SPAN_STATUSES);
  if (attributes.durationMs !== undefined) {
    if (typeof attributes.durationMs !== "number" || Number.isNaN(attributes.durationMs) || attributes.durationMs < 0) {
      throw new SdkError("validation_error", "span durationMs must be non-negative");
    }
  }
  const events = validateSpanEvents(attributes.events);
  const links = validateSpanLinks(attributes.links);

  return {
    name: attributes.name,
    traceId: context.traceId,
    spanId: attributes.spanId.toLowerCase(),
    parentSpanId: context.parentSpanId,
    status: attributes.status,
    ...(attributes.durationMs !== undefined ? { durationMs: attributes.durationMs } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(attributes.metadata !== undefined ? { metadata: compactMetadata(attributes.metadata) } : {})
  };
}

function createLogBrewPinoDestination(config) {
  if (!config || typeof config !== "object") {
    throw new SdkError("validation_error", "Pino destination config must be an object");
  }

  const client = config.client;
  if (!(client instanceof LogBrewClient)) {
    throw new SdkError("validation_error", "Pino destination client must be a LogBrewClient");
  }

  const transport = config.transport;
  const flushOnWrite = config.flushOnWrite === true;
  const includeErrorStack = config.includeErrorStack === true;
  const logger = config.logger ?? "pino";
  const metadata = compactMetadata(config.metadata);
  const timestamp = typeof config.timestamp === "function"
    ? config.timestamp
    : () => new Date().toISOString();
  const eventIdPrefix = config.eventIdPrefix ?? "pino";
  const onError = typeof config.onError === "function" ? config.onError : () => {};
  const state = {
    captured: 0,
    pendingFlush: Promise.resolve(null)
  };

  return {
    write(chunk) {
      const lines = String(chunk).split(/\r?\n/u).filter((line) => line.trim() !== "");
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          state.captured += 1;
          client.log(
            `${eventIdPrefix}_${state.captured}`,
            timestampFromPinoRecord(record, timestamp),
            logAttributesFromPinoRecord(record, {
              includeErrorStack,
              logger,
              metadata
            })
          );
          if (flushOnWrite && transport) {
            state.pendingFlush = Promise.resolve(client.flush(transport)).catch((error) => {
              onError(error);
              return null;
            });
          }
        } catch (error) {
          onError(error);
        }
      }
      return true;
    },
    async flush() {
      if (transport && client.pendingEvents() > 0) {
        state.pendingFlush = Promise.resolve(client.flush(transport)).catch((error) => {
          onError(error);
          return null;
        });
      }
      return state.pendingFlush;
    },
    end() {
      return this.flush();
    }
  };
}

function logAttributesFromPinoRecord(record, options = {}) {
  if (!record || Array.isArray(record) || typeof record !== "object") {
    throw new SdkError("validation_error", "Pino record must be an object");
  }

  const level = logbrewLevelFromPinoLevel(record.level);
  const metadata = {
    ...compactMetadata(options.metadata),
    pinoLevel: pinoLevelLabel(record.level),
    ...pinoContextMetadata(record)
  };
  if (typeof record.level === "number" && Number.isFinite(record.level)) {
    metadata.pinoLevelNumber = record.level;
  }
  addPinoErrorMetadata(metadata, record.err ?? record.error, options.includeErrorStack === true);

  return {
    message: pinoMessage(record),
    level,
    ...(options.logger ? { logger: options.logger } : {}),
    metadata
  };
}

function createLogBrewWinstonTransport(config) {
  if (!config || typeof config !== "object") {
    throw new SdkError("validation_error", "Winston transport config must be an object");
  }

  const client = config.client;
  if (!(client instanceof LogBrewClient)) {
    throw new SdkError("validation_error", "Winston transport client must be a LogBrewClient");
  }

  const transport = config.transport;
  const flushOnWrite = config.flushOnWrite === true;
  const includeErrorStack = config.includeErrorStack === true;
  const logger = config.logger ?? "winston";
  const metadata = compactMetadata(config.metadata);
  const timestamp = typeof config.timestamp === "function"
    ? config.timestamp
    : () => new Date().toISOString();
  const eventIdPrefix = config.eventIdPrefix ?? "winston";
  const onError = typeof config.onError === "function" ? config.onError : () => {};
  const state = {
    captured: 0,
    pendingFlush: Promise.resolve(null)
  };
  const { Writable } = require("node:stream");

  const winstonTransport = new Writable({
    objectMode: true,
    write(info, _encoding, callback) {
      try {
        captureWinstonInfo({
          client,
          eventIdPrefix,
          flushOnWrite,
          includeErrorStack,
          info,
          logger,
          metadata,
          onError,
          state,
          timestamp,
          transport
        });
      } catch (error) {
        onError(error);
      } finally {
        callback();
      }
    }
  });

  winstonTransport.log = function log(info, callback) {
    this.write(info);
    if (typeof callback === "function") {
      callback();
    }
  };
  winstonTransport.flush = async () => {
    if (transport && client.pendingEvents() > 0) {
      state.pendingFlush = Promise.resolve(client.flush(transport)).catch((error) => {
        onError(error);
        return null;
      });
    }
    return state.pendingFlush;
  };
  if (typeof config.level === "string" && config.level.trim() !== "") {
    winstonTransport.level = config.level;
  }
  if (config.name !== undefined) {
    winstonTransport.name = String(config.name);
  }
  if (config.silent === true) {
    winstonTransport.silent = true;
  }
  if (config.handleExceptions === true) {
    winstonTransport.handleExceptions = true;
  }
  if (config.handleRejections === true) {
    winstonTransport.handleRejections = true;
  }

  return winstonTransport;
}

function captureWinstonInfo(config) {
  if (config.info?.silent === true) {
    return;
  }
  config.state.captured += 1;
  config.client.log(
    `${config.eventIdPrefix}_${config.state.captured}`,
    timestampFromWinstonInfo(config.info, config.timestamp),
    logAttributesFromWinstonInfo(config.info, {
      includeErrorStack: config.includeErrorStack,
      logger: config.logger,
      metadata: config.metadata
    })
  );
  if (config.flushOnWrite && config.transport) {
    config.state.pendingFlush = Promise.resolve(config.client.flush(config.transport)).catch((error) => {
      config.onError(error);
      return null;
    });
  }
}

function logAttributesFromWinstonInfo(info, options = {}) {
  if (!info || Array.isArray(info) || typeof info !== "object") {
    throw new SdkError("validation_error", "Winston info must be an object");
  }

  const level = logbrewLevelFromWinstonLevel(info.level);
  const metadata = {
    ...compactMetadata(options.metadata),
    winstonLevel: winstonLevelLabel(info.level),
    ...winstonContextMetadata(info)
  };
  addWinstonErrorMetadata(metadata, info, options.includeErrorStack === true);

  return {
    message: winstonMessage(info),
    level,
    ...(options.logger ? { logger: options.logger } : {}),
    metadata
  };
}

function timestampFromWinstonInfo(info, fallbackTimestamp) {
  const value = info?.timestamp ?? info?.time;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }
  return fallbackTimestamp();
}

function logbrewLevelFromWinstonLevel(level) {
  switch (String(level).toLowerCase()) {
    case "debug":
    case "silly":
      return "info";
    case "warn":
    case "warning":
      return "warning";
    case "error":
      return "error";
    case "crit":
    case "critical":
    case "fatal":
      return "critical";
    case "http":
    case "verbose":
    case "info":
    default:
      return "info";
  }
}

function winstonLevelLabel(level) {
  return typeof level === "string" && level.trim() !== "" ? level : "info";
}

function winstonMessage(info) {
  if (typeof info.message === "string" && info.message.trim() !== "") {
    return info.message;
  }
  const error = info.err ?? info.error;
  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim() !== "") {
    return error.message;
  }
  return "winston event";
}

function winstonContextMetadata(info) {
  const metadata = {};
  for (const [key, value] of Object.entries(info)) {
    if (!WINSTON_RESERVED_FIELDS.has(key) && isMetadataValue(value)) {
      metadata[`context.${key}`] = value;
    }
  }
  return metadata;
}

function addWinstonErrorMetadata(metadata, info, includeErrorStack) {
  const error = info.err ?? info.error;
  addWinstonNestedErrorMetadata(metadata, error, includeErrorStack);
  if (typeof info.stack === "string" && info.stack.trim() !== "") {
    const firstLine = info.stack.split(/\r?\n/u)[0] ?? "";
    const match = /^([A-Za-z][A-Za-z0-9_.]*(?:Error|Exception)?):\s*(.*)$/u.exec(firstLine);
    if (match && metadata.errorName === undefined) {
      metadata.errorName = match[1];
    }
    if (match && match[2] && metadata.errorMessage === undefined) {
      metadata.errorMessage = match[2];
    }
    if (includeErrorStack) {
      metadata.errorStack = info.stack;
    }
  }
}

function addWinstonNestedErrorMetadata(metadata, error, includeErrorStack) {
  if (!error) {
    return;
  }
  if (error instanceof Error) {
    metadata.errorName = error.name || "Error";
    if (error.message) {
      metadata.errorMessage = error.message;
    }
    if (includeErrorStack && error.stack) {
      metadata.errorStack = error.stack;
    }
    return;
  }
  if (typeof error === "object") {
    const name = error.type ?? error.name;
    const message = error.message;
    const stack = error.stack;
    if (typeof name === "string" && name.trim() !== "") {
      metadata.errorName = name;
    }
    if (typeof message === "string" && message.trim() !== "") {
      metadata.errorMessage = message;
    }
    if (includeErrorStack && typeof stack === "string" && stack.trim() !== "") {
      metadata.errorStack = stack;
    }
    return;
  }
  if (typeof error === "string" && error.trim() !== "") {
    metadata.errorMessage = error;
  }
}

function timestampFromPinoRecord(record, fallbackTimestamp) {
  const value = record?.time ?? record?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
    return value;
  }
  return fallbackTimestamp();
}

function logbrewLevelFromPinoLevel(level) {
  if (typeof level === "number" && Number.isFinite(level)) {
    if (level >= 60) {
      return "critical";
    }
    if (level >= 50) {
      return "error";
    }
    if (level >= 40) {
      return "warning";
    }
    if (level >= 30) {
      return "info";
    }
    return "info";
  }

  switch (String(level).toLowerCase()) {
    case "trace":
    case "debug":
      return "info";
    case "warn":
    case "warning":
      return "warning";
    case "error":
      return "error";
    case "fatal":
    case "critical":
      return "critical";
    case "info":
    default:
      return "info";
  }
}

function pinoLevelLabel(level) {
  if (typeof level === "string" && level.trim() !== "") {
    return level;
  }
  switch (level) {
    case 10:
      return "trace";
    case 20:
      return "debug";
    case 30:
      return "info";
    case 40:
      return "warn";
    case 50:
      return "error";
    case 60:
      return "fatal";
    default:
      return typeof level === "number" && Number.isFinite(level) ? String(level) : "info";
  }
}

function pinoMessage(record) {
  if (typeof record.msg === "string" && record.msg.trim() !== "") {
    return record.msg;
  }
  if (typeof record.message === "string" && record.message.trim() !== "") {
    return record.message;
  }
  const error = record.err ?? record.error;
  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim() !== "") {
    return error.message;
  }
  return "pino event";
}

function pinoContextMetadata(record) {
  const metadata = {};
  for (const [key, value] of Object.entries(record)) {
    if (!PINO_RESERVED_FIELDS.has(key) && isMetadataValue(value)) {
      metadata[`context.${key}`] = value;
    }
  }
  return metadata;
}

function addPinoErrorMetadata(metadata, error, includeErrorStack) {
  if (!error) {
    return;
  }
  if (error instanceof Error) {
    metadata.errorName = error.name || "Error";
    if (error.message) {
      metadata.errorMessage = error.message;
    }
    if (includeErrorStack && error.stack) {
      metadata.errorStack = error.stack;
    }
    return;
  }
  if (typeof error === "object") {
    const name = error.type ?? error.name;
    const message = error.message;
    const stack = error.stack;
    if (typeof name === "string" && name.trim() !== "") {
      metadata.errorName = name;
    }
    if (typeof message === "string" && message.trim() !== "") {
      metadata.errorMessage = message;
    }
    if (includeErrorStack && typeof stack === "string" && stack.trim() !== "") {
      metadata.errorStack = stack;
    }
    return;
  }
  if (typeof error === "string" && error.trim() !== "") {
    metadata.errorMessage = error;
  }
}

function requireNonEmpty(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SdkError("validation_error", `${label} must be non-empty`);
  }
}

function requireAllowedValue(label, value, allowedValues) {
  requireNonEmpty(label, value);
  if (!allowedValues.has(value)) {
    throw new SdkError(
      "validation_error",
      `${label} must be one of: ${Array.from(allowedValues).join(", ")}`
    );
  }
}

function requireFiniteNumber(label, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SdkError("validation_error", `${label} must be a finite number`);
  }
}

function requirePositiveInteger(label, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SdkError("validation_error", `${label} must be a positive integer`);
  }
}

function retryAfterMsOrUndefined(value) {
  if (value === undefined) {
    return undefined;
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function requireTraceId(traceId) {
  if (typeof traceId !== "string" || !/^[0-9a-fA-F]{32}$/u.test(traceId)) {
    throw new SdkError("validation_error", "traceId must be 32 lowercase or uppercase hex characters");
  }
  if (traceId.toLowerCase() === ZERO_TRACE_ID) {
    throw new SdkError("validation_error", "traceId must not be all zeros");
  }
}

function requireSpanId(label, spanId) {
  if (typeof spanId !== "string" || !/^[0-9a-fA-F]{16}$/u.test(spanId)) {
    throw new SdkError("validation_error", `${label} must be 16 lowercase or uppercase hex characters`);
  }
  if (spanId.toLowerCase() === ZERO_SPAN_ID) {
    throw new SdkError("validation_error", `${label} must not be all zeros`);
  }
}

function requireTraceFlags(traceFlags) {
  if (typeof traceFlags !== "string" || !/^[0-9a-fA-F]{2}$/u.test(traceFlags)) {
    throw new SdkError("validation_error", "traceFlags must be 2 lowercase or uppercase hex characters");
  }
}

function requireTimestamp(timestamp) {
  requireNonEmpty("timestamp", timestamp);
  if (timestamp.endsWith("Z")) {
    return;
  }
  const timePortion = timestamp.split("T")[1];
  if (timePortion && (timePortion.includes("+") || /.+-.+/.test(timePortion))) {
    return;
  }
  throw new SdkError(
    "validation_error",
    `timestamp must include a timezone offset: ${timestamp}`
  );
}

function cloneMetadata(metadata) {
  if (metadata === undefined) {
    return undefined;
  }
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new SdkError("validation_error", "metadata must be an object");
  }
  return { ...metadata };
}

function cloneSpanEvents(events) {
  return events.map((event) => event.metadata === undefined
    ? { ...event }
    : { ...event, metadata: { ...event.metadata } });
}

function cloneSpanLinks(links) {
  return links.map((link) => link.metadata === undefined
    ? { ...link }
    : { ...link, metadata: { ...link.metadata } });
}

function cloneEvent(event) {
  const attributes = { ...event.attributes };
  if (event.attributes.metadata !== undefined) {
    attributes.metadata = { ...event.attributes.metadata };
  }
  if (Array.isArray(event.attributes.events)) {
    attributes.events = cloneSpanEvents(event.attributes.events);
  }
  if (Array.isArray(event.attributes.links)) {
    attributes.links = cloneSpanLinks(event.attributes.links);
  }
  return { ...event, attributes };
}

function validateRelease(attributes) {
  requireNonEmpty("release version", attributes.version);
  if (attributes.commit !== undefined) {
    requireNonEmpty("release commit", attributes.commit);
  }
  return withMetadata({
    version: attributes.version,
    ...(attributes.commit ? { commit: attributes.commit } : {}),
    ...(attributes.notes !== undefined ? { notes: attributes.notes } : {})
  }, attributes.metadata);
}

function validateEnvironment(attributes) {
  requireNonEmpty("environment name", attributes.name);
  return withMetadata({
    name: attributes.name,
    ...(attributes.region !== undefined ? { region: attributes.region } : {})
  }, attributes.metadata);
}

function validateIssue(attributes) {
  requireNonEmpty("issue title", attributes.title);
  const level = normalizeSeverity("issue level", attributes.level);
  return withMetadata({
    title: attributes.title,
    level,
    ...(attributes.message !== undefined ? { message: attributes.message } : {})
  }, attributes.metadata);
}

function validateLog(attributes) {
  requireNonEmpty("log message", attributes.message);
  const level = normalizeSeverity("log level", attributes.level);
  return withMetadata({
    message: attributes.message,
    level,
    ...(attributes.logger !== undefined ? { logger: attributes.logger } : {})
  }, attributes.metadata);
}

function normalizeSeverity(label, value) {
  requireAllowedValue(label, value, SEVERITY_VALUES);
  return SEVERITY_ALIASES.get(value);
}

function validateSpan(attributes) {
  requireNonEmpty("span name", attributes.name);
  requireNonEmpty("span traceId", attributes.traceId);
  requireNonEmpty("span spanId", attributes.spanId);
  requireAllowedValue("span status", attributes.status, SPAN_STATUSES);
  if (attributes.parentSpanId !== undefined) {
    requireNonEmpty("span parentSpanId", attributes.parentSpanId);
  }
  if (attributes.durationMs !== undefined) {
    if (typeof attributes.durationMs !== "number" || Number.isNaN(attributes.durationMs) || attributes.durationMs < 0) {
      throw new SdkError("validation_error", "span durationMs must be non-negative");
    }
  }
  const events = validateSpanEvents(attributes.events);
  const links = validateSpanLinks(attributes.links);
  return withMetadata({
    name: attributes.name,
    traceId: attributes.traceId,
    spanId: attributes.spanId,
    status: attributes.status,
    ...(attributes.parentSpanId !== undefined ? { parentSpanId: attributes.parentSpanId } : {}),
    ...(attributes.durationMs !== undefined ? { durationMs: attributes.durationMs } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(links !== undefined ? { links } : {})
  }, attributes.metadata);
}

function validateSpanEvents(events) {
  if (events === undefined) {
    return undefined;
  }
  if (!Array.isArray(events)) {
    throw new SdkError("validation_error", "span events must be an array");
  }
  if (events.length > MAX_SPAN_EVENTS) {
    throw new SdkError("validation_error", `span events must contain at most ${MAX_SPAN_EVENTS} entries`);
  }
  if (events.length === 0) {
    return undefined;
  }

  return events.map((event) => {
    if (!event || Array.isArray(event) || typeof event !== "object") {
      throw new SdkError("validation_error", "span event must be an object");
    }
    requireNonEmpty("span event name", event.name);
    if (event.timestamp !== undefined) {
      requireTimestamp(event.timestamp);
    }
    const summary = {
      name: event.name,
      ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {})
    };
    if (event.metadata !== undefined) {
      const metadata = compactMetadata(event.metadata);
      if (Object.keys(metadata).length > 0) {
        summary.metadata = metadata;
      }
    }
    return summary;
  });
}

function validateSpanLinks(links) {
  if (links === undefined) {
    return undefined;
  }
  if (!Array.isArray(links)) {
    throw new SdkError("validation_error", "span links must be an array");
  }
  if (links.length > MAX_SPAN_LINKS) {
    throw new SdkError("validation_error", `span links must contain at most ${MAX_SPAN_LINKS} entries`);
  }
  if (links.length === 0) {
    return undefined;
  }

  return links.map((link) => {
    if (!link || Array.isArray(link) || typeof link !== "object") {
      throw new SdkError("validation_error", "span link must be an object");
    }
    requireTraceId(link.traceId);
    requireSpanId("span link spanId", link.spanId);
    if (link.sampled !== undefined && typeof link.sampled !== "boolean") {
      throw new SdkError("validation_error", "span link sampled must be a boolean");
    }
    const summary = {
      traceId: link.traceId.toLowerCase(),
      spanId: link.spanId.toLowerCase(),
      ...(link.sampled !== undefined ? { sampled: link.sampled } : {})
    };
    if (link.metadata !== undefined) {
      const metadata = compactMetadata(link.metadata);
      if (Object.keys(metadata).length > 0) {
        summary.metadata = metadata;
      }
    }
    return summary;
  });
}

function validateAction(attributes) {
  requireNonEmpty("action name", attributes.name);
  requireAllowedValue("action status", attributes.status, ACTION_STATUSES);
  return withMetadata({
    name: attributes.name,
    status: attributes.status
  }, attributes.metadata);
}

function validateMetric(attributes) {
  requireNonEmpty("metric name", attributes.name);
  requireAllowedValue("metric kind", attributes.kind, METRIC_KINDS);
  requireFiniteNumber("metric value", attributes.value);
  requireNonEmpty("metric unit", attributes.unit);

  const allowedTemporalities = METRIC_TEMPORALITIES_BY_KIND.get(attributes.kind);
  requireAllowedValue(`metric temporality for ${attributes.kind}`, attributes.temporality, allowedTemporalities);
  if (NON_NEGATIVE_METRIC_KINDS.has(attributes.kind) && attributes.value < 0) {
    throw new SdkError("validation_error", `metric ${attributes.kind} value must be non-negative`);
  }

  return withMetadata({
    name: attributes.name,
    kind: attributes.kind,
    value: attributes.value,
    unit: attributes.unit,
    temporality: attributes.temporality
  }, attributes.metadata);
}

function productActionDetails(action) {
  if (typeof action === "string") {
    return { name: action, status: "success" };
  }
  if (!action || Array.isArray(action) || typeof action !== "object") {
    throw new SdkError("validation_error", "product action must be a string or object");
  }
  requireNonEmpty("product action name", action.name);
  const status = action.status === undefined ? "success" : action.status;
  requireAllowedValue("product action status", status, ACTION_STATUSES);
  return {
    funnel: action.funnel,
    metadata: action.metadata,
    name: action.name,
    routeTemplate: action.routeTemplate,
    screen: action.screen,
    sessionId: action.sessionId,
    status,
    step: action.step,
    traceId: action.traceId
  };
}

function networkMilestoneDetails(request) {
  if (typeof request === "string") {
    return networkMilestoneDetails({ routeTemplate: request });
  }
  if (!request || Array.isArray(request) || typeof request !== "object") {
    throw new SdkError("validation_error", "network milestone must be a string or object");
  }

  const routeTemplate = sanitizeRouteTemplate(request.routeTemplate);
  requireNonEmpty("network milestone routeTemplate", routeTemplate);
  const method = normalizeHttpMethod(request.method);
  const statusCode = statusCodeOrUndefined(request.statusCode);
  const status = request.status === undefined
    ? statusFromStatusCode(statusCode)
    : request.status;
  requireAllowedValue("network milestone status", status, ACTION_STATUSES);
  const durationMs = nonNegativeNumberOrUndefined("network milestone durationMs", request.durationMs);
  const name = typeof request.name === "string" && request.name.trim() !== ""
    ? request.name
    : `network.${method.toLowerCase()} ${routeTemplate}`;

  return {
    durationMs,
    metadata: request.metadata,
    method,
    name,
    routeTemplate,
    sessionId: request.sessionId,
    status,
    statusCode,
    traceId: request.traceId
  };
}

function sanitizeRouteTemplate(routeTemplate) {
  if (routeTemplate === undefined) {
    return undefined;
  }
  if (typeof routeTemplate !== "string") {
    throw new SdkError("validation_error", "routeTemplate must be a string");
  }
  const trimmed = routeTemplate.trim();
  if (trimmed === "") {
    return "";
  }
  try {
    const url = new URL(trimmed, "https://logbrew.example");
    return url.pathname || "/";
  } catch {
    return trimmed.split(/[?#]/u)[0] || "/";
  }
}

function normalizeHttpMethod(method) {
  const value = method === undefined ? "GET" : method;
  if (typeof value !== "string" || value.trim() === "") {
    throw new SdkError("validation_error", "network milestone method must be a non-empty string");
  }
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]*$/u.test(normalized)) {
    throw new SdkError("validation_error", "network milestone method must be a valid HTTP method");
  }
  return normalized;
}

function statusCodeOrUndefined(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new SdkError("validation_error", "network milestone statusCode must be an integer from 100 to 599");
  }
  return value;
}

function statusFromStatusCode(statusCode) {
  if (statusCode !== undefined && statusCode >= 400) {
    return "failure";
  }
  return "success";
}

function nonNegativeNumberOrUndefined(label, value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SdkError("validation_error", `${label} must be a non-negative number`);
  }
  return value;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function withMetadata(attributes, metadata) {
  const safeMetadata = cloneMetadata(metadata);
  return safeMetadata === undefined
    ? attributes
    : { ...attributes, metadata: safeMetadata };
}

function compactMetadata(metadata) {
  if (metadata === undefined) {
    return {};
  }
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new SdkError("validation_error", "metadata must be an object");
  }
  const safeMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isMetadataValue(value)) {
      safeMetadata[key] = value;
    }
  }
  return safeMetadata;
}

function isMetadataValue(value) {
  return (
    value === null
    || typeof value === "string"
    || typeof value === "number" && Number.isFinite(value)
    || typeof value === "boolean"
  );
}

function normalizeConsoleLevels(levels) {
  const requestedLevels = levels === undefined ? DEFAULT_CONSOLE_LEVELS : levels;
  if (!Array.isArray(requestedLevels)) {
    throw new SdkError("validation_error", "console capture levels must be an array");
  }
  const normalized = [];
  for (const method of requestedLevels) {
    if (!CONSOLE_METHODS.has(method)) {
      throw new SdkError("validation_error", `console method must be one of: ${Array.from(CONSOLE_METHODS).join(", ")}`);
    }
    if (!normalized.includes(method)) {
      normalized.push(method);
    }
  }
  return normalized;
}

function consoleMessage(args, includeErrorStack) {
  const values = Array.isArray(args) ? args : [];
  const message = values.map((value) => formatConsoleArgument(value, includeErrorStack)).join(" ");
  return message.trim() === "" ? "console event" : message;
}

function formatConsoleArgument(value, includeErrorStack) {
  if (value instanceof Error) {
    if (includeErrorStack && value.stack) {
      return value.stack;
    }
    return value.message ? `${value.name}: ${value.message}` : value.name;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

module.exports = {
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createSupportTicketDraft,
  createTraceparent,
  createTraceparentHeaders,
  createLogBrewPinoDestination,
  createLogBrewWinstonTransport,
  installLogBrewConsoleCapture,
  LogBrewClient,
  logAttributesFromConsoleArgs,
  logAttributesFromPinoRecord,
  logAttributesFromWinstonInfo,
  logbrewLevelFromConsoleMethod,
  parseTraceparent,
  RecordingTransport,
  SdkError,
  spanAttributesFromTraceparent,
  TransportError
};
