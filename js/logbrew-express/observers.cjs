"use strict";

/**
 * @import { TransportResponse } from "@logbrew/sdk"
 * @import { LogBrewExpressRuntimeContext, LogBrewExpressSharedOptions } from "./index.cjs"
 */

/**
 * @typedef {{
 *   readonly add: (options: LogBrewExpressSharedOptions) => void,
 *   readonly items: () => readonly LogBrewExpressSharedOptions[]
 * }} ObserverList
 * @typedef {{ readonly context: LogBrewExpressRuntimeContext, readonly error: unknown }} FailureNotice
 * @typedef {{ readonly context: LogBrewExpressRuntimeContext, readonly response: Readonly<TransportResponse> }} FlushNotice
 */

const FIRST_OBSERVER = 0;
const NEXT_OBSERVER = 1;

/**
 * @param {readonly LogBrewExpressSharedOptions[]} initial
 * @returns {ObserverList}
 */
function createObserverList(initial) {
  const items = [...initial];
  return {
    add: (options) => {
      if (!items.includes(options)) {
        items.push(options);
      }
    },
    items: () => items
  };
}

/**
 * @param {LogBrewExpressSharedOptions} options
 * @param {FlushNotice} notice
 * @returns {Promise<void>}
 */
async function notifyFlush(options, notice) {
  if (typeof options.onFlush === "function") {
    await options.onFlush(notice.response, notice.context);
  }
}

/**
 * @param {LogBrewExpressSharedOptions} options
 * @param {FailureNotice} notice
 * @returns {Promise<void>}
 */
async function notifyFailure(options, notice) {
  if (typeof options.onCaptureError === "function") {
    await options.onCaptureError(notice.error, notice.context);
  }
}

/**
 * @param {LogBrewExpressSharedOptions} options
 * @param {FailureNotice} notice
 * @returns {Promise<boolean>}
 */
async function deliverFailureNotice(options, notice) {
  try {
    await notifyFailure(options, notice);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {readonly LogBrewExpressSharedOptions[]} observers
 * @param {FailureNotice} notice
 * @param {number} [index]
 * @returns {Promise<void>}
 */
async function notifyLifecycleFailure(observers, notice, index = FIRST_OBSERVER) {
  const options = observers[index];
  if (options === undefined) {
    return;
  }
  await deliverFailureNotice(options, notice);
  await notifyLifecycleFailure(observers, notice, index + NEXT_OBSERVER);
}

/**
 * @param {readonly LogBrewExpressSharedOptions[]} observers
 * @param {FlushNotice} notice
 * @param {number} [index]
 * @returns {Promise<void>}
 */
async function notifyLifecycleFlush(observers, notice, index = FIRST_OBSERVER) {
  const options = observers[index];
  if (options === undefined) {
    return;
  }
  try {
    await notifyFlush(options, notice);
  } catch (error) {
    await notifyLifecycleFailure([options], { context: notice.context, error });
  }
  await notifyLifecycleFlush(observers, notice, index + NEXT_OBSERVER);
}

module.exports = {
  createObserverList,
  notifyFlush,
  notifyLifecycleFailure,
  notifyLifecycleFlush
};
