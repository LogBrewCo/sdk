import type { LogBrewClient, Metadata, SpanAttributes } from "@logbrew/sdk";
import type {
  ReactNativeAppStateLike,
  ReactNativeContextOptions,
  ReactNativeSpanEvent
} from "./index.js";

type ReactNativeLifecycleSpanInput = ReactNativeContextOptions & {
  durationMs?: number;
  fromState?: string;
  id?: string;
  idFactory?: (context: ReactNativeLifecycleSpanIdFactoryContext) => string;
  name?: string;
  now?: () => string;
  screen?: string;
  sessionId?: string;
  state?: string;
  status?: SpanAttributes["status"];
  timestamp?: string;
  toState?: string;
};

type ReactNativeLifecycleSpanIdFactoryContext = {
  fromState?: string;
  screen?: string;
  toState?: string;
};

type AppStateLifecycleSpanListenerOptions = ReactNativeContextOptions & {
  captureInitialState?: boolean;
  metadata?: Metadata;
  now?: () => string;
  nowMs?: () => number;
  onError?: (error: unknown) => void;
  screen?: string;
  sessionId?: string;
};

declare function createReactNativeLifecycleSpanEvent(
  input?: ReactNativeLifecycleSpanInput
): ReactNativeSpanEvent;
declare function captureReactNativeLifecycleSpan(
  client: LogBrewClient,
  input?: ReactNativeLifecycleSpanInput
): ReactNativeSpanEvent;
declare function createAppStateLifecycleSpanListener(
  client: LogBrewClient,
  appState: ReactNativeAppStateLike,
  options?: AppStateLifecycleSpanListenerOptions
): () => void;

export type {
  AppStateLifecycleSpanListenerOptions,
  ReactNativeLifecycleSpanIdFactoryContext,
  ReactNativeLifecycleSpanInput
};
export {
  createReactNativeLifecycleSpanEvent,
  captureReactNativeLifecycleSpan,
  createAppStateLifecycleSpanListener
};
