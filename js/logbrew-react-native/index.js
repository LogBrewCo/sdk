import runtime from "./index.cjs";

export const {
  LogBrewNativeProvider,
  bindLogBrewTrace,
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNavigationSpan,
  captureReactNativeNetwork,
  captureReactNativeResourceSpan,
  captureScreenView,
  createAppStateListener,
  createLogBrewReactNativeClient,
  createReactNavigationSpanListener,
  createReactNativeActionEvent,
  createReactNativeErrorEvent,
  createReactNativeFetchTransport,
  createReactNativeNavigationSpanEvent,
  createReactNativeNetworkEvent,
  createReactNativeResourceSpanEvent,
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  createReactNativeTraceparent,
  createTraceparentFetch,
  getActiveLogBrewTrace,
  getReactNativeContext,
  getReactNativeTraceMetadata,
  shouldPropagateTraceparent,
  useLogBrewNative,
  useLogBrewNativeActions,
  withLogBrewTrace
} = runtime;

export default runtime.default;
