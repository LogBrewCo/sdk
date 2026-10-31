"use strict";

const { isFunction, isTruthy, readField } = require("./values.cjs");

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
function markLifecycleTransport(transport, send = transport?.send) {
  if (!isTruthy(transport) || !isFunction(send)) {
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
    send(apiKey, body) {
      return send.call(transport, apiKey, body);
    }
  };
  return Object.freeze(lifecycleTransport);
}

module.exports = { lifecycleTransportFor, markLifecycleTransport };
