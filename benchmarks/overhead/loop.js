/**
 * @typedef {"error" | "span"} Signal
 * @typedef {{
 *   readonly delivered: (signal: Signal) => number,
 *   readonly error: (error: Readonly<Error>) => void,
 *   readonly flush: () => Promise<unknown>,
 *   readonly init: (signal: Signal) => void,
 *   readonly span: (name: string) => void
 * }} Bench
 * @typedef {{ readonly count: number, readonly offset: number, readonly signal: Signal, readonly withSdk: boolean }} LoopRun
 */

const STEP = 1;

/**
 * @param {Bench} bench
 * @param {() => Promise<unknown>} nextTask
 * @param {LoopRun} run
 * @returns {Promise<void>}
 */
export async function runLoop(bench, nextTask, { count, offset, signal, withSdk }) {
  for (let index = 0; index < count; index += STEP) {
    if (signal === "error") {
      const error = new Error(`checkout failed ${String(offset + index)}`);
      if (withSdk) {
        bench.error(error);
      }
    } else if (withSdk) {
      bench.span("checkout.step");
    }
    await nextTask();
  }
  if (withSdk) {
    await bench.flush();
  }
}
