import assert from "node:assert/strict";
import { createLogBrewSession } from "@logbrew/sdk";
import test from "node:test";

const MINUTE_MS = 60_000;
const ACTIVE_GAP_MS = 1_740_000;
const IDLE_GAP_MS = 1_800_000;
const RELOAD_GAP_MS = 600_000;
const EVENT_STEP_MINUTES = 20;
const MAX_DURATION_MINUTES = 240;
const SESSION_ID = /^[0-9a-f]{32}$/u;

/**
 * @returns {{ getItem: (key: string) => string | undefined, setItem: (key: string, value: string) => void }}
 */
function memoryStorage() {
  /** @type {Map<string, string>} */
  const items = new Map();
  return {
    getItem: (key) => items.get(key),
    setItem: (key, value) => {
      items.set(key, value);
    }
  };
}

void test("a session keeps its ID while events arrive and ends after 30 minutes without events", () => {
  let now = 0;
  const session = createLogBrewSession({ now: () => now });
  /**
   * @param {number} gapMs
   * @returns {string}
   */
  function idAfter(gapMs) {
    now += gapMs;
    return session.id();
  }
  const first = session.id();
  assert.deepEqual([idAfter(ACTIVE_GAP_MS), idAfter(ACTIVE_GAP_MS)], [first, first]);
  const second = idAfter(IDLE_GAP_MS);
  assert.match(first, SESSION_ID);
  assert.match(second, SESSION_ID);
  assert.notEqual(second, first);
});

void test("a session ends 4 hours after it starts even while events arrive", () => {
  let now = 0;
  const session = createLogBrewSession({ now: () => now });
  const first = session.id();
  for (let minute = EVENT_STEP_MINUTES; minute < MAX_DURATION_MINUTES; minute += EVENT_STEP_MINUTES) {
    now = minute * MINUTE_MS;
    assert.equal(session.id(), first);
  }
  now = MAX_DURATION_MINUTES * MINUTE_MS;
  assert.notEqual(session.id(), first);
});

void test("a stored session continues after a reload and a broken record starts a new one", () => {
  let now = 0;
  const storage = memoryStorage();
  const first = createLogBrewSession({ now: () => now, storage }).id();
  now += RELOAD_GAP_MS;
  assert.equal(createLogBrewSession({ now: () => now, storage }).id(), first);
  storage.setItem("logbrew:session", "{not json");
  assert.notEqual(createLogBrewSession({ now: () => now, storage }).id(), first);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    }
  };
  assert.match(createLogBrewSession({ storage: throwing }).id(), SESSION_ID);
});
