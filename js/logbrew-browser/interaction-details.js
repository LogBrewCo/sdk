import {
  finiteNonNegativeNumber,
  nonNegativeNumberOrUndefined,
  roundDurationMs,
  roundedNumber,
  routeTemplatePath
} from "./browser-events.js";
import { isRecord, readField, stringOrUndefined } from "./values.js";
import { SdkError } from "@logbrew/sdk";

/**
 * @import {
 *   BrowserInteractionTimingInput,
 *   BrowserInteractionTimingObserverEntryType,
 *   BrowserInteractionTimingPathTemplate
 * } from "./index.js"
 * @typedef {{
 *   readonly durationMs: number,
 *   readonly entry: BrowserInteractionTimingInput,
 *   readonly interactionId: number
 * }} RankedInteraction
 * @typedef {{
 *   readonly blockingDurationMs?: number | undefined,
 *   readonly durationMs: number,
 *   readonly entryType: BrowserInteractionTimingObserverEntryType,
 *   readonly firstUIEventTimestampMs?: number | undefined,
 *   readonly inputDelayMs?: number | undefined,
 *   readonly interactionId?: number | undefined,
 *   readonly interactionPath: string,
 *   readonly interactionType?: string | undefined,
 *   readonly message: string,
 *   readonly name: string,
 *   readonly presentationDelayMs?: number | undefined,
 *   readonly processingDurationMs?: number | undefined,
 *   readonly renderStartMs?: number | undefined,
 *   readonly scriptCount?: number | undefined,
 *   readonly scriptMaxDurationMs?: number | undefined,
 *   readonly scriptTotalDurationMs?: number | undefined,
 *   readonly scriptTotalForcedStyleAndLayoutDurationMs?: number | undefined,
 *   readonly scriptTotalPauseDurationMs?: number | undefined,
 *   readonly startTimeMs: number | undefined,
 *   readonly styleAndLayoutStartMs?: number | undefined,
 *   readonly taskName?: string | undefined
 * }} InteractionTimingDetails
 * @typedef {{
 *   readonly interactionCount: number | undefined,
 *   readonly interactionPathTemplate: BrowserInteractionTimingPathTemplate | undefined,
 *   readonly maxDurationMs: number,
 *   readonly maxRankedInteractions: number,
 *   readonly path: string
 * }} InteractionToNextPaintSettings
 * @typedef {{
 *   readonly interactionPathTemplate: BrowserInteractionTimingPathTemplate | undefined,
 *   readonly maxDurationMs: unknown,
 *   readonly path: string
 * }} InteractionTimingSettings
 * @typedef {{
 *   readonly candidateRank: number,
 *   readonly durationMs: number,
 *   readonly entry: BrowserInteractionTimingInput,
 *   readonly inputDelayMs: number | undefined,
 *   readonly interactionId: number,
 *   readonly interactionPath: string,
 *   readonly interactionType: string,
 *   readonly maxInteractionDurationMs: number,
 *   readonly message: string,
 *   readonly name: string,
 *   readonly presentationDelayMs: number | undefined,
 *   readonly processingDurationMs: number | undefined,
 *   readonly rankedInteractionCount: number,
 *   readonly startTimeMs: number | undefined,
 *   readonly viewInteractionCount: number
 * }} InteractionToNextPaintDetails
 */

const INTERACTION_TYPE = /^[a-z][a-z0-9_.:-]{0,31}$/u;
const PRESS_EVENTS = new Set(["input", "keydown", "keypress", "keyup"]);
const TAP_EVENTS = new Set(["mousedown", "mouseup", "pointerdown", "pointerup", "touchend", "touchstart"]);
const INTERACTIONS_PER_CANDIDATE = 50;
const MIN_RANKED_INTERACTIONS = 1;
const NO_INTERACTION = 0;
const NO_SCRIPTS = 0;
const RANK_OFFSET = 1;
const FIRST = 0;
const NOT_FOUND = -1;
const NONE_REMOVED = 0;

/**
 * @param {unknown} value
 * @returns {value is readonly unknown[]}
 */
function isUnknownList(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} entryType
 * @returns {BrowserInteractionTimingObserverEntryType}
 */
function timingEntryType(entryType) {
  const normalized = stringOrUndefined(entryType);
  if (
    normalized === "event"
    || normalized === "first-input"
    || normalized === "long-animation-frame"
    || normalized === "longtask"
  ) {
    return normalized;
  }
  throw new SdkError(
    "configuration_error",
    "performance timing entryType must be event, first-input, long-animation-frame, or longtask"
  );
}

