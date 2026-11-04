import pino from "pino";

export const logger = pino({ level: "info" });

export const routeOptions = (routeTemplate) => ({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  endpoint: process.env.LOGBREW_CAPTURE_ENDPOINT,
  captureErrors: false,
  captureRequestMetrics: true,
  routeTemplate
});
