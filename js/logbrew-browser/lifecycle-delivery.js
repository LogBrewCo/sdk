import { lifecycleTransportFor } from "./lifecycle-transport.js";
import { callMethod, readField } from "./values.js";

/**
 * @import { LogBrewClient, Transport } from "@logbrew/sdk"
 * @typedef {"pagehide" | "visibility_hidden"} LifecycleReason
 * @typedef {{
 *   readonly addEventListener: (type: string, listener: () => void) => void,
 *   readonly document?: unknown,
 *   readonly removeEventListener?: unknown
 * }} LifecycleWindow
 * @typedef {{
 *   readonly browserWindow: LifecycleWindow,
 *   readonly client: LogBrewClient,
 *   readonly deliver: (transport: Transport, reason: LifecycleReason) => unknown,
 *   readonly flushOnPageHide: boolean,
 *   readonly flushOnVisibilityHidden: boolean,
 *   readonly transport: Transport | undefined
 * }} LifecycleDeliveryOptions
 * @typedef {{
 *   destroyed: boolean,
 *   generation: number,
 *   inFlight: object | undefined,
 *   installed: boolean,
 *   paused: boolean
 * }} LifecycleDeliveryState
 * @typedef {{
 *   readonly lifecycleTransport: Transport | undefined,
 *   readonly options: LifecycleDeliveryOptions,
 *   readonly state: LifecycleDeliveryState
 * }} LifecycleCore
 * @typedef {{ readonly pagehide: () => void, readonly visibilitychange: () => void }} LifecycleListeners
 * @typedef {{ readonly core: LifecycleCore, readonly listeners: LifecycleListeners }} LifecycleDelivery
 * @typedef {{ readonly generation: number, readonly pending: Promise<unknown>, readonly token: object }} PendingDelivery
 * @typedef {{
 *   readonly destroy: () => void,
 *   readonly recover: () => void,
 *   readonly resume: () => void,
 *   readonly suspend: () => void
 * }} LifecycleDeliveryHandle
 */

const NO_PENDING_EVENTS = 0;
const NEXT_GENERATION = 1;

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isTerminalLifecycleError(error) {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = readField(error, "code");
  if (code === "keepalive_body_too_large") {
    return false;
  }
  const retryable = readField(error, "retryable");
  return code === "unauthenticated"
    || (code === "rate_limited" && retryable !== true)
    || (code === "transport_error" && retryable !== true)
    || retryable === false;
}

/**
 * @param {LifecycleCore} core
 * @returns {boolean}
 */
function canRequest(core) {
  const { state } = core;
  return state.installed
    && !state.paused
    && state.inFlight === undefined
    && core.lifecycleTransport !== undefined
    && core.options.client.pendingEvents() !== NO_PENDING_EVENTS;
}

/**
 * @param {LifecycleDeliveryState} state
 * @param {PendingDelivery} pendingDelivery
 * @returns {Promise<void>}
 */
async function trackDelivery(state, pendingDelivery) {
  try {
    await pendingDelivery.pending;
  } catch (error) {
    if (state.installed && state.generation === pendingDelivery.generation && isTerminalLifecycleError(error)) {
      state.paused = true;
    }
  } finally {
    if (state.inFlight === pendingDelivery.token) {
      state.inFlight = undefined;
    }
  }
}

/**
 * @param {LifecycleCore} core
 * @param {LifecycleReason} reason
 * @returns {void}
 */
function request(core, reason) {
  if (!canRequest(core) || core.lifecycleTransport === undefined) {
    return;
  }
  const { generation } = core.state;
  const pending = Promise.resolve(core.options.deliver(core.lifecycleTransport, reason));
  const token = {};
  core.state.inFlight = token;
  void trackDelivery(core.state, { generation, pending, token });
}

/**
 * @param {LifecycleDelivery} delivery
 * @returns {void}
 */
function install(delivery) {
  const { core: { options, state }, listeners } = delivery;
  if (state.destroyed || state.installed) {
    return;
  }
  state.installed = true;
  if (options.flushOnPageHide) {
    options.browserWindow.addEventListener("pagehide", listeners.pagehide);
  }
  if (options.flushOnVisibilityHidden && typeof readField(options.browserWindow.document, "addEventListener") === "function") {
    callMethod(options.browserWindow.document, "addEventListener", ["visibilitychange", listeners.visibilitychange]);
  }
}

/**
 * @param {LifecycleDelivery} delivery
 * @returns {void}
 */
function suspend(delivery) {
  const { core: { options, state }, listeners } = delivery;
  if (!state.installed) {
    return;
  }
  state.installed = false;
  state.generation += NEXT_GENERATION;
  callMethod(options.browserWindow, "removeEventListener", ["pagehide", listeners.pagehide]);
  callMethod(options.browserWindow.document, "removeEventListener", ["visibilitychange", listeners.visibilitychange]);
}

/**
 * @param {LifecycleDeliveryOptions} options
 * @returns {LifecycleDelivery}
 */
function createDelivery(options) {
  /** @type {LifecycleCore} */
  const core = {
    lifecycleTransport: lifecycleTransportFor(options.transport),
    options,
    state: { destroyed: false, generation: 0, inFlight: undefined, installed: false, paused: false }
  };
  return {
    core,
    listeners: {
      pagehide: () => {
        request(core, "pagehide");
      },
      visibilitychange: () => {
        if (readField(options.browserWindow.document, "visibilityState") === "hidden") {
          request(core, "visibility_hidden");
        }
      }
    }
  };
}

/**
 * @param {LifecycleDeliveryOptions} options
 * @returns {Readonly<LifecycleDeliveryHandle>}
 */
function installBrowserLifecycleDelivery({
  browserWindow,
  client,
  deliver,
  flushOnPageHide,
  flushOnVisibilityHidden,
  transport
}) {
  const delivery = createDelivery({ browserWindow, client, deliver, flushOnPageHide, flushOnVisibilityHidden, transport });
  const { state } = delivery.core;
  install(delivery);
  return Object.freeze({
    destroy() {
      if (state.destroyed) {
        return;
      }
      suspend(delivery);
      state.destroyed = true;
    },
    recover() {
      if (!state.destroyed) {
        state.paused = false;
      }
    },
    resume() {
      install(delivery);
    },
    suspend: () => {
      suspend(delivery);
    }
  });
}

export { installBrowserLifecycleDelivery };
