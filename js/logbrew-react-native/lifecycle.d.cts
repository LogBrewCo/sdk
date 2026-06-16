import type { LogBrewClient, Metadata, SpanAttributes } from "@logbrew/sdk";
import type {
  ReactNativeAppStateLike,
  ReactNativeContextOptions,
  ReactNativeSpanEvent
} from "./index.cjs";

export type ReactNativeLifecycleSpanInput = ReactNativeContextOptions & {
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

export type ReactNativeLifecycleSpanIdFactoryContext = {
  fromState?: string;
  screen?: string;
  toState?: string;
};

export type AppStateLifecycleSpanListenerOptions = ReactNativeContextOptions & {
  captureInitialState?: boolean;
  metadata?: Metadata;
  now?: () => string;
  nowMs?: () => number;
  onError?: (error: unknown) => void;
  screen?: string;
  sessionId?: string;
};

export declare function createReactNativeLifecycleSpanEvent(
  input?: ReactNativeLifecycleSpanInput
): ReactNativeSpanEvent;
export declare function captureReactNativeLifecycleSpan(
  client: LogBrewClient,
  input?: ReactNativeLifecycleSpanInput
): ReactNativeSpanEvent;
export declare function createAppStateLifecycleSpanListener(
  client: LogBrewClient,
  appState: ReactNativeAppStateLike,
  options?: AppStateLifecycleSpanListenerOptions
): () => void;
