import runtime from "./lifecycle.cjs";

export const {
  captureReactNativeLifecycleSpan,
  createAppStateLifecycleSpanListener,
  createReactNativeLifecycleSpanEvent
} = runtime;
