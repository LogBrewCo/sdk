import express from "./index.cjs";

export const {
  createErrorEvent,
  createLogBrewExpressClient,
  createRequestMetricEvent,
  createRequestEvent,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware,
  withLogBrewExpressHandler
} = express;

export default express;
