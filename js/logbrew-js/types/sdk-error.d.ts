/** Stable public SDK error with parseable code and message fields. */
declare class SdkError extends Error {
  public code: string;
  public retryAfterMs?: number;
  public retryable?: boolean;
  public constructor(code: string, message: string, details?: { retryAfterMs?: number; retryable?: boolean });
}

export { SdkError };