/**
 * @param {unknown} name
 * @returns {string}
 */
function normalizeInteractionType(name) {
  const normalized = stringOrUndefined(name)?.toLowerCase();
  if (normalized === undefined || !INTERACTION_TYPE.test(normalized)) {
    return "event";
  }
  return normalized;
}

/**
 * @param {unknown} name
 * @returns {string}
 */
function normalizeInpInteractionType(name) {
  const normalized = normalizeInteractionType(name);
  if (PRESS_EVENTS.has(normalized)) {
    return "press";
  }
  return TAP_EVENTS.has(normalized) ? "tap" : normalized;
}

/**
 * @param {unknown} maxDurationMs
 * @returns {number}
 */
function validMaxDurationMs(maxDurationMs) {
  return finiteNonNegativeNumber("maxDurationMs", maxDurationMs);
}

/**
 * @param {unknown} maxRankedInteractions
 * @returns {number}
 */
function validMaxRankedInteractions(maxRankedInteractions) {
  const value = finiteNonNegativeNumber("maxRankedInteractions", maxRankedInteractions);
  if (value < MIN_RANKED_INTERACTIONS) {
    throw new SdkError("configuration_error", "maxRankedInteractions must be at least 1");
  }
  return Math.floor(value);
}

/**
 * @param {unknown} start
 * @param {unknown} end
 * @returns {number | undefined}
 */
function durationBetween(start, end) {
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  const duration = end - start;
  return duration >= NO_INTERACTION ? roundDurationMs(duration) : undefined;
}

/**
 * @param {unknown} source
 * @param {string} key
 * @returns {number | undefined}
 */
function roundedField(source, key) {
  return roundedNumber(nonNegativeNumberOrUndefined(readField(source, key)));
}

/**
 * @param {BrowserInteractionTimingInput} entry
 * @param {BrowserInteractionTimingPathTemplate | undefined} interactionPathTemplate
 * @param {string} path
 * @returns {string}
 */
function templatePath(entry, interactionPathTemplate, path) {
  const currentPath = routeTemplatePath(path);
  if (typeof interactionPathTemplate === "function") {
    const entryType = stringOrUndefined(readField(entry, "entryType"));
    const name = stringOrUndefined(readField(entry, "name"));
    return routeTemplatePath(interactionPathTemplate({ entry, entryType, name, path: currentPath }));
  }
  if (typeof interactionPathTemplate === "string") {
    return routeTemplatePath(interactionPathTemplate);
  }
  return currentPath;
}

/**
 * @param {unknown} script
 * @param {string} propertyName
 * @returns {number | undefined}
 */
function scriptNumber(script, propertyName) {
  return nonNegativeNumberOrUndefined(readField(script, propertyName));
}

/**
 * @param {readonly unknown[]} scripts
 * @param {string} propertyName
 * @returns {number[]}
 */
function scriptNumbers(scripts, propertyName) {
  return scripts
    .map((script) => scriptNumber(script, propertyName))
    .filter((value) => value !== undefined);
}

/**
 * @param {readonly unknown[]} scripts
 * @param {string} propertyName
 * @returns {number | undefined}
 */
function sumScriptNumbers(scripts, propertyName) {
  const values = scriptNumbers(scripts, propertyName);
  const total = values.reduce((sum, value) => sum + value, NO_SCRIPTS);
  return values.length === NO_SCRIPTS ? undefined : roundDurationMs(total);
}

/**
 * @param {readonly unknown[]} scripts
 * @param {string} propertyName
 * @returns {number | undefined}
 */
function maxScriptNumber(scripts, propertyName) {
  const values = scriptNumbers(scripts, propertyName);
  const max = Math.max(...values);
  return values.length === NO_SCRIPTS ? undefined : roundDurationMs(max);
}

/**
 * @param {unknown} scripts
 * @returns {Partial<InteractionTimingDetails>}
 */
function longAnimationFrameScriptSummary(scripts) {
  if (!isUnknownList(scripts)) {
    return {
      scriptCount: NO_SCRIPTS
    };
  }
  const safeScripts = scripts.filter((script) => isRecord(script));
  return {
    scriptCount: safeScripts.length,
    scriptMaxDurationMs: maxScriptNumber(safeScripts, "duration"),
    scriptTotalDurationMs: sumScriptNumbers(safeScripts, "duration"),
    scriptTotalForcedStyleAndLayoutDurationMs: sumScriptNumbers(safeScripts, "forcedStyleAndLayoutDuration"),
    scriptTotalPauseDurationMs: sumScriptNumbers(safeScripts, "pauseDuration")
  };
}

