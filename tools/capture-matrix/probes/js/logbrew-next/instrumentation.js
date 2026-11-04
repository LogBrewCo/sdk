import { createLogBrewNextRequestErrorHandler } from "@logbrew/next/instrumentation";

const endpoint = process.env.LOGBREW_CAPTURE_ENDPOINT;

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { createLogBrewNodeClient, installLogBrewPinoInstrumentation } = await import("@logbrew/node");
    installLogBrewPinoInstrumentation({ client: createLogBrewNodeClient({ serverApiKey: "LOGBREW_SERVER_API_KEY", endpoint }) });
  }
}

export const onRequestError = createLogBrewNextRequestErrorHandler({ serverApiKey: "LOGBREW_SERVER_API_KEY", endpoint });
