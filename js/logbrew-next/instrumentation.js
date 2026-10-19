let nodeHandlerPromise;
let edgeHandlerPromise;

export function createLogBrewNextRequestErrorHandler(options = {}) {
  let handler;
  let edgeHandler;
  return async function logBrewNextRequestErrorHandler(error, request, context) {
    try {
      if (process.env.NEXT_RUNTIME === "edge") {
        // The Edge runtime has no Node.js modules; this path sends with fetch only.
        edgeHandlerPromise ??= import("./edge.js");
        const edgeModule = await edgeHandlerPromise;
        edgeHandler ??= edgeModule.createLogBrewNextEdgeRequestErrorHandler(options);
        await edgeHandler(error, request, context);
      } else {
        nodeHandlerPromise ??= import("./index.js");
        const module = await nodeHandlerPromise;
        handler ??= module.createLogBrewNextRequestErrorHandler(options);
        await handler(error, request, context);
      }
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
