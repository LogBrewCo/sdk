import type { BrowserFetchPathTemplate, BrowserInteractionTimingInput, BrowserInteractionTimingPathTemplate, BrowserNavigationPathTemplate, BrowserNavigationTimingInput, BrowserResourcePathTemplate, BrowserResourceTimingInput, BrowserWebVitalInput, BrowserWebVitalPathTemplate, BrowserXhrPathTemplate } from "./types-signals.js";
import type { BrowserInstrumentationOptions, LogBrewBrowserOptions } from "./types-options.js";
import type { TracePropagationTarget } from "./types-transport.js";

type BrowserNavigationInstrumentationOptions = LogBrewBrowserOptions & {
  captureInitial?: boolean | undefined;
};

type BrowserNavigationInstrumentation = {
  uninstall: () => void;
};

type BrowserResourceTimingObserver = {
  observe: (options: { buffered?: boolean; type: "resource" } | { entryTypes: string[] }) => void;
  disconnect: () => void;
};

type BrowserResourceTimingObserverConstructor = new (
  callback: (entryList: { getEntries: () => BrowserResourceTimingInput[] }) => void
) => BrowserResourceTimingObserver;

type BrowserResourceTimingOptions = LogBrewBrowserOptions & {
  buffered?: boolean | undefined;
  performanceObserver?: BrowserResourceTimingObserverConstructor | undefined;
  resourcePathTemplate?: BrowserResourcePathTemplate | undefined;
};

type BrowserResourceTimingInstrumentation = {
  uninstall: () => void;
};

type BrowserNavigationTimingOptions = BrowserInstrumentationOptions & {
  captureInitial?: boolean | undefined;
  deferAfterLoad?: boolean | undefined;
  entry?: BrowserNavigationTimingInput | undefined;
  navigationPathTemplate?: BrowserNavigationPathTemplate | undefined;
  setTimeout?: ((callback: () => void, delay?: number) => unknown) | undefined;
};

type BrowserNavigationTimingInstrumentation = {
  uninstall: () => void;
};

type BrowserWebVitalCallback = (metric: BrowserWebVitalInput) => void;

type BrowserWebVitalsModule = {
  onCLS?: ((callback: BrowserWebVitalCallback) => unknown) | undefined;
  onFCP?: ((callback: BrowserWebVitalCallback) => unknown) | undefined;
  onFID?: ((callback: BrowserWebVitalCallback) => unknown) | undefined;
  onINP?: ((callback: BrowserWebVitalCallback) => unknown) | undefined;
  onLCP?: ((callback: BrowserWebVitalCallback) => unknown) | undefined;
  onTTFB?: ((callback: BrowserWebVitalCallback) => unknown) | undefined;
};

type BrowserWebVitalsOptions = BrowserInstrumentationOptions & BrowserWebVitalsModule & {
  metricNames?: string[] | undefined;
  webVitalPathTemplate?: BrowserWebVitalPathTemplate | undefined;
  webVitals?: BrowserWebVitalsModule | undefined;
};

type BrowserWebVitalsInstrumentation = {
  uninstall: () => void;
};

type BrowserInteractionTimingObserverEntryType =
  | "event"
  | "first-input"
  | "long-animation-frame"
  | "longtask";

type BrowserInteractionTimingObserver = {
  observe: (
    options:
      | { buffered?: boolean; durationThreshold?: number; type: "event" | "first-input" }
      | { buffered?: boolean; type: "long-animation-frame" | "longtask" }
      | { entryTypes: string[] }
  ) => void;
  disconnect: () => void;
};

type BrowserInteractionTimingObserverConstructor = new (
  callback: (entryList: { getEntries: () => BrowserInteractionTimingInput[] }) => void
) => BrowserInteractionTimingObserver;

type BrowserInteractionTimingOptions = BrowserInstrumentationOptions & {
  buffered?: boolean | undefined;
  entryTypes?: BrowserInteractionTimingObserverEntryType[] | undefined;
  interactionDurationThresholdMs?: number | undefined;
  interactionPathTemplate?: BrowserInteractionTimingPathTemplate | undefined;
  maxDurationMs?: number | undefined;
  performanceObserver?: BrowserInteractionTimingObserverConstructor | undefined;
};

type BrowserInteractionToNextPaintOptions = BrowserInteractionTimingOptions & {
  interactionCount?: number | undefined;
  maxRankedInteractions?: number | undefined;
};

type BrowserInteractionTimingInstrumentation = {
  uninstall: () => void;
};

type BrowserFetchOptions = BrowserInstrumentationOptions & {
  captureTargets?: TracePropagationTarget[] | undefined;
  fetchImpl?: typeof fetch | undefined;
  nowMs?: (() => number) | undefined;
  resourcePathTemplate?: BrowserFetchPathTemplate | undefined;
  tracePropagationTargets?: TracePropagationTarget[] | undefined;
};

type BrowserFetchInstrumentation = {
  uninstall: () => void;
};

type BrowserXhrOptions = BrowserInstrumentationOptions & {
  captureTargets?: TracePropagationTarget[] | undefined;
  nowMs?: (() => number) | undefined;
  resourcePathTemplate?: BrowserXhrPathTemplate | undefined;
  tracePropagationTargets?: TracePropagationTarget[] | undefined;
  XMLHttpRequest?: (new () => XMLHttpRequest) | undefined;
};

type BrowserXhrInstrumentation = {
  uninstall: () => void;
};

export type {
  BrowserFetchInstrumentation,
  BrowserFetchOptions,
  BrowserInteractionTimingInstrumentation,
  BrowserInteractionTimingObserver,
  BrowserInteractionTimingObserverConstructor,
  BrowserInteractionTimingObserverEntryType,
  BrowserInteractionTimingOptions,
  BrowserInteractionToNextPaintOptions,
  BrowserNavigationInstrumentation,
  BrowserNavigationInstrumentationOptions,
  BrowserNavigationTimingInstrumentation,
  BrowserNavigationTimingOptions,
  BrowserResourceTimingInstrumentation,
  BrowserResourceTimingObserver,
  BrowserResourceTimingObserverConstructor,
  BrowserResourceTimingOptions,
  BrowserWebVitalCallback,
  BrowserWebVitalsInstrumentation,
  BrowserWebVitalsModule,
  BrowserWebVitalsOptions,
  BrowserXhrInstrumentation,
  BrowserXhrOptions
};
