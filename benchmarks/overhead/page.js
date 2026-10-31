import { runLoop } from "./loop.js";

/** @import { Bench, LoopRun } from "./loop.js" */

const channel = new MessageChannel();
const WAKE = 0;
channel.port1.start();

/**
 * @returns {Promise<void>}
 */
async function nextTask() {
  /** @type {PromiseWithResolvers<void>} */
  const task = Promise.withResolvers();
  channel.port1.addEventListener(
    "message",
    () => {
      task.resolve();
    },
    { once: true }
  );
  channel.port2.postMessage(WAKE);
  await task.promise;
}

/**
 * @param {Bench} bench
 * @returns {void}
 */
function installPage(bench) {
  Reflect.set(globalThis, "bench", bench);
  Reflect.set(
    globalThis,
    "measure",
    /**
     * @param {LoopRun} run
     * @returns {Promise<void>}
     */
    async (run) => runLoop(bench, nextTask, run)
  );
}

export { installPage };
