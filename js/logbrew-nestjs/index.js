import nestjs from "./index.cjs";

export const {
  createErrorEvent,
  createLogBrewNestClient,
  createLogBrewNestLogger,
  createRequestMetricEvent,
  createRequestEvent,
  getActiveLogBrewTrace,
  LogBrewInterceptor
} = nestjs;

export default nestjs.default;
