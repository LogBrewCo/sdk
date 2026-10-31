import type {
  CaptureAppStateChangeOptions,
  CaptureReactNativeErrorOptions,
  CaptureScreenViewOptions,
  CreateAppStateListenerOptions,
  ReactNativeActionEvent,
  ReactNativeActionInput,
  ReactNativeErrorEvent,
  ReactNativeNetworkInput
} from "./events.js";
import type { LogBrewClient, Metadata } from "@logbrew/sdk";
import type { CreateLogBrewReactNativeClientConfig } from "./config.js";

declare function createDefaultLogBrewReactNativeClient(
  config: CreateLogBrewReactNativeClientConfig
): LogBrewClient;
declare function getDefaultReactNativeContext(options?: { metadata?: Metadata }): Metadata;
declare function captureDefaultScreenView(
  client: LogBrewClient,
  screenName: string,
  options?: Omit<CaptureScreenViewOptions, "platform" | "appState">
): void;
declare function captureDefaultAppStateChange(
  client: LogBrewClient,
  state: string,
  options?: Omit<CaptureAppStateChangeOptions, "platform" | "appState">
): void;
declare function captureDefaultReactNativeAction(
  client: LogBrewClient,
  input?: Omit<ReactNativeActionInput, "platform" | "appState">
): ReactNativeActionEvent;
declare function captureDefaultReactNativeNetwork(
  client: LogBrewClient,
  input?: Omit<ReactNativeNetworkInput, "platform" | "appState">
): ReactNativeActionEvent;
declare function captureDefaultReactNativeError(
  client: LogBrewClient,
  error: unknown,
  options?: Omit<CaptureReactNativeErrorOptions, "platform" | "appState">
): ReactNativeErrorEvent;
declare function createDefaultAppStateListener(
  client: LogBrewClient,
  options?: Omit<CreateAppStateListenerOptions, "appState">
): () => void;

export {
  captureDefaultAppStateChange,
  captureDefaultReactNativeAction,
  captureDefaultReactNativeError,
  captureDefaultReactNativeNetwork,
  captureDefaultScreenView,
  createDefaultAppStateListener,
  createDefaultLogBrewReactNativeClient,
  getDefaultReactNativeContext
};
