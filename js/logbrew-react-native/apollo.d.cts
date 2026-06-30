import type { Metadata } from "@logbrew/sdk";
import type { ReactNativeTraceContext } from "./index.cjs";

export type ApolloOperationLike = {
  operationName?: string;
  query?: {
    definitions?: ReadonlyArray<{
      kind?: string;
      operation?: string;
      name?: { value?: string };
    }>;
  };
  setContext?: (context: ((previous: { headers?: Record<string, string> }) => { headers?: Record<string, string> }) | { headers?: Record<string, string> }) => void;
};

export type ApolloObserverLike<TValue = unknown> = {
  next?: (value: TValue) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
};

export type ApolloObservableLike<TValue = unknown> = {
  subscribe: (
    observerOrNext?: ApolloObserverLike<TValue> | ((value: TValue) => void),
    onError?: (error: unknown) => void,
    onComplete?: () => void
  ) => unknown;
};

export type ApolloForwardLike<TValue = unknown> = (operation: ApolloOperationLike) => ApolloObservableLike<TValue>;

export type ApolloLinkConstructor<TLink = unknown, TValue = unknown> = new (
  request?: (...args: any[]) => any
) => TLink;

export type ReactNativeApolloMetadataFactoryContext = {
  durationMs?: number;
  error?: unknown;
  operationName?: string;
  operationType?: string;
  screen?: string;
  status: "ok" | "error";
};

export type ReactNativeApolloLinkOptions<TLink = unknown, TValue = unknown> = {
  ApolloLink: ApolloLinkConstructor<TLink, TValue>;
  appState?: { currentState?: string };
  metadata?: Metadata;
  metadataFactory?: (context: ReactNativeApolloMetadataFactoryContext) => Metadata | undefined;
  now?: () => string;
  nowMs?: () => number;
  platform?: { OS?: string; Version?: string | number; isPad?: boolean; constants?: { isTesting?: boolean } };
  propagateTraceparent?: boolean;
  randomValues?: (length: number) => Uint8Array;
  screen?: string;
  sessionId?: string;
  trace?: ReactNativeTraceContext | string;
  traceFlags?: string;
};

export function createReactNativeApolloLink<TLink = unknown, TValue = unknown>(
  client: { span: (id: string, timestamp: string, attributes: any) => unknown },
  options: ReactNativeApolloLinkOptions<TLink, TValue>
): TLink;

declare const _default: {
  createReactNativeApolloLink: typeof createReactNativeApolloLink;
};

export default _default;
