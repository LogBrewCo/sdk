// The measured loop. Each event runs in its own task, the way errors and spans arrive in an app.
// Without the SDK the loop does the same app work (it still creates each Error) so that
// the difference is the SDK's own cost.
export async function runLoop(bench, signal, count, offset, nextTask, withSdk) {
  for (let i = 0; i < count; i += 1) {
    if (signal === "error") {
      const error = new Error(`checkout failed ${offset + i}`);
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
