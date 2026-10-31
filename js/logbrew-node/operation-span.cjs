"use strict";

const { SdkError } = require("@logbrew/sdk");
const { createAutomaticEventId } = require("./automatic-event-id.cjs");
const { applyFunction } = require("./internal.cjs");
const { createChildTraceContext, getActiveLogBrewTrace, runWithLogBrewTrace } = require("./active-trace.cjs");
const { durationSince, emitSpan, errorType, filteredMetadata, hasClient, nowMs, slugify, spanEvents } = require("./span-support.cjs");
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
const EDGE_UNDERSCORES = /^_+|_+$/gu;
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
  return value.trim().toLowerCase().replaceAll(UNSAFE_LABEL_CHARACTERS, "_").replaceAll(EDGE_UNDERSCORES, "") || fallback;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeOperationKind(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "operation";
  }
  const normalized = value.trim().replaceAll(UNSAFE_KIND_CHARACTERS, "_").replaceAll(EDGE_UNDERSCORES, "");
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
 * @param {CheckedOperationOptions} options
 * @param {OperationOutcome} outcome
 * @returns {Promise<void>}
 */
async function captureOperationSpan(options, outcome) {
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
 * @param {OperationKind} kind
 * @param {string} operationName
 * @param {CheckedOperationOptions} options
 * @returns {Promise<unknown>}
 */
async function runOperation(kind, operationName, options) {
  const { base, startedAt } = planOperation(kind, operationName, options);
  const { trace } = base;
  try {
    const result = await runWithLogBrewTrace(trace, () => applyFunction(options.operation, undefined, []));
    await captureOperationSpan(options, { ...base, durationMs: durationSince(options, startedAt) });
    return result;
  } catch (error) {
    await captureOperationSpan(options, { ...base, durationMs: durationSince(options, startedAt), error });
    throw error;
  }
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
