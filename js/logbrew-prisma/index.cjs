"use strict";

const { SdkError } = require("@logbrew/sdk");
const { databaseOperationWithLogBrewSpan } = require("@logbrew/node");

/**
 * @import { DatabaseOperationWithLogBrewSpanOptions } from "@logbrew/node"
 * @import {
 *   LogBrewPrismaExtension,
 *   LogBrewPrismaInstrumentation,
 *   LogBrewPrismaOperationContext,
 *   LogBrewPrismaSpanOptions
 * } from "./index.cjs"
 * @typedef {LogBrewPrismaSpanOptions & { readonly shouldCapture?: () => boolean }} LogBrewPrismaExtensionOptions
 * @typedef {{ readonly $extends: (extension: LogBrewPrismaExtension) => unknown }} ExtensiblePrismaClient
 */

const DEFAULT_SYSTEM = "prisma";
const DEFAULT_OPERATION = "operation";
const DEFAULT_MODEL_OPERATION_NAME = "client";
const MAX_OPERATION_LENGTH = 64;
const MAX_MODEL_LENGTH = 80;
const LABEL_START = 0;

/**
 * @param {unknown} value
 * @param {string} fallback
 * @param {number} maxLength
 * @returns {string}
 */
function normalizeLabel(value, fallback, maxLength) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().replaceAll(/[^\w.:-]+/gu, "_").replaceAll(/^_+|_+$/gu, "");
  if (normalized === "") {
    return fallback;
  }
  return normalized.slice(LABEL_START, maxLength);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeOptionalLabel(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const normalized = normalizeLabel(value, "", MAX_MODEL_LENGTH);
  return normalized === "" ? undefined : normalized;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizePrismaOperation(value) {
  const rawValue = typeof value === "string" ? value.trim().replace(/^\$/u, "") : "";
  return normalizeLabel(rawValue, DEFAULT_OPERATION, MAX_OPERATION_LENGTH);
}

/**
 * @param {unknown} result
 * @returns {number | undefined}
 */
function inferPrismaRowCount(result) {
  if (Array.isArray(result)) {
    return result.length;
  }
  if (typeof result === "number" && Number.isFinite(result)) {
    return result;
  }
  return undefined;
}

/**
 * @template Result
 * @param {LogBrewPrismaOperationContext<Result> | undefined} context
 * @returns {Result | Promise<Result>}
 */
function callPrismaQuery(context) {
  if (typeof context?.query !== "function") {
    throw new SdkError("configuration_error", "LogBrew Prisma instrumentation requires a Prisma query function");
  }
  return context.query(context.args);
}

/**
 * @param {LogBrewPrismaSpanOptions | undefined} options
 * @param {string} caller
 * @returns {LogBrewPrismaSpanOptions}
 */
function requireSpanOptions(options, caller) {
  const client = options?.client;
  if (!client) {
    throw new SdkError("configuration_error", `${caller} requires client`);
  }
  return { ...options, client };
}

/**
 * @template Result
 * @param {LogBrewPrismaOperationContext<Result> | null | undefined} context
 * @param {LogBrewPrismaSpanOptions} [options]
 * @returns {Promise<Awaited<Result>>}
 */
async function prismaOperationWithLogBrewSpan(context, options) {
  const spanOptions = requireSpanOptions(options, "prismaOperationWithLogBrewSpan");
  if (typeof context !== "object" || context === null) {
    throw new SdkError("configuration_error", "prismaOperationWithLogBrewSpan requires a Prisma operation context");
  }
  const action = normalizePrismaOperation(context.operation);
  const model = normalizeOptionalLabel(context.model);
  const { databaseName: rawDatabaseName, ...rest } = spanOptions;
  const databaseName = normalizeOptionalLabel(rawDatabaseName);
  /** @type {DatabaseOperationWithLogBrewSpanOptions<Result>} */
  const operationOptions = {
    ...rest,
    ...(databaseName === undefined ? {} : { databaseName }),
    metadata: { ...rest.metadata, prismaAction: action, ...(model === undefined ? {} : { prismaModel: model }) },
    async operation() {
      const result = await callPrismaQuery(context);
      const rowCount = inferPrismaRowCount(result);
      if (rowCount !== undefined) {
        operationOptions.rowCount = rowCount;
      }
      return result;
    },
    operationKind: action,
    statementTemplate: model === undefined ? `${DEFAULT_SYSTEM}.${action}` : `${model}.${action}`,
    system: DEFAULT_SYSTEM
  };
  return databaseOperationWithLogBrewSpan(model ?? DEFAULT_MODEL_OPERATION_NAME, operationOptions);
}

/**
 * @param {LogBrewPrismaExtensionOptions} [options]
 * @returns {LogBrewPrismaExtension}
 */
function createLogBrewPrismaExtension(options) {
  const spanOptions = requireSpanOptions(options, "createLogBrewPrismaExtension");
  const shouldCapture = options?.shouldCapture;
  return Object.freeze({
    name: "logbrew",
    query: Object.freeze({
      /**
       * @template Result
       * @param {LogBrewPrismaOperationContext<Result>} context
       * @returns {Promise<Awaited<Result>>}
       */
      async $allOperations(context) {
        if (shouldCapture?.() === false) {
          const result = await callPrismaQuery(context);
          return result;
        }
        return prismaOperationWithLogBrewSpan(context, spanOptions);
      }
    })
  });
}

/**
 * @param {unknown} value
 * @returns {value is ExtensiblePrismaClient}
 */
function isExtensiblePrismaClient(value) {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "$extends") === "function";
}

/**
 * @param {unknown} prismaClient
 * @param {LogBrewPrismaSpanOptions} [options]
 * @returns {LogBrewPrismaInstrumentation<unknown>}
 */
function instrumentLogBrewPrismaClient(prismaClient, options) {
  if (!isExtensiblePrismaClient(prismaClient)) {
    throw new SdkError("configuration_error", "instrumentLogBrewPrismaClient requires a PrismaClient with $extends");
  }
  const state = { installed: true };
  const extension = createLogBrewPrismaExtension({
    ...requireSpanOptions(options, "createLogBrewPrismaExtension"),
    shouldCapture: () => state.installed
  });
  const client = prismaClient.$extends(extension);
  return Object.freeze({
    client,
    isInstalled() {
      return state.installed;
    },
    uninstall() {
      state.installed = false;
    }
  });
}

module.exports = Object.freeze({
  createLogBrewPrismaExtension,
  instrumentLogBrewPrismaClient,
  prismaOperationWithLogBrewSpan
});
