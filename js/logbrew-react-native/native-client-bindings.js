import { isRecord, readField } from "./native-diagnostics-values.js";
import { DeviceEventEmitter } from "react-native";
import { NATIVE_CLEAR } from "./native-null.js";
import { platformOS } from "./native-module-lookup.js";
import { syncLogBrewAppleNativeCrashBreadcrumbs } from "./apple-native-diagnostics-module.js";

/**
 * @import { LogBrewClient, Transport, TransportResponse } from "@logbrew/sdk"
 * @typedef {readonly [readonly unknown[], unknown]} BreadcrumbState
 */

const SCHEMA_VERSION = 1;
const NO_BREADCRUMBS = 0;
const FIRST_INDEX = 0;
const IGNORED_SYNC_CODES = new Set(["native_diagnostics_not_installed", "native_diagnostics_unavailable"]);

/**
 * @param {unknown} value
 * @returns {value is unknown[]}
 */
function isMutableList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * @param {Readonly<LogBrewClient>} client
 * @returns {unknown[]}
 */
function issueBreadcrumbs(client) {
  /** @type {unknown} */
  const breadcrumbs = Reflect.get(client, "issueBreadcrumbs");
  if (!isMutableList(breadcrumbs)) {
    throw new TypeError("client issueBreadcrumbs must be an array");
  }
  return breadcrumbs;
}

/**
 * @param {Readonly<LogBrewClient>} client
 * @returns {unknown}
 */
function issueBreadcrumbsTruncated(client) {
  /** @type {unknown} */
  const truncated = Reflect.get(client, "issueBreadcrumbsTruncated");
  return truncated;
}

/**
 * @param {unknown} entry
 * @returns {Record<string, unknown>}
 */
function snapshotBreadcrumb(entry) {
  if (!isRecord(entry)) {
    throw new TypeError("client breadcrumbs must be objects");
  }
  const { data, ...breadcrumb } = entry;
  if (data === undefined) {
    return { ...breadcrumb };
  }
  return { ...breadcrumb, data: isObjectLike(data) ? { ...data } : {} };
}

/**
 * @param {Readonly<LogBrewClient>} client
 */
function syncAppleNativeCrashBreadcrumbs(client) {
  const breadcrumbs = issueBreadcrumbs(client);
  const snapshot = breadcrumbs.length === NO_BREADCRUMBS
    ? NATIVE_CLEAR
    : {
        breadcrumbs: breadcrumbs.map(entry => snapshotBreadcrumb(entry)),
        schemaVersion: SCHEMA_VERSION,
        truncated: issueBreadcrumbsTruncated(client)
      };
  try {
    syncLogBrewAppleNativeCrashBreadcrumbs(snapshot);
  } catch (error) {
    const code = readField(error, "code");
    if (typeof code !== "string" || !IGNORED_SYNC_CODES.has(code)) {
      throw error;
    }
  }
}

/**
 * @param {Readonly<LogBrewClient>} client
 * @param {BreadcrumbState} previous
 */
function restoreBreadcrumbs(client, previous) {
  const [breadcrumbs, truncated] = previous;
  const current = issueBreadcrumbs(client);
  current.splice(FIRST_INDEX, current.length, ...breadcrumbs);
  Reflect.set(client, "issueBreadcrumbsTruncated", truncated);
}

/**
 * @template T
 * @param {Readonly<LogBrewClient>} client
 * @param {() => T} update
 * @returns {T}
 */
function updateAppleNativeBreadcrumbs(client, update) {
  /** @type {BreadcrumbState} */
  const previous = [[...issueBreadcrumbs(client)], issueBreadcrumbsTruncated(client)];
  const result = update();
  try {
    syncAppleNativeCrashBreadcrumbs(client);
  } catch (error) {
    restoreBreadcrumbs(client, previous);
    throw error;
  }
  return result;
}

/**
 * @param {Readonly<LogBrewClient>} client
 * @param {(...args: readonly never[]) => unknown} addBreadcrumb
 * @returns {(...args: readonly unknown[]) => void}
 */
function breadcrumbAdder(client, addBreadcrumb) {
  return (...args) => {
    updateAppleNativeBreadcrumbs(client, () => {
      Reflect.apply(addBreadcrumb, undefined, args);
    });
  };
}

/**
 * @param {Readonly<LogBrewClient>} client
 * @param {() => number} clearBreadcrumbs
 * @returns {() => number}
 */
function breadcrumbClearer(client, clearBreadcrumbs) {
  return () => updateAppleNativeBreadcrumbs(client, clearBreadcrumbs);
}

/**
 * @param {LogBrewClient} client
 * @returns {LogBrewClient}
 */
function bindAppleNativeCrashBreadcrumbs(client) {
  if (platformOS() !== "ios") {
    return client;
  }
  const addBreadcrumb = client.addBreadcrumb.bind(client);
  const clearBreadcrumbs = client.clearBreadcrumbs.bind(client);
  client.addBreadcrumb = breadcrumbAdder(client, addBreadcrumb);
  client.clearBreadcrumbs = breadcrumbClearer(client, clearBreadcrumbs);
  syncAppleNativeCrashBreadcrumbs(client);
  return client;
}

/**
 * @param {Readonly<LogBrewClient>} client
 * @returns {Promise<void>}
 */
async function flushQuietly(client) {
  try {
    await client.flush();
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * @param {unknown} subscription
 */
function removeSubscription(subscription) {
  const remove = readField(subscription, "remove");
  if (remove === undefined || remove === null) {
    return;
  }
  if (typeof remove !== "function") {
    throw new TypeError("subscription.remove is not a function");
  }
  Reflect.apply(remove, subscription, []);
}

/**
 * @param {Readonly<LogBrewClient>} client
 * @param {(...args: readonly Transport[]) => Promise<TransportResponse>} shutdown
 * @param {unknown} subscription
 * @returns {(...args: readonly Transport[]) => Promise<TransportResponse>}
 */
function closingShutdown(client, shutdown, subscription) {
  return async (...args) => {
    try {
      return await shutdown(...args);
    } finally {
      if (client.deliveryHealth().lifecycle === "closed") {
        removeSubscription(subscription);
      }
    }
  };
}

/**
 * @param {LogBrewClient} client
 * @param {boolean} durable
 * @returns {LogBrewClient}
 */
function bindAndroidNativeDelivery(client, durable) {
  /** @type {unknown} */
  const emitter = DeviceEventEmitter;
  const addListener = readField(emitter, "addListener");
  if (!durable || platformOS() !== "android" || typeof addListener !== "function") {
    return client;
  }
  /** @type {unknown} */
  const subscription = Reflect.apply(addListener, emitter, [
    "logbrewAndroidDiagnosticPersisted",
    () => {
      void flushQuietly(client);
    }
  ]);
  const shutdown = client.shutdown.bind(client);
  client.shutdown = closingShutdown(client, shutdown, subscription);
  return client;
}

export { bindAndroidNativeDelivery, bindAppleNativeCrashBreadcrumbs };
