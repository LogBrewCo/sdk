import { RecordingTransport } from "@logbrew/sdk";
import { createLogBrewNextRequestErrorHandler } from "@logbrew/next/instrumentation";

const transport = RecordingTransport.alwaysAccept();
const onRequestError = createLogBrewNextRequestErrorHandler({
  serverApiKey: "LOGBREW_SERVER_API_KEY",
  transport,
  idFactory: () => "evt_next_request_error_example",
  now: () => "2026-08-01T10:00:00Z"
});

const error = Object.assign(new Error("checkout render failed"), {
  digest: "next_digest_example"
});
await onRequestError(
  error,
  {
    path: "/orders/example?debug=sample",
    method: "POST",
    headers: {}
  },
  {
    routerKind: "App Router",
    routePath: "/app/orders/[orderId]/page",
    routeType: "render",
    renderSource: "react-server-components",
    renderType: "dynamic"
  }
);

console.log(transport.lastBody());
console.error(JSON.stringify({ ok: true, attempts: transport.sentBodies.length }));
