"use strict";

const { lifecycleTransportFor } = require("./lifecycle-transport.cjs");

function installBrowserLifecycleDelivery({
  browserWindow,
  client,
  deliver,
  flushOnPageHide,
  flushOnVisibilityHidden,
  transport
}) {
  const lifecycleTransport = lifecycleTransportFor(transport);
  let destroyed = false;
  let installed = false;
  let inFlight;
  let paused = false;
  let generation = 0;

  const pagehide = () => request("pagehide");
  const visibilitychange = () => {
    if (browserWindow.document?.visibilityState === "hidden") {
      request("visibility_hidden");
    }
  };

  function install() {
    if (destroyed || installed) {
      return;
    }
    installed = true;
    if (flushOnPageHide) {
      browserWindow.addEventListener("pagehide", pagehide);
    }
    if (flushOnVisibilityHidden && typeof browserWindow.document?.addEventListener === "function") {
      browserWindow.document.addEventListener("visibilitychange", visibilitychange);
    }
  }

  function suspend() {
    if (!installed) {
      return;
    }
    installed = false;
    generation += 1;
    browserWindow.removeEventListener?.("pagehide", pagehide);
    browserWindow.document?.removeEventListener?.("visibilitychange", visibilitychange);
  }

  function request(reason) {
    if (
      !installed
      || paused
      || inFlight !== undefined
      || lifecycleTransport === undefined
      || client.pendingEvents() === 0
    ) {
      return;
    }
    const requestGeneration = generation;
    const delivery = Promise.resolve(deliver(lifecycleTransport, reason));
    const trackedDelivery = delivery.then(
      () => undefined,
      (error) => {
        if (installed && generation === requestGeneration && isTerminalLifecycleError(error)) {
          paused = true;
        }
      }
    ).finally(() => {
      if (inFlight === trackedDelivery) {
        inFlight = undefined;
      }
    });
    inFlight = trackedDelivery;
  }

  install();

  return Object.freeze({
    destroy() {
      if (destroyed) {
        return;
      }
      suspend();
      destroyed = true;
    },
    recover() {
      if (!destroyed) {
        paused = false;
      }
    },
    resume() {
      install();
    },
    suspend
  });
}

function isTerminalLifecycleError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  if (error.code === "keepalive_body_too_large") {
    return false;
  }
  return error.code === "unauthenticated"
    || error.code === "rate_limited"
    || (error.code === "transport_error" && error.retryable !== true)
    || error.retryable === false;
}

module.exports = { installBrowserLifecycleDelivery };
