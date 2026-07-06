"use strict";

const { SdkError } = require("@logbrew/sdk");
const { databaseOperationWithLogBrewSpan } = require("@logbrew/node");

const DEFAULT_SYSTEM = "prisma";
const DEFAULT_OPERATION = "operation";
const DEFAULT_MODEL_OPERATION_NAME = "client";
const MAX_OPERATION_LENGTH = 64;
const MAX_MODEL_LENGTH = 80;

function createLogBrewPrismaExtension(options = {}) {
  if (!options.client) {
    throw new SdkError("configuration_error", "createLogBrewPrismaExtension requires client");
  }

  return Object.freeze({
    name: "logbrew",
    query: Object.freeze({
      async $allOperations(context) {
        if (typeof options.shouldCapture === "function" && options.shouldCapture() === false) {
          return callPrismaQuery(context);
        }
        return prismaOperationWithLogBrewSpan(context, options);
      }
    })
  });
}

function instrumentLogBrewPrismaClient(prismaClient, options = {}) {
  if (!prismaClient || typeof prismaClient.$extends !== "function") {
    throw new SdkError("configuration_error", "instrumentLogBrewPrismaClient requires a PrismaClient with $extends");
  }

  let installed = true;
  const extension = createLogBrewPrismaExtension({
    ...options,
    shouldCapture: () => installed
  });
  const client = prismaClient.$extends(extension);

  return Object.freeze({
    client,
    isInstalled() {
      return installed;
    },
    uninstall() {
      installed = false;
    }
  });
}

async function prismaOperationWithLogBrewSpan(context, options = {}) {
  if (!options.client) {
    throw new SdkError("configuration_error", "prismaOperationWithLogBrewSpan requires client");
  }
  if (!context || typeof context !== "object") {
    throw new SdkError("configuration_error", "prismaOperationWithLogBrewSpan requires a Prisma operation context");
  }

  const action = normalizePrismaOperation(context.operation);
  const model = normalizePrismaModel(context.model);
  const operationName = model ?? DEFAULT_MODEL_OPERATION_NAME;
  const statementTemplate = model ? `${model}.${action}` : `${DEFAULT_SYSTEM}.${action}`;
  const spanOptions = {
    ...options,
    databaseName: normalizeOptionalLabel(options.databaseName),
    metadata: {
      ...options.metadata,
      prismaAction: action,
      ...(model ? { prismaModel: model } : {})
    },
    operation: async () => {
      const result = await callPrismaQuery(context);
      const rowCount = inferPrismaRowCount(result);
      if (rowCount !== undefined) {
        spanOptions.rowCount = rowCount;
      }
      return result;
    },
    operationKind: action,
    statementTemplate,
    system: DEFAULT_SYSTEM
  };

  return databaseOperationWithLogBrewSpan(operationName, spanOptions);
}

function callPrismaQuery(context) {
  if (!context || typeof context.query !== "function") {
    throw new SdkError("configuration_error", "LogBrew Prisma instrumentation requires a Prisma query function");
  }
  return context.query(context.args);
}

function inferPrismaRowCount(result) {
  if (Array.isArray(result)) {
    return result.length;
  }
  if (Number.isFinite(result)) {
    return result;
  }
  return undefined;
}

function normalizePrismaOperation(value) {
  const rawValue = typeof value === "string" ? value.trim().replace(/^\$/u, "") : "";
  return normalizeLabel(rawValue, DEFAULT_OPERATION, MAX_OPERATION_LENGTH);
}

function normalizePrismaModel(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return normalizeLabel(value, undefined, MAX_MODEL_LENGTH);
}

function normalizeOptionalLabel(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return normalizeLabel(value, undefined, MAX_MODEL_LENGTH);
}

function normalizeLabel(value, fallback, maxLength) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().replace(/[^a-z0-9_.:-]+/gi, "_").replace(/^_+|_+$/g, "");
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, maxLength);
}

module.exports = Object.freeze({
  createLogBrewPrismaExtension,
  instrumentLogBrewPrismaClient,
  prismaOperationWithLogBrewSpan
});
