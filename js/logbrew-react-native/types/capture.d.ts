import type {
  CaptureAppStateChangeOptions,
  CaptureReactNativeErrorOptions,
  CaptureScreenViewOptions,
  CreateAppStateListenerOptions,
  ReactNativeActionEvent,
  ReactNativeActionInput,
  ReactNativeContextOptions,
  ReactNativeErrorEvent,
  ReactNativeNavigationSpanInput,
  ReactNativeNetworkInput,
  ReactNativeResourceSpanInput,
  ReactNativeSpanEvent,
  ReactNavigationContainerLike,
  ReactNavigationSpanListenerOptions
} from "./events.js";
import type { LogBrewClient, Metadata } from "@logbrew/sdk";
import type { ReactNativeAppStateLike } from "./config.js";

declare function getReactNativeContext(options?: ReactNativeContextOptions): Metadata;
declare function captureScreenView(
  client: LogBrewClient,
  screenName: string,
  options?: CaptureScreenViewOptions
): void;
declare function captureAppStateChange(
  client: LogBrewClient,
  state: string,
  options?: CaptureAppStateChangeOptions
): void;
declare function createReactNativeActionEvent(
  input?: ReactNativeActionInput
): ReactNativeActionEvent;
declare function captureReactNativeAction(
  client: LogBrewClient,
  input?: ReactNativeActionInput
): ReactNativeActionEvent;
declare function createReactNativeNetworkEvent(
  input?: ReactNativeNetworkInput
): ReactNativeActionEvent;
declare function captureReactNativeNetwork(
  client: LogBrewClient,
  input?: ReactNativeNetworkInput
): ReactNativeActionEvent;
declare function createReactNativeNavigationSpanEvent(
  input?: ReactNativeNavigationSpanInput
): ReactNativeSpanEvent;
declare function captureReactNativeNavigationSpan(
  client: LogBrewClient,
  input?: ReactNativeNavigationSpanInput
): ReactNativeSpanEvent;
declare function createReactNativeResourceSpanEvent(
  input?: ReactNativeResourceSpanInput
): ReactNativeSpanEvent;
declare function captureReactNativeResourceSpan(
  client: LogBrewClient,
  input?: ReactNativeResourceSpanInput
): ReactNativeSpanEvent;
declare function createReactNavigationSpanListener(
  client: LogBrewClient,
  navigationContainer: ReactNavigationContainerLike,
  options?: ReactNavigationSpanListenerOptions
): () => void;
declare function createReactNativeErrorEvent(
  error: unknown,
  options?: CaptureReactNativeErrorOptions
): ReactNativeErrorEvent;
declare function captureReactNativeError(
  client: LogBrewClient,
  error: unknown,
  options?: CaptureReactNativeErrorOptions
): ReactNativeErrorEvent;
declare function createAppStateListener(
  client: LogBrewClient,
  appState: ReactNativeAppStateLike,
  options?: CreateAppStateListenerOptions
): () => void;

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
};
