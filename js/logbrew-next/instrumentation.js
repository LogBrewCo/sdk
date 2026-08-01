let nodeHandlerPromise;

export function createLogBrewNextRequestErrorHandler(options = {}) {
  let handler;
  return async function logBrewNextRequestErrorHandler(error, request, context) {
    if (globalThis.process?.env?.NEXT_RUNTIME === "edge") {
      return;
    }

    try {
      nodeHandlerPromise ??= import("./index.js");
      const module = await nodeHandlerPromise;
      handler ??= module.createLogBrewNextRequestErrorHandler(options);
      await handler(error, request, context);
    } catch (captureError) {
      if (typeof options.onCaptureError === "function") {
        try {
          await options.onCaptureError(captureError, { error, request, context });
        } catch {
          // Observability callbacks must not replace the application error Next.js is handling.
        }
      }
    }
  };
}

export default {
  createLogBrewNextRequestErrorHandler
};
