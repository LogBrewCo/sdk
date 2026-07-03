import {
  captureNextNavigation,
  createLogBrewNextBrowserClient,
  createNextRouteTemplate
} from "@logbrew/next/client";

const routePatterns = ["/projects/[projectId]/settings", "/docs/[[...slug]]"];
const routeTemplate = createNextRouteTemplate({
  pathname: "/projects/public-example-123/settings?debug=true#panel",
  routePatterns
});

const client = createLogBrewNextBrowserClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-next-client-route-example",
  sdkVersion: "0.1.0"
});

const event = captureNextNavigation(client, {
  pathname: "/projects/public-example-123/settings?debug=true#panel",
  routePatterns,
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanIdFactory: () => "b7ad6b7169203331",
  timestamp: "2026-06-02T10:00:09Z",
  durationMs: 19
});

if (!event || event.attributes.metadata.routeTemplate !== "/projects/[projectId]/settings") {
  throw new Error(`unexpected Next client route span: ${JSON.stringify(event)}`);
}

console.log(JSON.stringify({
  ok: true,
  pendingEvents: client.pendingEvents(),
  routeTemplate,
  spanName: event.attributes.name
}));
console.error(JSON.stringify({ ok: true, routeTemplate }));
