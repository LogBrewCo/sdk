"use strict";

const { SdkError, createIssueAttributesFromError } = require("@logbrew/sdk");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");
const { addLogBrewBreadcrumb, inheritBreadcrumbs } = require("./breadcrumbs.cjs");
const { applyFunction, trimUnderscores } = require("./internal.cjs");
const { createChildTraceContext, getActiveLogBrewTrace, inheritLogBrewUser, runWithLogBrewTrace } = require("./active-trace.cjs");
const {
  durationSince,
  emitSpan,
  errorType,
  filteredMetadata,
  hasClient,
  notifyQuietly,
  nowMs,
  slugify,
  spanEvents,
  spanTimestamp
} = require("./span-support.cjs");
const { createLogBrewQueueBatchSpanOptions, resolveOperationTrace } = require("./trace-context.cjs");

/**
 * @import { LogBrewTraceContext } from "./index.cjs"
 * @import { ClientSpanOptions, SpanOptions } from "./span-support.cjs"
 */

/**
 * @typedef {"cache" | "database" | "queue"} OperationKind
 * @typedef {SpanOptions & Readonly<{
 *   cacheName?: unknown,
 *   databaseName?: unknown,
 *   events?: unknown,
 *   hit?: unknown,
 *   id?: unknown,
 *   itemCount?: unknown,
 *   itemSizeBytes?: unknown,
 *   messageCount?: unknown,
 *   metadata?: unknown,
 *   operation?: unknown,
 *   operationKind?: unknown,
 *   queueName?: unknown,
 *   rowCount?: unknown,
 *   spanIdFactory?: unknown,
 *   statementTemplate?: unknown,
 *   system?: unknown,
 *   taskName?: unknown,
 *   trace?: LogBrewTraceContext | undefined,
 *   traceIdFactory?: unknown,
 *   traceparent?: unknown
 * }>} OperationOptions
 * @typedef {OperationOptions & ClientSpanOptions & Readonly<{ operation: () => unknown }>} CheckedOperationOptions
 * @typedef {Readonly<{
 *   durationMs: number,
 *   error?: unknown,
 *   id: unknown,
 *   kind: OperationKind,
 *   operationKind: string,
 *   operationName: string,
 *   system: string,
 *   trace: LogBrewTraceContext
 * }>} OperationOutcome
 */

const NO_COUNT = 0;
const SINGLE_MESSAGE = 1;
const UNSAFE_LABEL_CHARACTERS = /[^a-z0-9_.:-]+/gu;
const UNSAFE_KIND_CHARACTERS = /[^a-z0-9_.:-]+/giu;
const BLOCKED_METADATA_KEYS = {
  cache: new Set(["cachekey", "command", "cookie", "headers", "key", "rawcommand", ["se", "cret"].join(""), ["to", "ken"].join(""), "value"]),
  database: new Set([
    "authorization",
    "connection",
    "connectionstring",
    "cookie",
    "dbquery",
    "dbquerytext",
    "dbstatement",
    "headers",
    "host",
    "params",
    "parameters",
    ["pass", "word"].join(""),
    "query",
    "rawquery",
    ["se", "cret"].join(""),
    "sql",
    "sqltext",
    "statement",
    ["to", "ken"].join(""),
    "url",
    "user",
    "username"
  ]),
  queue: new Set([
    "args",
    "body",
    "brokerurl",
    "cookie",
    "headers",
    "message",
    "messagebody",
    "payload",
    "rawmessage",
    ["se", "cret"].join(""),
    ["to", "ken"].join(""),
    "url"
  ])
};

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeOperationLabel(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  return trimUnderscores(value.trim().toLowerCase().replaceAll(UNSAFE_LABEL_CHARACTERS, "_")) || fallback;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeOperationKind(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "operation";
  }
  const normalized = trimUnderscores(value.trim().replaceAll(UNSAFE_KIND_CHARACTERS, "_"));
  return normalized.toUpperCase() === normalized ? normalized : normalized.toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function trimmedText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function wholeCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(NO_COUNT, Math.trunc(value)) : undefined;
}

/**
 * @param {OperationOptions} options
 * @returns {Record<string, unknown>}
 */