/**
 * @param {BrowserInteractionTimingInput} entry
 * @returns {number | undefined}
 */
function presentationDelayMs(entry) {
  return durationBetween(
    readField(entry, "processingEnd"),
    Number(readField(entry, "startTime")) + Number(readField(entry, "duration"))
  );
}

/**
 * @param {BrowserInteractionTimingInput} entry
 * @param {number} durationMs
 * @param {string} interactionPath
 * @returns {InteractionTimingDetails}
 */
function eventTimingDetails(entry, durationMs, interactionPath) {
  const interactionType = normalizeInteractionType(readField(entry, "name"));
  return {
    durationMs,
    entryType: timingEntryType(readField(entry, "entryType")),
    inputDelayMs: durationBetween(readField(entry, "startTime"), readField(entry, "processingStart")),
    interactionId: nonNegativeNumberOrUndefined(readField(entry, "interactionId")),
    interactionPath,
    interactionType,
    message: `${interactionType} ${interactionPath}`,
    name: `browser.interaction ${interactionType} ${interactionPath}`,
    presentationDelayMs: presentationDelayMs(entry),
    processingDurationMs: durationBetween(readField(entry, "processingStart"), readField(entry, "processingEnd")),
    startTimeMs: roundedField(entry, "startTime")
  };
}

/**
 * @param {BrowserInteractionTimingInput} entry
 * @param {number} durationMs
 * @param {string} interactionPath
 * @returns {InteractionTimingDetails}
 */
function longAnimationFrameDetails(entry, durationMs, interactionPath) {
  const scripts = longAnimationFrameScriptSummary(readField(entry, "scripts"));
  return {
    blockingDurationMs: roundedField(entry, "blockingDuration"),
    durationMs,
    entryType: "long-animation-frame",
    firstUIEventTimestampMs: roundedField(entry, "firstUIEventTimestamp"),
    interactionPath,
    message: interactionPath,
    name: `browser.long_animation_frame ${interactionPath}`,
    renderStartMs: roundedField(entry, "renderStart"),
    scriptCount: scripts.scriptCount,
    scriptMaxDurationMs: scripts.scriptMaxDurationMs,
    scriptTotalDurationMs: scripts.scriptTotalDurationMs,
    scriptTotalForcedStyleAndLayoutDurationMs: scripts.scriptTotalForcedStyleAndLayoutDurationMs,
    scriptTotalPauseDurationMs: scripts.scriptTotalPauseDurationMs,
    startTimeMs: roundedField(entry, "startTime"),
    styleAndLayoutStartMs: roundedField(entry, "styleAndLayoutStart")
  };
}

/**
 * @param {BrowserInteractionTimingInput} entry
 * @param {InteractionTimingSettings} settings
 * @returns {InteractionTimingDetails}
 */
function interactionTimingDetails(entry, { interactionPathTemplate, maxDurationMs, path }) {
  const entryType = timingEntryType(readField(entry, "entryType"));
  const durationMs = roundDurationMs(finiteNonNegativeNumber("performance timing duration", readField(entry, "duration")));
  if (durationMs > validMaxDurationMs(maxDurationMs)) {
    throw new SdkError("configuration_error", "performance timing duration exceeds maxDurationMs");
  }
  const interactionPath = templatePath(entry, interactionPathTemplate, path);
  if (entryType === "event" || entryType === "first-input") {
    return eventTimingDetails(entry, durationMs, interactionPath);
  }
  if (entryType === "long-animation-frame") {
    return longAnimationFrameDetails(entry, durationMs, interactionPath);
  }
  return {
    durationMs,
    entryType,
    interactionPath,
    message: interactionPath,
    name: `browser.long_task ${interactionPath}`,
    startTimeMs: roundedField(entry, "startTime"),
    taskName: stringOrUndefined(readField(entry, "name"))
  };
}

/**
 * @param {unknown} value
 * @returns {value is BrowserInteractionTimingInput}
 */
function isTimingEntry(value) {
  return isRecord(value);
}

/**
 * @param {unknown} entry
 * @param {number} maxDurationMs
 * @returns {RankedInteraction | undefined}
 */
