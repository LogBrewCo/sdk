import type * as React from "react";
import type {
  ActionAttributes,
  EnvironmentAttributes,
  IssueAttributes,
  LogAttributes,
  LogBrewClient,
  Metadata,
  ReleaseAttributes,
  SpanAttributes,
  Transport,
  TransportResponse
} from "@logbrew/sdk";

export type CreateLogBrewReactClientConfig = {
  apiKey?: string;
  clientKey?: string;
  sdkName?: string;
  sdkVersion?: string;
  maxRetries?: number;
};

export type TracePropagationTarget = string | RegExp | ((url: string) => boolean);

export type ReactTraceparentConfig = {
  traceId?: string;
  spanId?: string;
  traceFlags?: string;
  randomValues?: (length: number) => ArrayLike<number>;
};

export type TraceparentFetchLike<TResponse = unknown> = (
  input: any,
  init?: any
) => Promise<TResponse> | TResponse;

export type TraceparentFetchConfig<TResponse = unknown> = {
  fetchImpl?: TraceparentFetchLike<TResponse>;
  randomValues?: (length: number) => ArrayLike<number>;
  traceFlags?: string;
  traceparent?: string;
  traceparentFactory?: (context: {
    input: any;
    init?: any;
    url: string;
  }) => string | undefined;
  tracePropagationTargets?: TracePropagationTarget[];
};

export type LogBrewProviderProps = {
  client: LogBrewClient;
  children?: React.ReactNode;
};

export type ReactErrorEvent = {
  id: string;
  timestamp: string;
  attributes: IssueAttributes;
};

export type ReactErrorIdFactoryContext = {
  error: unknown;
  message: string;
};

export type CaptureReactErrorOptions = {
  componentStack?: string;
  id?: string;
  idFactory?: (context: ReactErrorIdFactoryContext) => string;
  includeComponentStack?: boolean;
  includeStack?: boolean;
  level?: IssueAttributes["level"];
  metadata?: Metadata;
  now?: () => string;
  timestamp?: string;
};

export type LogBrewErrorBoundaryFallbackProps = {
  error: unknown;
  componentStack: string;
  resetError(): void;
};

export type LogBrewErrorBoundaryProps = CaptureReactErrorOptions & {
  children?: React.ReactNode;
  client?: LogBrewClient;
  fallback?: React.ReactNode | ((props: LogBrewErrorBoundaryFallbackProps) => React.ReactNode);
  onCaptureError?: (error: unknown) => void;
  onError?: (error: unknown, info: React.ErrorInfo, event: ReactErrorEvent) => void;
  raiseCaptureErrors?: boolean;
};

export type LogBrewActions = {
  release(id: string, timestamp: string, attributes: ReleaseAttributes): void;
  environment(id: string, timestamp: string, attributes: EnvironmentAttributes): void;
  issue(id: string, timestamp: string, attributes: IssueAttributes): void;
  log(id: string, timestamp: string, attributes: LogAttributes): void;
  span(id: string, timestamp: string, attributes: SpanAttributes): void;
  action(id: string, timestamp: string, attributes: ActionAttributes): void;
  flush(transport: Transport): Promise<TransportResponse>;
  shutdown(transport: Transport): Promise<TransportResponse>;
  previewJson(): string;
  pendingEvents(): number;
  captureReactError(error: unknown, options?: CaptureReactErrorOptions): ReactErrorEvent;
};

export declare function createLogBrewReactClient(config: CreateLogBrewReactClientConfig): LogBrewClient;
export declare function createReactTraceparent(config?: ReactTraceparentConfig): string;
export declare function createTraceparentFetch<TResponse = unknown>(
  config?: TraceparentFetchConfig<TResponse>
): TraceparentFetchLike<TResponse>;
export declare function shouldPropagateTraceparent(
  url: string,
  tracePropagationTargets?: TracePropagationTarget[]
): boolean;
export declare function LogBrewProvider(props: LogBrewProviderProps): React.ReactElement;
export declare class LogBrewErrorBoundary extends React.Component<LogBrewErrorBoundaryProps> {}
export declare function createReactErrorEvent(error: unknown, options?: CaptureReactErrorOptions): ReactErrorEvent;
export declare function captureReactError(
  client: LogBrewClient,
  error: unknown,
  options?: CaptureReactErrorOptions
): ReactErrorEvent;
export declare function useLogBrew(): LogBrewClient;
export declare function useLogBrewActions(): LogBrewActions;

declare const defaultExport: {
  LogBrewErrorBoundary: typeof LogBrewErrorBoundary;
  LogBrewProvider: typeof LogBrewProvider;
  captureReactError: typeof captureReactError;
  createLogBrewReactClient: typeof createLogBrewReactClient;
  createReactErrorEvent: typeof createReactErrorEvent;
  createReactTraceparent: typeof createReactTraceparent;
  createTraceparentFetch: typeof createTraceparentFetch;
  shouldPropagateTraceparent: typeof shouldPropagateTraceparent;
  useLogBrew: typeof useLogBrew;
  useLogBrewActions: typeof useLogBrewActions;
};

export default defaultExport;
