import fastify from "./index.cjs";

const {
  createErrorEvent,
  createLogBrewFastifyClient,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,
  logbrewFastifyPlugin,
  logbrewPlugin
} = fastify;
const defaultExport = fastify.default;

export {
  createErrorEvent,
  createLogBrewFastifyClient,
  createRequestEvent,
  createRequestMetricEvent,
  getActiveLogBrewTrace,
  logbrewFastifyPlugin,
  logbrewPlugin
};
export default defaultExport;