function rankableInteraction(entry, maxDurationMs) {
  if (!isTimingEntry(entry)) {
    return undefined;
  }
  const entryType = stringOrUndefined(readField(entry, "entryType"));
  const interactionId = nonNegativeNumberOrUndefined(readField(entry, "interactionId"));
  const durationMs = nonNegativeNumberOrUndefined(readField(entry, "duration"));
  if ((entryType !== "event" && entryType !== "first-input") || interactionId === undefined || interactionId === NO_INTERACTION) {
    return undefined;
  }
  return durationMs === undefined || durationMs > maxDurationMs ? undefined : { durationMs, entry, interactionId };
}

/**
 * @param {readonly RankedInteraction[]} interactions
 * @returns {RankedInteraction[]}
 */
function rankByDuration(interactions) {
  /** @type {RankedInteraction[]} */
  const ranked = [];
  for (const interaction of interactions) {
    const index = ranked.findIndex((other) => other.durationMs < interaction.durationMs);
    ranked.splice(index === NOT_FOUND ? ranked.length : index, NONE_REMOVED, interaction);
  }
  return ranked;
}

/**
 * @param {unknown} entries
 * @param {number} maxDurationMs
 * @param {number} maxRankedInteractions
 * @returns {RankedInteraction[]}
 */
function rankedInteractionEntries(entries, maxDurationMs, maxRankedInteractions) {
  if (!isUnknownList(entries)) {
    throw new SdkError("configuration_error", "createBrowserInteractionToNextPaintEvent requires an array of entries");
  }
  /** @type {Map<number, RankedInteraction>} */
  const byInteractionId = new Map();
  for (const candidate of entries.map((entry) => rankableInteraction(entry, maxDurationMs))) {
    const current = candidate === undefined ? undefined : byInteractionId.get(candidate.interactionId);
    if (candidate !== undefined && (current === undefined || candidate.durationMs > current.durationMs)) {
      byInteractionId.set(candidate.interactionId, { ...candidate, durationMs: roundDurationMs(candidate.durationMs) });
    }
  }
  return rankByDuration([...byInteractionId.values()]).slice(FIRST, maxRankedInteractions);
}

/**
 * @param {readonly RankedInteraction[]} rankedInteractions
 * @param {unknown} interactionCount
 * @returns {number}
 */
function viewInteractionCountFor(rankedInteractions, interactionCount) {
  return Math.max(
    rankedInteractions.length,
    interactionCount === undefined
      ? rankedInteractions.length
      : Math.floor(finiteNonNegativeNumber("interactionCount", interactionCount))
  );
}

/**
 * @param {unknown} entries
 * @param {InteractionToNextPaintSettings} settings
 * @returns {InteractionToNextPaintDetails}
 */
function interactionToNextPaintDetails(entries, settings) {
  const rankedInteractions = rankedInteractionEntries(
    entries,
    validMaxDurationMs(settings.maxDurationMs),
    validMaxRankedInteractions(settings.maxRankedInteractions)
  );
  const [slowest] = rankedInteractions;
  if (slowest === undefined) {
    throw new SdkError(
      "configuration_error",
      "createBrowserInteractionToNextPaintEvent requires at least one event or first-input entry with interactionId"
    );
  }
  const viewInteractionCount = viewInteractionCountFor(rankedInteractions, settings.interactionCount);
  const candidateIndex = Math.min(rankedInteractions.length - RANK_OFFSET, Math.floor(viewInteractionCount / INTERACTIONS_PER_CANDIDATE));
  const { durationMs, entry, interactionId } = rankedInteractions[candidateIndex] ?? slowest;
  const interactionPath = templatePath(entry, settings.interactionPathTemplate, settings.path);
  return {
    candidateRank: candidateIndex + RANK_OFFSET,
    durationMs,
    entry,
    inputDelayMs: durationBetween(readField(entry, "startTime"), readField(entry, "processingStart")),
    interactionId,
    interactionPath,
    interactionType: normalizeInpInteractionType(readField(entry, "name")),
    maxInteractionDurationMs: slowest.durationMs,
    message: interactionPath,
    name: `browser.interaction_to_next_paint ${interactionPath}`,
    presentationDelayMs: presentationDelayMs(entry),
    processingDurationMs: durationBetween(readField(entry, "processingStart"), readField(entry, "processingEnd")),
    rankedInteractionCount: rankedInteractions.length,
    startTimeMs: roundedField(entry, "startTime"),
    viewInteractionCount
  };
}

export { interactionTimingDetails, interactionToNextPaintDetails, timingEntryType };
