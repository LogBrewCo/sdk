import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";

/**
 * @typedef {{ readonly callback: () => void, cleared: boolean, readonly delay: number, unrefCalls: number, readonly unref: () => FakeTimer }} FakeTimer
 */

const MAX_WAIT_TURNS = 100;
const START = 0;
const NEXT = 1;

/**
 * @param {object} owner
 * @param {string} name
 * @returns {{ readonly name: string, readonly original: unknown }}
 */
function savedMember(owner, name) {
  /** @type {unknown} */
  const original = Reflect.get(owner, name);
  return { name, original };
}

/**
 * @param {object} owner
 * @param {Readonly<Record<string, unknown>>} replacements
 * @param {() => Promise<void>} run
 * @returns {Promise<void>}
 */
async function withReplacements(owner, replacements, run) {
  const originals = Object.keys(replacements).map((name) => savedMember(owner, name));
  for (const [name, replacement] of Object.entries(replacements)) {
    Reflect.set(owner, name, replacement);
  }
  try {
    await run();
  } finally {
    for (const { name, original } of originals) {
      Reflect.set(owner, name, original);
    }
  }
}

/**
 * @param {unknown} timer
 * @returns {void}
 */
function clearFakeTimer(timer) {
  if (typeof timer === "object" && timer !== null) {
    Reflect.set(timer, "cleared", true);
  }
}

/**
 * @param {(timers: readonly Readonly<FakeTimer>[]) => Promise<void>} run
 * @returns {Promise<void>}
 */
async function withFakeTimers(run) {
  /** @type {FakeTimer[]} */
  const timers = [];
  /**
   * @param {() => void} handler
   * @param {number} delay
   * @returns {FakeTimer}
   */
  function setFakeTimer(handler, delay) {
    /** @type {FakeTimer} */
    const timer = {
      callback: handler,
      cleared: false,
      delay,
      unref() {
        this.unrefCalls += NEXT;
        return this;
      },
      unrefCalls: 0
    };
    timers.push(timer);
    return timer;
  }
  await withReplacements(globalThis, { clearTimeout: clearFakeTimer, setTimeout: setFakeTimer }, async () => run(timers));
}

/**
 * @param {readonly Readonly<FakeTimer>[]} timers
 * @returns {Readonly<FakeTimer> | undefined}
 */
function activeTimer(timers) {
  /** @type {Readonly<FakeTimer> | undefined} */
  let latest = undefined;
  for (const timer of timers) {
    if (!timer.cleared) {
      latest = timer;
    }
  }
  return latest;
}

/**
 * @param {Readonly<FakeTimer> | undefined} timer
 * @returns {void}
 */
function fire(timer) {
  assert.ok(timer);
  timer.callback();
}

/**
 * @param {readonly Readonly<FakeTimer>[]} timers
 * @returns {boolean}
 */
function hasActiveTimer(timers) {
  return timers.some((timer) => !timer.cleared);
}

/**
 * @param {() => boolean} predicate
 * @param {string} message
 * @param {number} turn
 * @returns {Promise<void>}
 */
async function waitTurns(predicate, message, turn) {
  if (turn >= MAX_WAIT_TURNS) {
    throw new Error(message);
  }
  if (predicate()) {
    return;
  }
  await nextTurn();
  await waitTurns(predicate, message, turn + NEXT);
}

/**
 * @param {() => boolean} predicate
 * @param {string} message
 * @returns {Promise<void>}
 */
async function waitForCondition(predicate, message) {
  await waitTurns(predicate, message, START);
}

export { activeTimer, fire, hasActiveTimer, waitForCondition, withFakeTimers, withReplacements };
