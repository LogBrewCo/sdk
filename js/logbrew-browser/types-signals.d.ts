import type { ActionAttributes, Metadata } from "@logbrew/sdk";
import type { BrowserTraceContextInput } from "./types-transport.js";

type BrowserFetchInput = {
  input?: RequestInfo | URL | undefined;
  init?: RequestInit | undefined;
  method?: string | undefined;
  url?: string | undefined;
  statusCode?: number | undefined;
  durationMs?: number | undefined;
  responseBodySize?: number | undefined;
  errorType?: string | undefined;
  spanTraceContext?: BrowserTraceContextInput | undefined;
  tracePropagated?: boolean | undefined;
};

type BrowserFetchTemplateContext = {
  input?: RequestInfo | URL | undefined;
  init?: RequestInit | undefined;
  method: string;
  path: string;
};

type BrowserFetchPathTemplate =
  | string
  | ((context: BrowserFetchTemplateContext) => string | undefined);

type BrowserXhrInput = {
  method?: string | undefined;
  url?: string | undefined;
  statusCode?: number | undefined;
  durationMs?: number | undefined;
  responseBodySize?: number | undefined;
  errorType?: string | undefined;
  spanTraceContext?: BrowserTraceContextInput | undefined;
  tracePropagated?: boolean | undefined;
};

type BrowserXhrTemplateContext = {
  method: string;
  path: string;
};

type BrowserXhrPathTemplate =
  | string
  | ((context: BrowserXhrTemplateContext) => string | undefined);

type LogBrewBrowserEvent<TAttributes> = {
  id: string;
  timestamp: string;
  attributes: TAttributes;
};

type BrowserIssueSuppressionMatcher = string | RegExp | (string | RegExp)[];

type BrowserIssueSuppressionRule = {
  /** Stable, non-sensitive reason reported when this rule suppresses an issue. */
  reason?: string | undefined;
  source?: BrowserIssueSuppressionMatcher | undefined;
  errorName?: BrowserIssueSuppressionMatcher | undefined;
  path?: BrowserIssueSuppressionMatcher | undefined;
  frameFile?: BrowserIssueSuppressionMatcher | undefined;
  groupingKey?: BrowserIssueSuppressionMatcher | undefined;
  fingerprint?: BrowserIssueSuppressionMatcher | undefined;
  /** Optional local-only message matcher. Matched message text is never included in suppression summaries. */
  message?: BrowserIssueSuppressionMatcher | undefined;
};

type BrowserIssueSuppressionSummary = {
  source?: string | undefined;
  errorName?: string | undefined;
  path?: string | undefined;
  errorFrameFile?: string | undefined;
  issueGroupingKey?: string | undefined;
  issueFingerprint?: string | undefined;
  reason: string;
};

type BrowserIssueSuppressedResult = {
  suppressed: true;
  reason: string;
};

type BrowserActionInput = string | {
  name: string;
  status?: ActionAttributes["status"] | undefined;
  metadata?: Metadata | undefined;
};

type BrowserNetworkInput = string | {
  name?: string | undefined;
  method?: string | undefined;
  routeTemplate: string;
  status?: ActionAttributes["status"] | undefined;
  statusCode?: number | undefined;
  durationMs?: number | undefined;
  sessionId?: string | undefined;
  traceId?: string | undefined;
  metadata?: Metadata | undefined;
};

type BrowserResourceTimingInput = PerformanceResourceTiming | {
  entryType?: string | undefined;
  name?: string | undefined;
  initiatorType?: string | undefined;
  startTime?: number | undefined;
  duration?: number | undefined;
  workerStart?: number | undefined;
  redirectStart?: number | undefined;
  redirectEnd?: number | undefined;
  fetchStart?: number | undefined;
  domainLookupStart?: number | undefined;
  domainLookupEnd?: number | undefined;
  connectStart?: number | undefined;
  secureConnectionStart?: number | undefined;
  connectEnd?: number | undefined;
  requestStart?: number | undefined;
  responseStart?: number | undefined;
  responseEnd?: number | undefined;
  responseStatus?: number | undefined;
  statusCode?: number | undefined;
  transferSize?: number | undefined;
  encodedBodySize?: number | undefined;
  decodedBodySize?: number | undefined;
  deliveryType?: string | undefined;
};

type BrowserResourceTimingTemplateContext = {
  entry: BrowserResourceTimingInput;
  initiatorType: string;
  path: string;
};

