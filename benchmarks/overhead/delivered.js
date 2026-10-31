import { readField, readList } from "./fields.js";

/** @import { Signal } from "./loop.js" */

const STEP_NAME = "checkout.step";
const EMPTY_COUNT = 0;
const ONE_ITEM = 1;
const ENVELOPE_PAIR = 2;

/**
 * @param {unknown} event
 * @param {Signal} signal
 * @returns {boolean}
 */
function countedLogBrewEvent(event, signal) {
  const type = readField(event, "type");
  return signal === "error" ? type === "issue" : type === "span" && readField(readField(event, "attributes"), "name") === STEP_NAME;
}

/**
 * @param {readonly string[]} bodies
 * @param {Signal} signal
 * @returns {number}
 */
function countLogBrewDelivered(bodies, signal) {
  let count = EMPTY_COUNT;
  for (const body of bodies) {
    /** @type {unknown} */
    const batch = JSON.parse(body);
    count += readList(readField(batch, "events")).filter((event) => countedLogBrewEvent(event, signal)).length;
  }
  return count;
}

/**
 * @param {unknown} header
 * @param {unknown} payload
 * @param {Signal} signal
 * @returns {number}
 */
function countEnvelopeItem(header, payload, signal) {
  const type = readField(header, "type");
  if (signal === "error") {
    return type === "event" ? ONE_ITEM : EMPTY_COUNT;
  }
  if (type === "span") {
    return readList(readField(payload, "items")).filter((span) => readField(span, "name") === STEP_NAME).length;
  }
  return type === "transaction" && readField(payload, "transaction") === STEP_NAME ? ONE_ITEM : EMPTY_COUNT;
}

/**
 * @param {readonly unknown[]} bodies
 * @param {Signal} signal
 * @returns {number}
 */
function countComparisonDelivered(bodies, signal) {
  let count = EMPTY_COUNT;
  for (const body of bodies) {
    const lines = String(body).split("\n");
    for (let index = ONE_ITEM; index < lines.length - ONE_ITEM; index += ENVELOPE_PAIR) {
      /** @type {unknown} */
      const header = JSON.parse(lines[index] ?? "");
      /** @type {unknown} */
      const payload = JSON.parse(lines[index + ONE_ITEM] ?? "");
      count += countEnvelopeItem(header, payload, signal);
    }
  }
  return count;
}

export { countComparisonDelivered, countLogBrewDelivered };
