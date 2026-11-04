"use strict";

const { SdkError, TransportError } = require("@logbrew/sdk");
const { isFunction, readField } = require("./values.cjs");

/**
 * @import { Transport } from "@logbrew/sdk"
 */

const LIFECYCLE_SEND = Symbol.for("co.logbrew.browser.lifecycleSend");

/**
 * @param {unknown} value
 * @returns {value is Transport["send"]}
 */
function isSend(value) {
  return isFunction(value);
}

/**
 * @template {Transport | undefined} TransportValue
 * @param {TransportValue} transport
 * @param {unknown} [send]
 * @returns {TransportValue}
 */
function markLifecycleTransport(transport, send = readField(transport, "send")) {
  const hasTransport = Boolean(transport);
  if (!hasTransport || !isFunction(send)) {
    return transport;
  }
  Object.defineProperty(transport, LIFECYCLE_SEND, {
    configurable: false,
    enumerable: false,
    value: send,
    writable: false
  });
  return transport;
}

/**
 * The browser may still deliver a keepalive request whose fetch rejected, so
 * an exit send is the only attempt. The batch stays queued for the next flush.
 * @param {unknown} error
 * @returns {unknown}
 */
function finalExitAttempt(error) {
  return error instanceof TransportError && error.retryable
    ? new SdkError(error.code, error.message, { retryable: true })
    : error;
}

/**
 * @param {Transport | undefined} transport
 * @returns {Transport | undefined}
 */
function lifecycleTransportFor(transport) {
  const send = readField(transport, LIFECYCLE_SEND);
  if (!isSend(send)) {
    return undefined;
  }
  /** @type {Transport} */
  const lifecycleTransport = {
    async send(apiKey, body) {
      try {
        return await send.call(transport, apiKey, body);
      } catch (error) {
        throw finalExitAttempt(error);
      }
    }
  };
  return Object.freeze(lifecycleTransport);
}

module.exports = { lifecycleTransportFor, markLifecycleTransport };