function databaseFields(options) {
  const databaseName = trimmedText(options.databaseName);
  const statementTemplate = trimmedText(options.statementTemplate);
  const rowCount = wholeCount(options.rowCount);
  return {
    ...(databaseName === undefined ? {} : { "db.namespace": databaseName, dbName: databaseName }),
    ...(statementTemplate === undefined ? {} : { dbStatementTemplate: statementTemplate }),
    ...(rowCount === undefined ? {} : { rowCount })
  };
}

/**
 * @param {OperationKind} kind
 * @param {OperationOptions} options
 * @param {Readonly<{ operationKind: string, system: string }>} labels
 * @returns {Record<string, unknown>}
 */
function semanticFields(kind, options, { operationKind, system }) {
  if (kind === "cache") {
    const cacheName = trimmedText(options.cacheName);
    return {
      "db.system.name": system,

      "db.operation.name": operationKind,
      ...(cacheName === undefined ? {} : { "db.namespace": cacheName })
    };
  }
  if (kind === "queue") {
    const queueName = trimmedText(options.queueName);
    const messageCount = wholeCount(options.messageCount);
    return {
      "messaging.system": system,

      "messaging.operation.name": operationKind,
      "messaging.operation.type": operationKind,
      ...(queueName === undefined ? {} : { "messaging.destination.name": queueName }),
      ...(messageCount !== undefined && messageCount > SINGLE_MESSAGE ? { "messaging.batch.message_count": messageCount } : {})
    };
  }
  return {};
}

/**
 * @param {OperationKind} kind
 * @param {OperationOptions} options
 * @returns {Record<string, unknown>}
 */
function detailFields(kind, options) {
  if (kind === "cache") {
    const cacheName = trimmedText(options.cacheName);
    const itemSizeBytes = wholeCount(options.itemSizeBytes);
    const itemCount = wholeCount(options.itemCount);
    return {
      ...(cacheName === undefined ? {} : { cacheName }),
      ...(typeof options.hit === "boolean" ? { cacheHit: options.hit } : {}),
      ...(itemSizeBytes === undefined ? {} : { itemSizeBytes }),
      ...(itemCount === undefined ? {} : { itemCount })
    };
  }
  const queueName = trimmedText(options.queueName);
  const taskName = trimmedText(options.taskName);
  const messageCount = wholeCount(options.messageCount);
  return {
    ...(queueName === undefined ? {} : { queueName }),
    ...(taskName === undefined ? {} : { taskName }),
    ...(messageCount === undefined ? {} : { messageCount })
  };
}

/**
 * @param {CheckedOperationOptions} options
 * @param {OperationOutcome} outcome
 * @returns {Record<string, unknown>}
 */
function operationMetadata(options, { error, kind, operationKind, operationName, system, trace }) {
  const blocked = BLOCKED_METADATA_KEYS[kind];
  const safeMetadata = filteredMetadata(options.metadata, (key) => blocked.has(key));
  if (kind === "database") {
    return {
      ...safeMetadata,
      framework: "node:database",

      "db.system.name": system,

      "db.operation.name": operationKind,
      dbSystem: system,

      dbOperation: operationName.trim(),
      dbOperationKind: operationKind,
      sampled: trace.sampled,
      ...databaseFields(options),
      ...(error === undefined ? {} : { errorType: errorType(error) })
    };
  }
  return {
    ...safeMetadata,
    framework: `node:${kind}`,
    ...semanticFields(kind, options, { operationKind, system }),
    [`${kind}System`]: system,
    [`${kind}Operation`]: operationName.trim(),
    [`${kind}OperationKind`]: operationKind,
    sampled: trace.sampled,
    ...detailFields(kind, options),
    ...(error === undefined ? {} : { errorType: errorType(error) })
  };
}

/**
 * @param {OperationKind} kind
 * @param {string} operationKind
 * @returns {string}
 */
function durationMetricName(kind, operationKind) {
  if (kind === "database") {
    return "db.client.operation.duration";
  }
  if (kind === "cache") {
    return "cache.operation.duration";
  }
  return operationKind === "process" ? "messaging.process.duration" : "messaging.client.operation.duration";
}

