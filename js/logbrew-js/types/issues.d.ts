import type { Metadata, SeverityInput, TelemetryContext } from "./telemetry.js";
import type { LogBrewClient } from "./client.js";
import type { LogCorrelationTraceContext } from "./trace-context.js";

/** Privacy-bounded generated JavaScript frame attached to an issue. */
type IssueStackFrame = {
  /** Query-free generated filename or URL with local absolute prefixes removed. */
  filename: string;
  /** One-based generated source line. */
  line: number;
  /** One-based generated source column. */
  column: number;
  /** Optional bounded function or method identity. */
  function?: string;
  /** Optional bounded module, package, or namespace identity. */
  module?: string;
  /** Whether application code classified this frame as app-owned. */
  inApp?: boolean;
  /** Optional release-artifact Debug ID matched to this generated file. */
  debugId?: string;
};

/** Runtime path that captured an exception and whether it escaped that path. */
type IssueExceptionMechanism = {
  /** Stable low-cardinality capture mechanism, such as `react.error_boundary`. */
  type: string;
  /** False when the exception escaped the capture boundary. */
  handled: boolean;
};

/** Structured exception identity attached to an issue. */
type IssueException = {
  /** Bounded runtime exception class or error type. */
  type: string;
  /** Capture mechanism when the SDK can determine it. */
  mechanism?: IssueExceptionMechanism;
};

type IssueExceptionRelationship =
  | "reported"
  | "cause"
  | "context"
  | "aggregate_member"
  | "suppressed";

type IssueExceptionMessageState = "captured" | "truncated" | "redacted" | "not_captured";

type IssueExceptionStackFramesState = "captured" | "truncated" | "not_captured";

/** One parent-first runtime exception with its own message and structured stack state. */
type IssueExceptionChainEntry = {
  /** Contiguous zero-based node identity. */
  id: number;
  /** Earlier parent node. Omitted only for the reported root exception. */
  parentId?: number;
  relationship: IssueExceptionRelationship;
  type: string;
  /** Bounded message only when messageState is captured or truncated. */
  message?: string;
  messageState: IssueExceptionMessageState;
  module?: string;
  mechanism?: IssueExceptionMechanism;
  /** This exact exception's bounded structured frames. */
  stackFrames?: IssueStackFrame[];
  stackFramesState: IssueExceptionStackFramesState;
};

/** At most eight parent-first runtime exceptions. */
type IssueExceptionChain = {
  entries: IssueExceptionChainEntry[];
  /** True when a cycle or node cap omitted additional exceptions. */
  truncated: boolean;
};

type IssueBreadcrumbLevel = "debug" | "info" | "warning" | "error" | "critical";

type IssueBreadcrumbLevelInput = IssueBreadcrumbLevel | "trace" | "log" | "warn" | "fatal";

type IssueBreadcrumbDataValue = string | number | boolean | null;

/** One privacy-bounded step that happened before an issue. */
type IssueBreadcrumb = {
  /** RFC 3339 timestamp with an explicit timezone. */
  timestamp: string;
  /** Optional stable breadcrumb kind, such as `navigation` or `http`. */
  type?: string;
  /** Required low-cardinality source category. */
  category: string;
  level?: IssueBreadcrumbLevel;
  /** Optional bounded display-safe description. */
  message?: string;
  /** At most eight flat primitive fields. Never include authentication material or raw request data. */
  data?: Record<string, IssueBreadcrumbDataValue>;
};

/** Input accepted by `addBreadcrumb`; the client supplies the current timestamp when omitted. */
type IssueBreadcrumbInput = Omit<IssueBreadcrumb, "timestamp" | "level"> & {
  timestamp?: string;
  level?: IssueBreadcrumbLevelInput;
};

/** App-reported code location that narrows the smallest likely fix area. */
type IssueLikelyFixArea = {
  component?: string;
  module?: string;
  function?: string;
  /** Safe repository-relative source path. */
  file?: string;
  line?: number;
  column?: number;
  inApp?: boolean;
};

/** App-reported user impact without user identities or raw request data. */
type IssueImpactEvidence = {
  affectedUserSegment?: string;
  failedAction?: string;
  userVisibleOutcome?: string;
};

/** Explicit diagnostic evidence for cause, fix area, impact, and capture limitations. */
type IssueDiagnosticEvidence = {
  /** App-owned hypothesis. LogBrew presents it as reported, never proven. */
  likelyRootCause?: string;
  likelyFixArea?: IssueLikelyFixArea;
  impact?: IssueImpactEvidence;
  /** Unique bounded field names whose values were captured. */
  capturedFields?: string[];
  missingFields?: string[];
  redactedFields?: string[];
  truncatedFields?: string[];
};

