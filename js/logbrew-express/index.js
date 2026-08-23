import express from "./index.cjs";

export const {
  createErrorEvent,
  createLogBrewExpressClient,
  createRequestMetricEvent,
  createRequestEvent,
  getActiveLogBrewTrace,
  logbrewErrorHandler,
  logbrewMiddleware
} = express;

export default express;