/**
 * @param {CheckedOperationOptions} options
 * @param {Omit<OperationOutcome, "durationMs" | "error" | "id" | "trace">} outcome
 * @returns {string}
 */
function operationLabel(options, { kind, operationKind, operationName, system }) {
  const target = kind === "queue" ? trimmedText(options.queueName) ?? operationName.trim() : operationName.trim();
  return `${system} ${operationKind} ${target}`;
}

/**
 * @param {CheckedOperationOptions} options
 * @param {OperationOutcome} outcome
 * @returns {Readonly<Record<string, string | number | boolean>>}
 */
function outcomeMetadata(options, { error, kind, operationKind, operationName, system }) {
  return {
    framework: `node:${kind}`,
    ...(kind === "database" ? { "db.system.name": system, "db.operation.name": operationKind } : semanticFields(kind, options, { operationKind, system })),
    operation: operationName.trim(),
    status: error === undefined ? "ok" : "error",
    ...(error === undefined ? {} : { errorType: errorType(error) })
  };
}

/**
 * @param {CheckedOperationOptions} options
 * @param {OperationOutcome} outcome
 * @returns {void}
 */
function captureOperationOutcome(options, outcome) {
  const { client } = options;
  const { error, kind, operationKind, system, trace } = outcome;
  const label = operationLabel(options, outcome);
  const timestamp = spanTimestamp(options);
  const metadata = outcomeMetadata(options, outcome);
  client.metric(createAutomaticEventId(`evt_node_${kind}_metric`, slugify(label)), timestamp, {
    name: durationMetricName(kind, operationKind),
    description: `Duration of one ${kind} operation.`,
    kind: "histogram",
    value: outcome.durationMs,
    unit: "ms",
    temporality: "delta",
    metadata
  });
  if (error !== undefined) {
    const { errorType: _, status: __, ...issueMetadata } = metadata;
    client.issue(
      createAutomaticEventId(`evt_node_${kind}_issue`, slugify(label)),
      timestamp,
      createIssueAttributesFromError(error, {
        title: `${label} failed`,
        message: `${String(metadata.errorType ?? "Error")} in ${label}`,
        mechanism: `${system}.${operationKind}`.toLowerCase(),
        handled: !(kind === "queue" && operationKind === "process"),
        source: `node.${kind}`,
        trace,
        metadata: issueMetadata
      })
    );
  }
}

/**
 * @param {CheckedOperationOptions} options
 * @param {OperationOutcome} outcome
 * @returns {Promise<void>}
 */
async function captureOperation(options, outcome) {
  const { error, operationKind, operationName, system, trace } = outcome;
  const metadata = operationMetadata(options, outcome);
  const events = spanEvents(options.events, error);
  await emitSpan(
    options,
    {
      durationMs: outcome.durationMs,
      events,
      id: outcome.id,
      metadata,
      name: `${system} ${operationKind} ${operationName.trim()}`,
      status: error === undefined ? "ok" : "error",
      trace
    },
    { client: options.client, error, trace }
  );
  try {
    captureOperationOutcome(options, outcome);
  } catch (captureError) {
    await notifyQuietly(options, captureError, { client: options.client, error, trace });
  }
}

/**
 * @param {string} helperName
 * @param {unknown} operationName
 * @param {OperationOptions} options
 * @returns {asserts options is CheckedOperationOptions}
 */
function validateOperation(helperName, operationName, options) {
  if (typeof operationName !== "string" || operationName.trim() === "") {
    throw new SdkError("configuration_error", `${helperName} requires a non-empty operation name`);
  }
  if (!hasClient(options)) {
    throw new SdkError("configuration_error", `${helperName} requires client`);
  }
  if (typeof options.operation !== "function") {
    throw new SdkError("configuration_error", `${helperName} requires operation`);
  }
}

/**
 * @param {OperationKind} kind
 * @param {CheckedOperationOptions} options
 * @returns {LogBrewTraceContext | undefined}
 */
function operationParent(kind, options) {
  return kind === "database" ? options.trace ?? getActiveLogBrewTrace() : resolveOperationTrace(options, getActiveLogBrewTrace());
}

