import type {
  LogBrewNativeProvider,
  useLogBrewNative,
  useLogBrewNativeActions
} from "./types/provider.js";
import type {
  bindLogBrewTrace,
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  createReactNativeTraceparent,
  createTraceparentFetch,
  getActiveLogBrewTrace,
  getReactNativeTraceMetadata,
  shouldPropagateTraceparent,
  withLogBrewTrace
} from "./types/trace.js";
import type {
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNavigationSpan,
  captureReactNativeNetwork,
  captureReactNativeResourceSpan,
  captureScreenView,
  createAppStateListener,
  createReactNativeActionEvent,
  createReactNativeErrorEvent,
  createReactNativeNavigationSpanEvent,
  createReactNativeNetworkEvent,
  createReactNativeResourceSpanEvent,
  createReactNavigationSpanListener,
  getReactNativeContext
} from "./types/capture.js";
import type {
  createLogBrewReactNativeClient,
  createReactNativeFetchTransport
} from "./types/config.js";

declare const defaultExport: {
  LogBrewNativeProvider: typeof LogBrewNativeProvider;
  bindLogBrewTrace: typeof bindLogBrewTrace;
  captureAppStateChange: typeof captureAppStateChange;
  captureReactNativeAction: typeof captureReactNativeAction;
  captureReactNativeError: typeof captureReactNativeError;
  captureReactNativeNetwork: typeof captureReactNativeNetwork;
  captureReactNativeNavigationSpan: typeof captureReactNativeNavigationSpan;
  captureReactNativeResourceSpan: typeof captureReactNativeResourceSpan;
  captureScreenView: typeof captureScreenView;
  createAppStateListener: typeof createAppStateListener;
  createLogBrewReactNativeClient: typeof createLogBrewReactNativeClient;
  createReactNavigationSpanListener: typeof createReactNavigationSpanListener;
  createReactNativeFetchTransport: typeof createReactNativeFetchTransport;
  createReactNativeSpanAttributes: typeof createReactNativeSpanAttributes;
  createReactNativeTraceContext: typeof createReactNativeTraceContext;
  createReactNativeTraceHeaders: typeof createReactNativeTraceHeaders;
  createReactNativeActionEvent: typeof createReactNativeActionEvent;
  createReactNativeErrorEvent: typeof createReactNativeErrorEvent;
  createReactNativeNetworkEvent: typeof createReactNativeNetworkEvent;
  createReactNativeNavigationSpanEvent: typeof createReactNativeNavigationSpanEvent;
  createReactNativeResourceSpanEvent: typeof createReactNativeResourceSpanEvent;
  createReactNativeTraceparent: typeof createReactNativeTraceparent;
  createTraceparentFetch: typeof createTraceparentFetch;
  getActiveLogBrewTrace: typeof getActiveLogBrewTrace;
  getReactNativeContext: typeof getReactNativeContext;
  getReactNativeTraceMetadata: typeof getReactNativeTraceMetadata;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
  useLogBrewNative: typeof useLogBrewNative;
  useLogBrewNativeActions: typeof useLogBrewNativeActions;
  withLogBrewTrace: typeof withLogBrewTrace;
};

export type {
  CreateLogBrewReactNativeClientConfig,
  ReactNativeAppStateLike,
  ReactNativeFetchLike,
  ReactNativeFetchResponseLike,
  ReactNativeFetchTransportConfig,
  ReactNativePlatformLike
} from "./types/config.js";
export {
  createLogBrewReactNativeClient,
  createReactNativeFetchTransport
} from "./types/config.js";
export type {
  ReactNativeSpanAttributesInput,
  ReactNativeTraceContext,
  ReactNativeTraceContextConfig,
  ReactNativeTraceInput,
  ReactNativeTraceparentConfig,
  TracePropagationTarget,
  TraceparentFetchConfig,
  TraceparentFetchLike
} from "./types/trace.js";
export {
  bindLogBrewTrace,
  createReactNativeSpanAttributes,
  createReactNativeTraceContext,
  createReactNativeTraceHeaders,
  createReactNativeTraceparent,
  createTraceparentFetch,
  getActiveLogBrewTrace,
  getReactNativeTraceMetadata,
  shouldPropagateTraceparent,
  withLogBrewTrace
} from "./types/trace.js";
export type {
  CaptureAppStateChangeOptions,
  CaptureReactNativeErrorOptions,
  CaptureScreenViewOptions,
  CreateAppStateListenerOptions,
  ReactNativeActionEvent,
  ReactNativeActionIdFactoryContext,
  ReactNativeActionInput,
  ReactNativeContextOptions,
  ReactNativeErrorEvent,
  ReactNativeErrorIdFactoryContext,
  ReactNativeNavigationSpanIdFactoryContext,
  ReactNativeNavigationSpanInput,
  ReactNativeNetworkIdFactoryContext,
  ReactNativeNetworkInput,
  ReactNativeResourceSpanIdFactoryContext,
  ReactNativeResourceSpanInput,
  ReactNativeSpanEvent,
  ReactNavigationContainerLike,
  ReactNavigationRouteLike,
  ReactNavigationSpanListenerOptions
} from "./types/events.js";
export {
  captureAppStateChange,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNavigationSpan,
  captureReactNativeNetwork,
  captureReactNativeResourceSpan,
  captureScreenView,
  createAppStateListener,
  createReactNativeActionEvent,
  createReactNativeErrorEvent,
  createReactNativeNavigationSpanEvent,
  createReactNativeNetworkEvent,
  createReactNativeResourceSpanEvent,
  createReactNavigationSpanListener,
  getReactNativeContext
} from "./types/capture.js";
export type {
  LogBrewNativeActions,
  LogBrewNativeContextValue,
  LogBrewNativeProviderProps
} from "./types/provider.js";
export {
  LogBrewNativeProvider,
  useLogBrewNative,
  useLogBrewNativeActions
} from "./types/provider.js";
export {
  captureDefaultAppStateChange,
  captureDefaultReactNativeAction,
  captureDefaultReactNativeError,
  captureDefaultReactNativeNetwork,
  captureDefaultScreenView,
  createDefaultAppStateListener,
  createDefaultLogBrewReactNativeClient,
  getDefaultReactNativeContext
} from "./types/defaults.js";
export default defaultExport;
