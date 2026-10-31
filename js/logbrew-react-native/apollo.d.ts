import type { Metadata } from "@logbrew/sdk";
import type { ReactNativeTraceContext } from "./index.js";

type ApolloOperationLike = {
  operationName?: string;
  query?: {
    definitions?: readonly {
      kind?: string;
      operation?: string;
      name?: { value?: string };
    }[];
  };
  setContext?: (context: ((previous: { headers?: Record<string, string> }) => { headers?: Record<string, string> }) | { headers?: Record<string, string> }) => void;
};

type ApolloObserverLike<TValue = unknown> = {
  next?: (value: TValue) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
};

type ApolloObservableLike<TValue = unknown> = {
  subscribe: (
    observerOrNext?: ApolloObserverLike<TValue> | ((value: TValue) => void),
    onError?: (error: unknown) => void,
    onComplete?: () => void
  ) => unknown;
};

type ApolloForwardLike<TValue = unknown> = (operation: ApolloOperationLike) => ApolloObservableLike<TValue>;

type ApolloLinkConstructor<TLink = unknown, TValue = unknown> = new (
  request?: (...args: any[]) => any
) => TLink;

type ReactNativeApolloMetadataFactoryContext = {
  durationMs?: number;
  error?: unknown;
  operationName?: string;
  operationType?: string;
  screen?: string;
  status: "ok" | "error";
};

type ReactNativeApolloLinkOptions<TLink = unknown, TValue = unknown> = {
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

declare function createReactNativeApolloLink<TLink = unknown, TValue = unknown>(
  client: { span: (id: string, timestamp: string, attributes: any) => unknown },
  options: ReactNativeApolloLinkOptions<TLink, TValue>
): TLink;

declare const defaultExport: {
  createReactNativeApolloLink: typeof createReactNativeApolloLink;
};

export type {
  ApolloForwardLike,
  ApolloLinkConstructor,
  ApolloObservableLike,
  ApolloObserverLike,
  ApolloOperationLike,
  ReactNativeApolloLinkOptions,
  ReactNativeApolloMetadataFactoryContext
};
export {
  createReactNativeApolloLink
};
export default defaultExport;
