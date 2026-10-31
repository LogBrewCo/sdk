import type {
  ActionAttributes,
  DeliveryHealthSnapshot,
  EnvironmentAttributes,
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  ReleaseAttributes,
  SpanAttributes,
  Transport,
  TransportResponse
} from "@logbrew/sdk";
import type {
  CaptureAppStateChangeOptions,
  CaptureReactNativeErrorOptions,
  CaptureScreenViewOptions,
  ReactNativeActionEvent,
  ReactNativeActionInput,
  ReactNativeErrorEvent,
  ReactNativeNavigationSpanInput,
  ReactNativeNetworkInput,
  ReactNativeResourceSpanInput,
  ReactNativeSpanEvent
} from "./events.js";
import type { ReactElement, ReactNode } from "react";
import type { ReactNativeAppStateLike, ReactNativePlatformLike } from "./config.js";
import type { ReactNativeTraceContext, ReactNativeTraceInput } from "./trace.js";

type LogBrewNativeProviderProps = {
  client: LogBrewClient;
  platform?: ReactNativePlatformLike;
  appState?: ReactNativeAppStateLike;
  trace?: ReactNativeTraceInput;
  children?: ReactNode;
};

type LogBrewNativeContextValue = {
  client: LogBrewClient;
  platform?: ReactNativePlatformLike;
  appState?: ReactNativeAppStateLike;
  trace?: ReactNativeTraceContext;
};

type LogBrewNativeActions = {
  release(id: string, timestamp: string, attributes: ReleaseAttributes): void;
  environment(id: string, timestamp: string, attributes: EnvironmentAttributes): void;
  issue(id: string, timestamp: string, attributes: IssueAttributes): void;
  log(id: string, timestamp: string, attributes: LogAttributes): void;
  span(id: string, timestamp: string, attributes: SpanAttributes): void;
  action(id: string, timestamp: string, attributes: ActionAttributes): void;
  flush(transport?: Transport): Promise<TransportResponse>;
  shutdown(transport?: Transport): Promise<TransportResponse>;
  deliveryHealth(): DeliveryHealthSnapshot;
  droppedEvents(): number;
  pendingBytes(): number;
  previewJson(): string;
  pendingEvents(): number;
  trace?: ReactNativeTraceContext;
  captureScreenView(screenName: string, options?: CaptureScreenViewOptions): void;
  captureAppStateChange(state: string, options?: CaptureAppStateChangeOptions): void;
  captureReactNativeAction(input?: ReactNativeActionInput): ReactNativeActionEvent;
  captureReactNativeNetwork(input?: ReactNativeNetworkInput): ReactNativeActionEvent;
  captureReactNativeNavigationSpan(input?: ReactNativeNavigationSpanInput): ReactNativeSpanEvent;
  captureReactNativeResourceSpan(input?: ReactNativeResourceSpanInput): ReactNativeSpanEvent;
  captureReactNativeError(error: unknown, options?: CaptureReactNativeErrorOptions): ReactNativeErrorEvent;
};

declare function LogBrewNativeProvider(props: LogBrewNativeProviderProps): ReactElement;
declare function useLogBrewNative(): LogBrewNativeContextValue;
declare function useLogBrewNativeActions(): LogBrewNativeActions;

export type {
  LogBrewNativeActions,
  LogBrewNativeContextValue,
  LogBrewNativeProviderProps
};
export {
  LogBrewNativeProvider,
  useLogBrewNative,
  useLogBrewNativeActions
};
