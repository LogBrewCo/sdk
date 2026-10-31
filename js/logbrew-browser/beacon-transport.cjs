"use strict";

const { SdkError, TransportError } = require("@logbrew/sdk");
const { defaultFetch, errorMessage, isFunction, readField } = require("./values.cjs");
const { transportResponse } = require("./rate-limit-response.cjs");

/**
 * @import { BeaconTransport, BeaconTransportConfig, BeaconTransportResponse } from "./index.cjs"
 * @typedef {(endpoint: string, payload: string | Blob) => boolean} SendBeacon
 * @typedef {{ readonly body: string, readonly endpoint: string, readonly keepalive: boolean }} FetchFallback
 * @typedef {{
 *   readonly fetchImpl: unknown,
 *   readonly maxBeaconBodyBytes: number,
 *   readonly sendBeacon: unknown
 * }} BeaconSettings
 */

const KIBIBYTE = 1024;
const DEFAULT_BEACON_BODY_KIBIBYTES = 60;
const DEFAULT_MAX_BEACON_BODY_BYTES = DEFAULT_BEACON_BODY_KIBIBYTES * KIBIBYTE;
const ACCEPTED = 202;
const SINGLE_ATTEMPT = 1;
const NO_BYTES = 0;
const FIRST = 0;
const ONE_BYTE_LIMIT = 0x7F;
const TWO_BYTE_LIMIT = 0x7_FF;
const THREE_BYTE_LIMIT = 0xFF_FF;
const ONE_BYTE = 1;
const TWO_BYTES = 2;
const THREE_BYTES = 3;
const FOUR_BYTES = 4;

/**
 * @param {unknown} body
 * @returns {unknown}
 */
function parseEnvelope(body) {
  try {
    return JSON.parse(typeof body === "string" ? body : String(body));
  } catch {
    throw new TransportError("beacon_envelope_invalid", "browser beacon transport requires a JSON telemetry envelope", false);
  }
}

/**
 * @param {string} apiKey
 * @param {unknown} body
 * @returns {string}
 */
function createBeaconRequestBody(apiKey, body) {
  return JSON.stringify({
    envelope: parseEnvelope(body),
    ingest_key: apiKey
  });
}

/**
 * @param {string} body
 * @returns {string | Blob}
 */
function createBeaconPayload(body) {
  if (isFunction(globalThis.Blob)) {
    return new Blob([body], { type: "application/json" });
  }
  return body;
}

/**
 * @param {number} codePoint
 * @returns {number}
 */
function codePointBytes(codePoint) {
  if (codePoint <= ONE_BYTE_LIMIT) {
    return ONE_BYTE;
  }
  if (codePoint <= TWO_BYTE_LIMIT) {
    return TWO_BYTES;
  }
  return codePoint <= THREE_BYTE_LIMIT ? THREE_BYTES : FOUR_BYTES;
}

/**
 * @param {string} text
 * @returns {number}
 */
function fallbackUtf8ByteLength(text) {
  let bytes = NO_BYTES;
  for (const character of text) {
    bytes += codePointBytes(character.codePointAt(FIRST) ?? NO_BYTES);
  }
  return bytes;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function utf8ByteLength(value) {
  const text = typeof value === "string" ? value : String(value);
  if (isFunction(globalThis.TextEncoder)) {
    return new TextEncoder().encode(text).byteLength;
  }
  return fallbackUtf8ByteLength(text);
}

/**
 * @param {typeof fetch | undefined} fetchImpl
 * @param {FetchFallback} request
 * @returns {Promise<BeaconTransportResponse>}
 */
async function sendWithFetch(fetchImpl, request) {
  if (fetchImpl === undefined || !isFunction(fetchImpl)) {
    throw TransportError.network("browser beacon fallback fetch is unavailable");
  }
  try {
    const response = await fetchImpl(request.endpoint, {
      body: request.body,
      headers: {
        "content-type": "application/json"
      },
      keepalive: request.keepalive,
      method: "POST"
    });
    return { ...(await transportResponse(response)), queued: false };
  } catch (error) {
    throw TransportError.network(`browser beacon fallback fetch failed: ${errorMessage(error)}`);
  }
}

/**
 * @param {unknown} endpoint
 * @returns {string}
 */
function requireEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new SdkError("configuration_error", "createBeaconTransport requires a non-empty endpoint");
  }
  return endpoint;
}

/**
 * @param {number} value
 * @returns {void}
 */
function validateBeaconBodyLimit(value) {
  if (!Number.isSafeInteger(value) || value <= NO_BYTES) {
    throw new SdkError("configuration_error", "maxBeaconBodyBytes must be a positive integer");
  }
}

/**
 * @returns {SendBeacon | undefined}
 */
function defaultSendBeacon() {
  const { navigator } = globalThis;
  return isFunction(readField(navigator, "sendBeacon")) ? navigator.sendBeacon.bind(navigator) : undefined;
}

/**
 * @param {(endpoint: string, payload: string | Blob) => unknown} sendBeacon
 * @param {string} endpoint
 * @param {string} body
 * @returns {boolean}
 */
function queuedByBeacon(sendBeacon, endpoint, body) {
  try {
    return Boolean(sendBeacon(endpoint, createBeaconPayload(body)));
  } catch {
    return false;
  }
}

/**
 * @param {BeaconSettings} config
 * @returns {void}
 */
function validateBeaconConfig(config) {
  validateBeaconBodyLimit(config.maxBeaconBodyBytes);
  if (config.sendBeacon !== undefined && !isFunction(config.sendBeacon)) {
    throw new SdkError("configuration_error", "createBeaconTransport sendBeacon must be a function");
  }
  if (config.fetchImpl !== undefined && !isFunction(config.fetchImpl)) {
    throw new SdkError("configuration_error", "createBeaconTransport fetchImpl must be a function");
  }
  if (config.sendBeacon === undefined && config.fetchImpl === undefined) {
    throw new SdkError("configuration_error", "createBeaconTransport requires sendBeacon or fetch");
  }
}

/**
 * @param {Partial<BeaconTransportConfig>} [config]
 * @returns {BeaconTransport}
 */
function createBeaconTransport({
  endpoint,
  fetchImpl = defaultFetch(),
  maxBeaconBodyBytes = DEFAULT_MAX_BEACON_BODY_BYTES,
  sendBeacon = defaultSendBeacon()
} = {}) {
  const beaconEndpoint = requireEndpoint(endpoint);
  validateBeaconConfig({ fetchImpl, maxBeaconBodyBytes, sendBeacon });
  return {
    async send(apiKey, body) {
      const beaconBody = createBeaconRequestBody(apiKey, body);
      if (sendBeacon !== undefined && utf8ByteLength(beaconBody) <= maxBeaconBodyBytes && queuedByBeacon(sendBeacon, beaconEndpoint, beaconBody)) {
        return {
          statusCode: ACCEPTED,

          attempts: SINGLE_ATTEMPT,
          queued: true
        };
      }
      return sendWithFetch(fetchImpl, { body: beaconBody, endpoint: beaconEndpoint, keepalive: utf8ByteLength(beaconBody) <= maxBeaconBodyBytes });
    }
  };
}

module.exports = { createBeaconTransport };
