import type {
  DroppedEvent,
  EventStore,
  LogBrewClient,
  TelemetryContext,
  Transport
} from "@logbrew/sdk";

type ReactNativePlatformLike = {
  OS?: string;
  Version?: string | number;
  isPad?: boolean;
  constants?: { isTesting?: boolean; [key: string]: unknown };
};

type ReactNativeAppStateLike = {
  currentState?: string | null;
  addEventListener?: (
    type: "change",
    listener: (state: string) => void
  ) => { remove(): void } | (() => void);
};

type CreateLogBrewReactNativeClientConfig = {
  automaticDelivery?: boolean;
  apiKey?: string;
  clientKey?: string;
  context?: TelemetryContext;
  /** Automatic delivery interval in milliseconds. Defaults to 5000 on mobile to save battery. */
  deliveryIntervalMs?: number;
  deliveryQueueThreshold?: number;
  /** Advanced synchronous persistence seam. React Native apps normally use the native entry's persistentQueue mode. */
  eventStore?: EventStore;
  maxBatchBytes?: number;
  maxBatchEvents?: number;
  maxQueueBytes?: number;
  maxQueueSize?: number;
  maxRetries?: number;
  onEventDropped?: (drop: DroppedEvent) => void;
  sdkName?: string;
  sdkVersion?: string;
  transport?: Transport;
};

type ReactNativeFetchResponseLike = {
  status: number;
  headers?: {
    get(name: string): string | null | undefined;
  };
};

type ReactNativeFetchLike = (
  endpoint: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: "POST";
  }
) => Promise<ReactNativeFetchResponseLike> | ReactNativeFetchResponseLike;

type ReactNativeFetchTransportConfig = {
  endpoint?: string;
  fetchImpl?: ReactNativeFetchLike;
  headers?: Record<string, string>;
};

declare function createLogBrewReactNativeClient(
  config: CreateLogBrewReactNativeClientConfig
): LogBrewClient;
declare function createReactNativeFetchTransport(
  config?: ReactNativeFetchTransportConfig
): Transport;

export type {
  CreateLogBrewReactNativeClientConfig,
  ReactNativeAppStateLike,
  ReactNativeFetchLike,
  ReactNativeFetchResponseLike,
  ReactNativeFetchTransportConfig,
  ReactNativePlatformLike
};
export {
  createLogBrewReactNativeClient,
  createReactNativeFetchTransport
};
