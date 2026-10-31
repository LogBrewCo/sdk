/** Transport error that can optionally be marked retryable by the caller. */
declare class TransportError extends Error {
  public code: string;
  public retryable: boolean;
  public constructor(code: string, message: string, retryable?: boolean);
  /** Create a retryable network failure that preserves queued events. */
  public static network(message: string): TransportError;
}

export { TransportError };
