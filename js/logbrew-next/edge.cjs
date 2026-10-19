"use strict";

// Edge runtime request-error capture: Web APIs only, no Node.js imports.
const { LogBrewClient, SdkError } = require("@logbrew/sdk");
const {
  createNextRequestErrorEvent,
  nextDeploymentContext,
  readEnvApiKey,
  readEnvServerApiKey
} = require("./request-error-event.cjs");

const DEFAULT_ENDPOINT = "https://api.logbrew.co/v1/events";

function createLogBrewNextEdgeRequestErrorHandler(options = {}) {
  return async function logBrewNextEdgeRequestErrorHandler(error, request = {}, context = {}) {
    const authKey = options.serverApiKey ?? options.apiKey ?? readEnvServerApiKey() ?? readEnvApiKey();
    if (!authKey) {
      throw new SdkError(
        "configuration_error",
        "Edge request-error capture requires serverApiKey, apiKey, LOGBREW_SERVER_API_KEY, or LOGBREW_API_KEY"
      );
    }
    const deploymentContext = nextDeploymentContext(options.context);
    const client = LogBrewClient.create({
      apiKey: authKey,
      context: deploymentContext,
      sdkName: options.sdkName ?? "logbrew-next",
      sdkVersion: options.sdkVersion ?? "0.1.11",
      maxRetries: options.maxRetries ?? 2
    });
    const event = typeof options.errorEvent === "function"
      ? options.errorEvent(error, { error, request, context, client })
      : createNextRequestErrorEvent(error, request, context, options);
    client.issue(event.id, event.timestamp, event.attributes);
    const response = await client.shutdown(options.transport ?? createEdgeFetchTransport(options));
    if (typeof options.onFlush === "function") {
      await options.onFlush(response, { error, request, context, client });
    }
  };
}

function createEdgeFetchTransport({ endpoint = DEFAULT_ENDPOINT, headers = {}, fetchImpl = globalThis.fetch } = {}) {
  return {
    async send(apiKey, body) {
      const response = await fetchImpl(endpoint, {
        body,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...headers },
        method: "POST"
      });
      return { statusCode: response.status, attempts: 1 };
    }
  };
}

module.exports = { createLogBrewNextEdgeRequestErrorHandler };
