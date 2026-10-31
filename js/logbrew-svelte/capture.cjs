"use strict";

const { createIssueAttributesFromError } = require("@logbrew/sdk");

/**
 * @import { TransportResponse } from "@logbrew/sdk"
 * @import {
 *   LogBrewSvelteCaptureContext,
 *   LogBrewSvelteCaptureOptions,
 *   LogBrewSvelteContext,
 *   LogBrewSvelteErrorEvent,
 *   LogBrewSvelteErrorIdContext,
 *   LogBrewSvelteErrorOptions
 * } from "./index.cjs"
 */

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function readField(value, key) {
  return (typeof value === "object" && value !== null) || typeof value === "function" ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFunction(value) {
  return typeof value === "function";
}

/**
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "") || "event";
}

/**
 * @returns {string}
 */
function currentTime() {
  return new Date().toISOString();
}

/**
 * @param {{ readonly now?: (() => string) | undefined }} options
 * @returns {string}
 */
function now(options) {
  return options.now !== undefined && isFunction(options.now) ? options.now() : currentTime();
}

/**
 * @param {unknown} value
 * @returns {value is LogBrewSvelteContext}
 */
function isLogBrewSvelteContext(value) {
  const hasClient = Boolean(readField(value, "client"));
  const hasTransport = Boolean(readField(value, "transport"));
  return hasClient && hasTransport && isFunction(readField(value, "previewJson"));
}

/**
 * @param {unknown} error
 * @param {LogBrewSvelteErrorIdContext} context
 * @returns {string}
 */
function defaultErrorEventId(error, context) {
  const message = error instanceof Error ? error.message : String(error);
  return `evt_svelte_error_${slugify(`${context.component}_${context.info}_${message}`)}`;
}

/**
 * @param {unknown} error
 * @param {LogBrewSvelteErrorOptions} [options]
 * @returns {LogBrewSvelteErrorEvent}
 */
function createSvelteErrorEvent(error, options = {}) {
  const {
    component = "",
    handled = true,
    idFactory = defaultErrorEventId,
    info = "",
    mechanism = "svelte.error_boundary",
    metadata,
    now: timestamp = currentTime,
    source = "svelte.error",
    title,
    ...issueOptions
  } = options;
  return {
    id: idFactory(error, { component, info }),
    timestamp: timestamp(),

    attributes: createIssueAttributesFromError(error, {
      ...issueOptions,
      handled,
      mechanism,
      metadata: { ...metadata, component, info },
      source,
      title: title ?? (component ? `${component} failed` : "Svelte component failed")
    })
  };
}

/**
 * @param {LogBrewSvelteCaptureOptions} options
 * @param {Readonly<TransportResponse>} response
 * @param {LogBrewSvelteCaptureContext} context
 * @returns {Promise<void>}
 */
async function notifyFlush(options, response, context) {
  if (options.onFlush !== undefined && isFunction(options.onFlush)) {
    await options.onFlush(response, context);
  }
}

/**
 * @param {LogBrewSvelteCaptureOptions} options
 * @param {unknown} error
 * @param {LogBrewSvelteCaptureContext} context
 * @returns {Promise<void>}
 */
async function notifyFailure(options, error, context) {
  if (options.onCaptureError !== undefined && isFunction(options.onCaptureError)) {
    await options.onCaptureError(error, context);
  }
}

/**
 * @param {unknown} error
 * @param {LogBrewSvelteContext} context
 * @param {LogBrewSvelteCaptureOptions} [options]
 * @returns {Promise<TransportResponse>}
 */
async function captureSvelteError(error, context, options = {}) {
  const event = options.errorEvent !== undefined && isFunction(options.errorEvent)
    ? options.errorEvent(error, { context })
    : createSvelteErrorEvent(error, options);
  try {
    const attributes = options.breadcrumbs === undefined
      ? event.attributes
      : { ...event.attributes, breadcrumbs: options.breadcrumbs };
    context.client.issue(event.id, event.timestamp, attributes);
    const response = await context.client.flush(context.transport);
    await notifyFlush(options, response, { context });
    return response;
  } catch (captureError) {
    await notifyFailure(options, captureError, { context });
    throw captureError;
  }
}

module.exports = {
  captureSvelteError,
  createSvelteErrorEvent,
  currentTime,
  isFunction,
  isLogBrewSvelteContext,
  notifyFailure,
  now,
  readField,
  slugify
};
