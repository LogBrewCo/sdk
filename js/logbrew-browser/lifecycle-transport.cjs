"use strict";

const LIFECYCLE_SEND = Symbol.for("co.logbrew.browser.lifecycleSend");

function markLifecycleTransport(transport, send = transport?.send) {
  if (!transport || typeof send !== "function") {
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

function lifecycleTransportFor(transport) {
  const send = transport?.[LIFECYCLE_SEND];
  if (typeof send !== "function") {
    return undefined;
  }
  return Object.freeze({
    send(apiKey, body) {
      return send.call(transport, apiKey, body);
    }
  });
}

module.exports = { lifecycleTransportFor, markLifecycleTransport };
