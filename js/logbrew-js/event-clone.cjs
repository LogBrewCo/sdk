const { cloneIssueDiagnostics } = require("./issue-diagnostics.cjs");
const { cloneTelemetryContext } = require("./telemetry-context.cjs");
const { optionalEntry } = require("./validation.cjs");

/**
 * @import { NativeStackFrame } from "./index.cjs"
 * @import { EventAttributes, SdkEvent } from "./event-validation.cjs"
 * @import { DeepReadonly } from "./validation.cjs"
 */

/**
 * @template {Readonly<{ metadata?: Readonly<Record<string, unknown>> }>} Entry
 * @param {Entry} entry
 * @returns {Entry}
 */
function cloneWithMetadata(entry) {
  return entry.metadata === undefined ? { ...entry } : { ...entry, metadata: { ...entry.metadata } };
}

/**
 * @param {Readonly<NativeStackFrame>} frame
 * @returns {NativeStackFrame}
 */
function cloneNativeStackFrame(frame) {
  return { ...frame };
}

/**
 * @param {DeepReadonly<EventAttributes>} source
 * @returns {Partial<DeepReadonly<EventAttributes>>}
 */
function clonedCollections(source) {
  const { context, events, links, metadata, nativeStackFrames } = source;
  return {
    ...optionalEntry("nativeStackFrames", nativeStackFrames?.map((frame) => cloneNativeStackFrame(frame))),
    ...optionalEntry("metadata", metadata === undefined ? undefined : { ...metadata }),
    ...optionalEntry("events", events?.map((entry) => cloneWithMetadata(entry))),
    ...optionalEntry("links", links?.map((entry) => cloneWithMetadata(entry))),
    ...optionalEntry("context", context === undefined ? undefined : cloneTelemetryContext(context))
  };
}

/**
 * @param {DeepReadonly<SdkEvent>} event
 * @returns {DeepReadonly<SdkEvent>}
 */
function cloneEvent(event) {
  const source = event.attributes;
  return {
    ...event,
    attributes: { ...source, ...cloneIssueDiagnostics(source), ...clonedCollections(source) }
  };
}

module.exports = { cloneEvent };
