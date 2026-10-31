import type { ActionAttributes, Metadata } from "./telemetry.js";

/** Stable product-analytics event categories carried in reserved action metadata. */
type ProductAnalyticsKind = "page_view" | "screen_view" | "interaction";

/** App-owned product step input for agent-readable action timelines. */
type ProductActionInput = string | {
  name: string;
  status?: ActionAttributes["status"];
  sessionId?: string;
  traceId?: string;
  routeTemplate?: string;
  screen?: string;
  funnel?: string;
  step?: string;
  metadata?: Metadata;
};

/** App-owned API milestone input for agent-readable network timelines. */
type NetworkMilestoneInput = string | {
  name?: string;
  routeTemplate: string;
  method?: string;
  status?: ActionAttributes["status"];
  statusCode?: number;
  durationMs?: number;
  sessionId?: string;
  traceId?: string;
  metadata?: Metadata;
};

/** Shared timeline helper options for primitive app metadata. */
type TimelineAttributesOptions = {
  metadata?: Metadata;
};

/** Support-ticket sources accepted by explicit draft helpers. */
type SupportTicketSource = "cli" | "sdk" | "website" | "docs" | "mobile";

/** Support-ticket categories accepted by explicit draft helpers. */
type SupportTicketCategory =
  | "sdk_install_failure"
  | "ingest_failure"
  | "auth_failure"
  | "project_setup"
  | "dashboard_issue"
  | "docs_confusion"
  | "cli_issue"
  | "mobile_issue"
  | "billing_question"
  | "other";

/** JSON-like diagnostics input sanitized before a support-ticket draft is returned. */
type SupportDiagnosticsValue =
  | string
  | number
  | boolean
  | null
  | SupportDiagnosticsValue[]
  | { [key: string]: SupportDiagnosticsValue };

/** Explicit local-only support-ticket draft input. This does not open a ticket. */
type SupportTicketDraftInput = {
  source: SupportTicketSource;
  category: SupportTicketCategory;
  title: string;
  description: string;
  projectId?: string;
  environment?: string;
  runtime?: string;
  framework?: string;
  sdkPackage?: string;
  sdkVersion?: string;
  release?: string;
  traceId?: string;
  eventId?: string;
  diagnostics?: Record<string, unknown>;
};

/** Support-ticket create body built locally. It sends nothing. */
type SupportTicketDraft = {
  source: SupportTicketSource;
  category: SupportTicketCategory;
  title: string;
  description: string;
  project_id?: string;
  environment?: string;
  runtime?: string;
  framework?: string;
  sdk_package?: string;
  sdk_version?: string;
  release?: string;
  trace_id?: string;
  event_id?: string;
  diagnostics?: Record<string, SupportDiagnosticsValue>;
};

/** Create safe action attributes for an app-owned product step without automatic UI capture. */
declare function createProductActionAttributes(
  action: ProductActionInput,
  options?: TimelineAttributesOptions
): ActionAttributes;

/** Create safe action attributes for an app-owned network milestone without HTTP client patching. */
declare function createNetworkMilestoneAttributes(
  request: NetworkMilestoneInput,
  options?: TimelineAttributesOptions
): ActionAttributes;

/** Build a local-only, token-free support-ticket create payload draft without calling backend routes. */
declare function createSupportTicketDraft(input: SupportTicketDraftInput): SupportTicketDraft;

export type {
  NetworkMilestoneInput,
  ProductActionInput,
  ProductAnalyticsKind,
  SupportDiagnosticsValue,
  SupportTicketCategory,
  SupportTicketDraft,
  SupportTicketDraftInput,
  SupportTicketSource,
  TimelineAttributesOptions
};
export {
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createSupportTicketDraft
};