type NativeStackArchitecture = "arm" | "arm64" | "arm64e" | "x86" | "x86_64";

type NativeStackFrame = {
  imageUuid: string;
  architecture: NativeStackArchitecture;
  instructionOffset: string;
};

/** Public issue event attributes. */
type IssueAttributes = {
  title: string;
  level: SeverityInput;
  message?: string;
  exception?: IssueException;
  /** Parent-first runtime exception evidence; the first node agrees with legacy exception/stackFrames. */
  exceptionChain?: IssueExceptionChain;
  /** Ordered privacy-bounded generated frames, capped at 32. */
  stackFrames?: IssueStackFrame[];
  /** Ordered native image-relative frames for exact release symbolication, capped at 32. */
  nativeStackFrames?: NativeStackFrame[];
  /** Oldest-to-newest issue history, capped at the most recent 64 entries. */
  breadcrumbs?: IssueBreadcrumb[];
  /** True when older or invalid history was omitted before capture. */
  breadcrumbsTruncated?: boolean;
  /** App-reported diagnostic evidence, validated and labeled separately from observed facts. */
  evidence?: IssueDiagnosticEvidence;
  metadata?: Metadata;
  context?: TelemetryContext;
};

/** Options for creating privacy-bounded issue attributes from a JavaScript error. */
type JavaScriptErrorIssueOptions = {
  title?: string;
  level?: SeverityInput;
  message?: string;
  metadata?: Metadata;
  /** Stable low-cardinality capture mechanism. Defaults to `javascript.error`. */
  mechanism?: string;
  /** Whether the error was handled by the capture boundary. Defaults to true. */
  handled?: boolean;
  /** Metadata source label. Defaults to `javascript.error`. */
  source?: string;
  /** Active trace copied into primitive correlation metadata. */
  trace?: LogCorrelationTraceContext | null;
  /** Release name associated with the runtime error. */
  release?: string;
  /** Environment associated with the runtime error. */
  environment?: string;
  /** Service associated with the runtime error. */
  service?: string;
  /** Runtime label such as `browser`, `node`, or `react-native`. */
  runtime?: string;
  /** Platform label such as `web`, `ios`, or `android`. */
  platform?: string;
  /** Map of sanitized frame filenames or minified URLs to release-artifact Debug IDs. */
  debugIdMap?: Record<string, string>;
  /** Optional stable app-owned grouping fingerprint. Keep it safe and low-cardinality. */
  fingerprint?: string;
  /** App-reported cause, fix-area, impact, and explicit evidence-state receipt. */
  evidence?: IssueDiagnosticEvidence;
  /** Include raw stack text only when the app has explicitly approved it. Defaults to false. */
  includeErrorStack?: boolean;
};

/** Options for automatic browser breadcrumbs. Every source defaults to true. */
type BrowserBreadcrumbOptions = {
  console?: boolean;
  network?: boolean;
  navigation?: boolean;
  /** URLs whose requests are not recorded, such as the LogBrew ingest endpoint. */
  ignoredUrls?: string[];
};

/**
 * Record console calls, fetch and XHR requests, and route changes in a browser window as issue
 * breadcrumbs on the client. The wrappers only observe calls. Returns an uninstall function.
 */
declare function installBrowserBreadcrumbs(
  browserWindow: unknown,
  client: LogBrewClient,
  options?: BrowserBreadcrumbOptions
): () => void;

/**
 * Convert a JavaScript Error-like value into safe issue attributes with optional source-map Debug ID metadata.
 * Parent-first cause and AggregateError evidence is bounded to the public exception-chain contract.
 */
declare function createIssueAttributesFromError(
  error: unknown,
  options?: JavaScriptErrorIssueOptions
): IssueAttributes;

export type {
  BrowserBreadcrumbOptions,
  IssueAttributes,
  IssueBreadcrumb,
  IssueBreadcrumbDataValue,
  IssueBreadcrumbInput,
  IssueBreadcrumbLevel,
  IssueBreadcrumbLevelInput,
  IssueDiagnosticEvidence,
  IssueException,
  IssueExceptionChain,
  IssueExceptionChainEntry,
  IssueExceptionMechanism,
  IssueExceptionMessageState,
  IssueExceptionRelationship,
  IssueExceptionStackFramesState,
  IssueImpactEvidence,
  IssueLikelyFixArea,
  IssueStackFrame,
  JavaScriptErrorIssueOptions,
  NativeStackArchitecture,
  NativeStackFrame
};
export { createIssueAttributesFromError, installBrowserBreadcrumbs };