/**
 * @param {OperationKind} kind
 * @param {string} operationName
 * @param {CheckedOperationOptions} options
 * @returns {Readonly<{ base: Omit<OperationOutcome, "durationMs" | "error">, startedAt: number }>}
 */
function planOperation(kind, operationName, options) {
  const system = normalizeOperationLabel(options.system, kind);
  const operationKind = normalizeOperationKind(options.operationKind);
  const startedAt = nowMs(options);
  const trace = createChildTraceContext(`${kind}OperationWithLogBrewSpan`, operationParent(kind, options), options);
  const id = options.id ?? createAutomaticEventId(`evt_node_${kind}`, slugify(`${system}_${operationKind}_${operationName}`));
  return { base: { id, kind, operationKind, operationName, system, trace }, startedAt };
}

/**
 * Runs inside the operation's trace, so its span, metric, and issue carry that trace and the user set during it.
 * @param {CheckedOperationOptions} options
 * @param {Omit<OperationOutcome, "durationMs" | "error">} base
 * @param {number} startedAt
 * @returns {Promise<Readonly<{ failed: false, value: unknown } | { failed: true, error: unknown }>>}
 */
async function settleInScope(options, base, startedAt) {
  /** @type {Readonly<{ failed: false, value: unknown } | { failed: true, error: unknown }>} */
  let settled;
  try {
    settled = { failed: false, value: await applyFunction(options.operation, undefined, []) };
  } catch (error) {
    settled = { failed: true, error };
  }
  await captureOperation(options, { ...base, durationMs: durationSince(options, startedAt), ...(settled.failed ? { error: settled.error } : {}) });
  return settled;
}

/**
 * @param {OperationKind} kind
 * @param {string} operationName
 * @param {CheckedOperationOptions} options
 * @returns {Promise<unknown>}
 */
async function runOperation(kind, operationName, options) {
  const { base, startedAt } = planOperation(kind, operationName, options);
  const scope = getActiveLogBrewTrace();
  inheritLogBrewUser(base.trace, scope);
  inheritBreadcrumbs(base.trace, scope);
  const settled = await runWithLogBrewTrace(base.trace, () => settleInScope(options, base, startedAt));
  addLogBrewBreadcrumb(
    {
      type: kind === "database" ? "query" : "default",
      category: `${kind}.${base.system}`,
      level: settled.failed ? "error" : "info",
      message: operationLabel(options, base)
    },
    getActiveLogBrewTrace
  );
  if (settled.failed) {
    throw settled.error;
  }
  return settled.value;
}

/**
 * @param {unknown} operationName
 * @param {OperationOptions} [options]
 * @returns {Promise<unknown>}
 */
async function databaseOperationWithLogBrewSpan(operationName, options = {}) {
  validateOperation("databaseOperationWithLogBrewSpan", operationName, options);
  return runOperation("database", String(operationName), options);
}

/**
 * @param {unknown} operationName
 * @param {OperationOptions} [options]
 * @returns {Promise<unknown>}
 */
async function cacheOperationWithLogBrewSpan(operationName, options = {}) {
  validateOperation("cacheOperationWithLogBrewSpan", operationName, options);
  return runOperation("cache", String(operationName), options);
}

/**
 * @param {unknown} operationName
 * @param {OperationOptions} [options]
 * @returns {Promise<unknown>}
 */
async function queueOperationWithLogBrewSpan(operationName, options = {}) {
  validateOperation("queueOperationWithLogBrewSpan", operationName, options);
  return runOperation("queue", String(operationName), options);
}

/**
 * @param {unknown} operationName
 * @param {OperationOptions} [options]
 * @returns {Promise<unknown>}
 */
async function queueBatchOperationWithLogBrewSpan(operationName, options = {}) {
  return queueOperationWithLogBrewSpan(operationName, createLogBrewQueueBatchSpanOptions(options));
}

module.exports = {
  cacheOperationWithLogBrewSpan,
  databaseOperationWithLogBrewSpan,
  queueBatchOperationWithLogBrewSpan,
  queueOperationWithLogBrewSpan
};
