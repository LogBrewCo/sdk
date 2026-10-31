const { NULL_VALUE } = require("./null-value.cjs");
const { retryAfterMsOrUndefined } = require("./sdk-error.cjs");
const { requireNonEmpty } = require("./validation.cjs");

/**
 * @import { TransportResponse } from "./index.cjs"
 * @typedef {{ statusCode: number, retryAfterMs?: number, errorCode?: string }} ScriptedResponse
 * @typedef {ScriptedResponse | Error} ScriptedOutcome
 */

const ACCEPTED_STATUS_CODE = 202;
const SINGLE_ATTEMPT = 1;
const LAST_INDEX = -1;
const FIRST_INDEX = 0;
const SINGLE_RESPONSE = 1;

class RecordingTransport {
  /**
   * @param {readonly (Readonly<ScriptedResponse> | Readonly<Error>)[]} [scriptedResponses]
   */
  constructor(scriptedResponses = [{ statusCode: ACCEPTED_STATUS_CODE }]) {
    /** @type {ScriptedOutcome[]} */
    this.scriptedResponses = [...scriptedResponses];
    /** @type {string[]} */
    this.sentBodies = [];
  }

  /**
   * @returns {RecordingTransport}
   */
  static alwaysAccept() {
    return new RecordingTransport([{ statusCode: ACCEPTED_STATUS_CODE }]);
  }

  /**
   * @returns {string | null}
   */
  lastBody() {
    return this.sentBodies.at(LAST_INDEX) ?? NULL_VALUE;
  }

  /**
   * @param {unknown} apiKey
   * @param {string} body
   * @returns {Promise<TransportResponse>}
   */
  async send(apiKey, body) {
    requireNonEmpty("apiKey", apiKey);
    this.sentBodies.push(body);

    const [next = { statusCode: ACCEPTED_STATUS_CODE }] = this.scriptedResponses.splice(FIRST_INDEX, SINGLE_RESPONSE);

    if (next instanceof Error) {
      throw next;
    }

    const retryAfterMs = retryAfterMsOrUndefined(next.retryAfterMs);
    return {
      statusCode: next.statusCode,

      attempts: SINGLE_ATTEMPT,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(typeof next.errorCode === "string" ? { errorCode: next.errorCode } : {})
    };
  }
}

module.exports = { RecordingTransport };
