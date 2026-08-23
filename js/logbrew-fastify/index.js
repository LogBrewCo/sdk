import fastify from "./index.cjs";

export const {
  createErrorEvent,
  createLogBrewFastifyClient,
  createRequestMetricEvent,
  createRequestEvent,
  getActiveLogBrewTrace,
  logbrewFastifyPlugin,
  logbrewPlugin
} = fastify;

export default fastify.default;