type BrowserResourcePathTemplate =
  | string
  | ((context: BrowserResourceTimingTemplateContext) => string | undefined);

type BrowserNavigationTimingInput = PerformanceNavigationTiming | {
  activationStart?: number | undefined;
  connectEnd?: number | undefined;
  connectStart?: number | undefined;
  decodedBodySize?: number | undefined;
  domComplete?: number | undefined;
  domContentLoadedEventEnd?: number | undefined;
  domContentLoadedEventStart?: number | undefined;
  domInteractive?: number | undefined;
  domainLookupEnd?: number | undefined;
  domainLookupStart?: number | undefined;
  duration?: number | undefined;
  encodedBodySize?: number | undefined;
  entryType?: string | undefined;
  fetchStart?: number | undefined;
  initiatorType?: string | undefined;
  loadEventEnd?: number | undefined;
  loadEventStart?: number | undefined;
  name?: string | undefined;
  navigationType?: string | undefined;
  redirectCount?: number | undefined;
  redirectEnd?: number | undefined;
  redirectStart?: number | undefined;
  requestStart?: number | undefined;
  responseEnd?: number | undefined;
  responseStart?: number | undefined;
  responseStatus?: number | undefined;
  secureConnectionStart?: number | undefined;
  startTime?: number | undefined;
  statusCode?: number | undefined;
  transferSize?: number | undefined;
  type?: string | undefined;
  workerStart?: number | undefined;
};

type BrowserNavigationTimingTemplateContext = {
  entry: BrowserNavigationTimingInput;
  navigationType: string;
  path: string;
};

type BrowserNavigationPathTemplate =
  | string
  | ((context: BrowserNavigationTimingTemplateContext) => string | undefined);

type BrowserWebVitalInput = {
  attribution?: Record<string, unknown> | undefined;
  delta?: number | undefined;
  entries?: unknown[] | undefined;
  id?: string | undefined;
  name: string;
  navigationType?: string | undefined;
  rating?: string | undefined;
  url?: string | undefined;
  value: number;
};

type BrowserWebVitalTemplateContext = {
  metric: BrowserWebVitalInput;
  metricName: string;
  name: string;
  path: string;
};

type BrowserWebVitalPathTemplate =
  | string
  | ((context: BrowserWebVitalTemplateContext) => string | undefined);

type BrowserInteractionTimingInput = PerformanceEntry | {
  attribution?: unknown;
  blockingDuration?: number | undefined;
  duration: number;
  entryType?: string | undefined;
  firstUIEventTimestamp?: number | undefined;
  interactionId?: number | undefined;
  name?: string | undefined;
  processingEnd?: number | undefined;
  processingStart?: number | undefined;
  renderStart?: number | undefined;
  scripts?: unknown;
  startTime?: number | undefined;
  styleAndLayoutStart?: number | undefined;
  target?: unknown;
};

type BrowserInteractionTimingTemplateContext = {
  entry: BrowserInteractionTimingInput;
  entryType?: string | undefined;
  name?: string | undefined;
  path: string;
};

type BrowserInteractionTimingPathTemplate =
  | string
  | ((context: BrowserInteractionTimingTemplateContext) => string | undefined);

type BrowserMetadataKind =
  | "page_view"
  | "action"
  | "network"
  | "document"
  | "resource"
  | "web_vital"
  | "interaction"
  | "fetch"
  | "xhr"
  | "error"
  | "unhandledrejection";

export type {
  BrowserActionInput,
  BrowserFetchInput,
  BrowserFetchPathTemplate,
  BrowserFetchTemplateContext,
  BrowserInteractionTimingInput,
  BrowserInteractionTimingPathTemplate,
  BrowserInteractionTimingTemplateContext,
  BrowserIssueSuppressedResult,
  BrowserIssueSuppressionMatcher,
  BrowserIssueSuppressionRule,
  BrowserIssueSuppressionSummary,
  BrowserMetadataKind,
  BrowserNavigationPathTemplate,
  BrowserNavigationTimingInput,
  BrowserNavigationTimingTemplateContext,
  BrowserNetworkInput,
  BrowserResourcePathTemplate,
  BrowserResourceTimingInput,
  BrowserResourceTimingTemplateContext,
  BrowserWebVitalInput,
  BrowserWebVitalPathTemplate,
  BrowserWebVitalTemplateContext,
  BrowserXhrInput,
  BrowserXhrPathTemplate,
  BrowserXhrTemplateContext,
  LogBrewBrowserEvent
};
