import type { EventStore, LogBrewClient } from "@logbrew/sdk";
import type {
  getLogBrewAndroidNativeDiagnosticsStatus,
  installLogBrewAndroidNativeDiagnostics,
  uninstallLogBrewAndroidNativeDiagnostics
} from "./android-native-diagnostics.js";
import type {
  getLogBrewAppleNativeDiagnosticsStatus,
  installLogBrewAppleNativeDiagnostics,
  replayLogBrewAppleNativeDiagnostics,
  setLogBrewAppleNativeCrashContext
} from "./apple-native-diagnostics.js";
import type { CreateLogBrewReactNativeClientConfig } from "./index.js";
import type indexDefault from "./index.js";

type ReactNativePersistentQueueMode = "auto" | "required" | "disabled";

type CreateNativeLogBrewReactNativeClientConfig =
  Omit<CreateLogBrewReactNativeClientConfig, "eventStore"> & ({
    /**
     * `auto` uses the linked app-private native queue when available and otherwise uses memory.
     * `required` fails client creation when the native queue is unavailable. `disabled` uses memory.
     */
    persistentQueue?: ReactNativePersistentQueueMode;
    eventStore?: undefined;
  } | {
    /** Advanced app-owned synchronous persistence adapter. Mutually exclusive with persistentQueue. */
    eventStore: EventStore;
    persistentQueue?: never;
  });

declare function createLogBrewReactNativeClient(
  config: CreateNativeLogBrewReactNativeClientConfig
): LogBrewClient;

declare function createDefaultLogBrewReactNativeClient(
  config: CreateNativeLogBrewReactNativeClientConfig
): LogBrewClient;

declare function purgeLogBrewReactNativePersistentQueue(
  config: { apiKey?: string; clientKey?: string }
): void;

declare const defaultExport: Omit<
  typeof indexDefault,
  "createLogBrewReactNativeClient" | "createDefaultLogBrewReactNativeClient"
> & {
  createLogBrewReactNativeClient: typeof createLogBrewReactNativeClient;
  createDefaultLogBrewReactNativeClient: typeof createDefaultLogBrewReactNativeClient;
  getLogBrewAppleNativeDiagnosticsStatus: typeof getLogBrewAppleNativeDiagnosticsStatus;
  getLogBrewAndroidNativeDiagnosticsStatus: typeof getLogBrewAndroidNativeDiagnosticsStatus;
  installLogBrewAppleNativeDiagnostics: typeof installLogBrewAppleNativeDiagnostics;
  installLogBrewAndroidNativeDiagnostics: typeof installLogBrewAndroidNativeDiagnostics;
  purgeLogBrewReactNativePersistentQueue: typeof purgeLogBrewReactNativePersistentQueue;
  replayLogBrewAppleNativeDiagnostics: typeof replayLogBrewAppleNativeDiagnostics;
  setLogBrewAppleNativeCrashContext: typeof setLogBrewAppleNativeCrashContext;
  uninstallLogBrewAndroidNativeDiagnostics: typeof uninstallLogBrewAndroidNativeDiagnostics;
};

export type {
  CaptureAppStateChangeOptions,
  CaptureReactNativeErrorOptions,
  CaptureScreenViewOptions,
  CreateAppStateListenerOptions,
  CreateLogBrewReactNativeClientConfig,
  LogBrewNativeActions,
  LogBrewNativeContextValue,
  LogBrewNativeProviderProps,
  ReactNativeActionEvent,
  ReactNativeActionIdFactoryContext,
  ReactNativeActionInput,
  ReactNativeAppStateLike,
  ReactNativeContextOptions,
  ReactNativeErrorEvent,
  ReactNativeErrorIdFactoryContext,
  ReactNativeFetchLike,
  ReactNativeFetchResponseLike,
  ReactNativeFetchTransportConfig,
  ReactNativeNavigationSpanIdFactoryContext,
  ReactNativeNavigationSpanInput,
  ReactNativeNetworkIdFactoryContext,
  ReactNativeNetworkInput,
  ReactNativePlatformLike,
  ReactNativeResourceSpanIdFactoryContext,
  ReactNativeResourceSpanInput,
  ReactNativeSpanAttributesInput,
  ReactNativeSpanEvent,
  ReactNativeTraceContext,
  ReactNativeTraceContextConfig,
  ReactNativeTraceInput,
  ReactNativeTraceparentConfig,
  ReactNavigationContainerLike,
  ReactNavigationRouteLike,
  ReactNavigationSpanListenerOptions,
  TracePropagationTarget,
  TraceparentFetchConfig,
  TraceparentFetchLike
} from "./index.js";
export {
  LogBrewNativeProvider,
  bindLogBrewTrace,
  captureAppStateChange,
  captureDefaultAppStateChange,
  captureDefaultReactNativeAction,
  captureDefaultReactNativeError,
  captureDefaultReactNativeNetwork,
  captureDefaultScreenView,
  captureReactNativeAction,
  captureReactNativeError,
  captureReactNativeNavigationSpan,
  captureReactNativeNetwork,
  captureReactNativeResourceSpan,
  captureScreenView,
  createAppStateListener,
  createDefaultAppStateListener,
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
  createReactNavigationSpanListener,
  createTraceparentFetch,
  getActiveLogBrewTrace,
  getDefaultReactNativeContext,
  getReactNativeContext,
  getReactNativeTraceMetadata,
  shouldPropagateTraceparent,
  useLogBrewNative,
  useLogBrewNativeActions,
  withLogBrewTrace
} from "./index.js";
export * from "./apple-native-diagnostics.js";
export * from "./android-native-diagnostics.js";
export {
  installLogBrewReactNativeGlobalErrorHandler,
  installLogBrewReactNativePromiseRejectionTracker
} from "./global-errors.js";
export type {
  CreateNativeLogBrewReactNativeClientConfig,
  ReactNativePersistentQueueMode
};
export {
  createLogBrewReactNativeClient,
  createDefaultLogBrewReactNativeClient,
  purgeLogBrewReactNativePersistentQueue
};
export default defaultExport;
